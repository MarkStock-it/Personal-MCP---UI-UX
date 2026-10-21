/**
 * The end-of-run gate: the reason an executor is allowed to exist here at all.
 *
 * Four steps, in this order, and any failure reverts:
 *   1. `verifyEdits` from the collective's edit gate — every written file must be a real file, and every line
 *      the run claims to have changed must really be at the line it claims. Reuse, not a second standard.
 *   2. One council diff review at temperature 0, on the host model (no key): does the diff do the task, with
 *      no invented APIs, no scope creep and no silent behaviour change. One reading, never proof.
 *   3. The project's own gates — typecheck and tests, auto-detected when the owner has not configured them,
 *      because "the tests pass" is not something a model's summary can stand in for.
 *   4. On failure: revert byte-for-byte and keep `proposed.patch`, so the work is readable rather than lost.
 *      A failed revert is `unsafe` and named — the loudest outcome, never smoothed over.
 *
 * The model's `summary` is never read as a verdict. It goes in the dossier as the run's account, next to the
 * checks that disagree with it when they do.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { verifyEdits } from "../collective/edits.js";
import { run as runCmd } from "../util/exec.js";
import { revert, writePatch, recordEvent } from "./journal.js";
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}\n… ${text.length - max} chars cut …`);
/** A readable diff for the reviewer: each write against its pre-image, capped so one huge file cannot eat the call. */
function renderWrites(writes, max = 24_000) {
    const parts = [];
    let used = 0;
    for (const w of writes) {
        const before = w.before ?? "(new file)";
        const block = `--- ${w.rel} BEFORE ---\n${clip(before, 6_000)}\n--- ${w.rel} AFTER ---\n${clip(w.after, 10_000)}\n`;
        if (used + block.length > max) {
            parts.push(`(${writes.length - parts.length} more file(s) not shown: the diff budget ran out)`);
            break;
        }
        parts.push(block);
        used += block.length;
    }
    return parts.join("\n");
}
const proposed = (writes) => writes.map((w, i) => {
    const raw = w.after.split("\n")[w.line - 1] ?? w.anchor;
    return {
        source: "agent",
        sourceIndex: i,
        path: w.rel,
        intent: `write ${w.rel}`,
        ...(raw.trim() ? { anchor: raw.trim() } : {}),
        lines: [w.line, w.line],
    };
});
/** Commands the gate runs. Auto-detection is explicit in the report, never silent. */
export async function gateCommands(root, cfg, local) {
    const out = [];
    if (cfg.gates.runTypecheck) {
        if (local.audit.typecheckCmd)
            out.push({ label: "typecheck", command: local.audit.typecheckCmd });
        else if (await fs.stat(path.join(root, "tsconfig.json")).then(() => true).catch(() => false)) {
            out.push({ label: "typecheck", command: "npx tsc --noEmit", note: "auto-detected from tsconfig.json (local.audit.typecheckCmd is unset)" });
        }
    }
    if (cfg.gates.runTests) {
        if (local.audit.testCmd)
            out.push({ label: "tests", command: local.audit.testCmd });
        else {
            let pkg = null;
            try {
                pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
            }
            catch {
                pkg = null;
            }
            if (pkg?.scripts?.test)
                out.push({ label: "tests", command: "npm test", note: "auto-detected from package.json scripts.test" });
        }
    }
    return out;
}
async function councilReview(input) {
    if (!input.cfg.gates.councilReview)
        return [];
    const diff = renderWrites(input.writes);
    if (!diff.trim())
        return [];
    try {
        const { askJson } = await import("../collective/ask.js");
        const { z } = await import("zod");
        const schema = z.object({ decision: z.enum(["pass", "fail"]), issues: z.array(z.string()).max(10).default([]) });
        const ask = await askJson({
            role: "worker",
            system: "You review a diff another model wrote while running with tools. Be suspicious; it invents APIs when the context is vague. Answer pass ONLY if the diff does the stated task and nothing else moved: no invented functions or imports, no scope creep, no silent behaviour change. Style differences are not issues.",
            user: `TASK: ${input.task}\nTHE RUN'S OWN ACCOUNT (do not trust it, verify against the diff): ${input.summary || "(none given)"}\n\n=== THE DIFF (before/after per file) ===\n${diff}\n=== END ===\n\nReply JSON only: {"decision":"pass|fail","issues":["..."]}`,
            schema,
            maxTokens: 900,
            attempts: 2,
            temperature: 0,
        });
        if (ask.value.decision === "pass")
            return [];
        return ask.value.issues.length
            ? ask.value.issues.map((i) => `council diff review: ${i}`)
            : ["council diff review: failed without naming an issue"];
    }
    catch (e) {
        return [
            `the council diff review could not run (${e instanceof Error ? e.message : String(e)}). ` +
                "Nothing is kept on an unreviewed diff: point agent.gates.councilReview at false only if you accept that.",
        ];
    }
}
/** A patch the owner can read or apply, including files the diff would miss because they are new. */
async function capturePatch(input) {
    const status = await runCmd("git", ["status", "--porcelain", "--", ...input.writes.map((w) => w.rel)], input.root, 30_000, { shell: false });
    const diff = await runCmd("git", ["diff", "--", ...input.writes.map((w) => w.rel)], input.root, 60_000, { shell: false });
    const untracked = [];
    for (const w of input.writes) {
        if (w.before !== null)
            continue;
        untracked.push(`--- NEW FILE ${w.rel} ---\n${w.after}\n`);
    }
    const body = [
        `# agent run: ${input.task}`,
        status.out.trim() ? `# git status\n${status.out.trim()}` : "",
        diff.out.trim() || "(no tracked-file changes in git's view)",
        ...untracked,
    ]
        .filter(Boolean)
        .join("\n\n");
    if (!body.trim())
        return undefined;
    return writePatch(input.journal, `${body}\n`);
}
/** A cheap, honest size estimate: mismatched lines plus the length delta. Not a diff library, and it says so. */
export function changeSize(before, after) {
    const a = (before ?? "").split("\n");
    const b = after.split("\n");
    let changed = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++)
        if (a[i] !== b[i])
            changed++;
    return changed;
}
/** The patch for a run whose work never landed in the owner's tree (worktree isolation). */
export async function exportPatch(input) {
    return capturePatch(input);
}
export async function gateRun(input) {
    const checks = [];
    const failures = [];
    // 0. Size limits, checked before anything else: a diff too big to review is too big to keep.
    const touched = input.writes.length;
    const lines = input.writes.reduce((n, w) => n + changeSize(w.before, w.after), 0);
    if (touched > input.cfg.maxDiffFiles)
        failures.push(`the run touched ${touched} files; agent.maxDiffFiles is ${input.cfg.maxDiffFiles}`);
    if (lines > input.cfg.maxDiffLines)
        failures.push(`the run changed about ${lines} lines; agent.maxDiffLines is ${input.cfg.maxDiffLines}`);
    // 1. The edit gate.
    if (!input.writes.length) {
        checks.push("no files were written, so there is nothing to keep and nothing to revert");
        return { outcome: "kept", checks };
    }
    if (failures.length) {
        const patchFile = await capturePatch(input);
        const report = await revert(input.journal);
        checks.push(`reverted: ${report.restored.length} restored, ${report.deleted.length} removed${report.failed.length ? `, ${report.failed.length} FAILED` : ""}`);
        if (report.failed.length) {
            checks.push(...report.failed.map((f) => `REVERT FAILED for ${f.path}: ${f.reason} — restore it from version control`));
            return { outcome: "unsafe", checks, ...(patchFile ? { patchFile } : {}), reverted: report };
        }
        return { outcome: "reverted", checks, ...(patchFile ? { patchFile } : {}), reverted: report };
    }
    const editCheck = await verifyEdits({ projectRoot: input.root, index: input.index, edits: proposed(input.writes) });
    checks.push(`edit gate: ${editCheck.edits.length} edit(s) checked — ${editCheck.counts.anchored} anchored, ${editCheck.unanchored} unanchored, ${editCheck.broken} broken`);
    for (const e of editCheck.edits) {
        if (e.status === "no-such-file" || e.status === "outside-project" || e.status === "anchor-not-found" || e.status === "lines-out-of-range") {
            failures.push(`edit gate: ${e.path} is ${e.status}${e.anchorAt ? ` (the anchor is at line ${e.anchorAt})` : ""}`);
        }
    }
    if (editCheck.broken)
        failures.push(`edit gate: ${editCheck.broken} edit(s) cannot be applied as described`);
    // 2. Council diff review.
    const review = await councilReview(input);
    checks.push(review.length ? `council diff review: ${review.length} issue(s)` : input.cfg.gates.councilReview ? "council diff review: pass" : "council diff review: disabled in config");
    failures.push(...review);
    // 3. The project's own gates.
    const commands = await gateCommands(input.root, input.cfg, input.local);
    if (!commands.length)
        checks.push("project gates: none could be detected or configured — this run was NOT covered by the project's own tests");
    for (const gate of commands) {
        const parts = gate.command.split(/\s+/);
        const t0 = Date.now();
        const res = await runCmd(parts[0], parts.slice(1), input.root, input.local.audit.timeoutSec * 1000, {});
        const tail = res.out.split("\n").filter(Boolean).slice(-12).join("\n");
        checks.push(`${gate.label}: ${gate.command} → exit ${res.code}${res.timedOut ? " (timeout)" : ""} in ${Date.now() - t0} ms${gate.note ? ` [${gate.note}]` : ""}`);
        if (res.code !== 0 || res.timedOut)
            failures.push(`${gate.label} failed (${gate.command}):\n${tail}`);
    }
    await recordEvent(input.journal, { event: "gate", checks, failures });
    if (!failures.length) {
        input.log("  gate: kept — edits anchored, review passed, project gates passed");
        return { outcome: "kept", checks };
    }
    // 4. Revert, and keep the work as a patch.
    const patchFile = await capturePatch(input);
    const report = await revert(input.journal);
    checks.push(`reverted: ${report.restored.length} restored, ${report.deleted.length} removed${report.failed.length ? `, ${report.failed.length} FAILED` : ""}`);
    for (const f of failures)
        input.log(`  gate refused: ${f.split("\n")[0]}`);
    if (report.failed.length) {
        checks.push(...report.failed.map((f) => `REVERT FAILED for ${f.path}: ${f.reason} — this file may hold partial agent output; restore it from version control`));
        return { outcome: "unsafe", checks, ...(patchFile ? { patchFile } : {}), reverted: report };
    }
    return { outcome: "reverted", checks, ...(patchFile ? { patchFile } : {}), reverted: report };
}
