/**
 * The delegated-unit pipeline: what happens when the leader offers a unit to the local model.
 *
 * One idea, stated in the owner's own words: local output is untrusted by default. Nothing here merges
 * on a model's word or on a build's word alone. The order is fixed, the audit's own order:
 *
 *   1. deterministic checks — paths and present-file-safety, then syntax/typecheck, lint, the project's
 *      own tests, then every import the output uses must actually exist (a made-up import is a
 *      mechanical reject, checked from the files, no model);
 *   2. only if all of 1 passed, the council reviews the diff against the unit's own spec: one model call
 *      (the host's, no key), answering "matches the spec, no invented functions, no scope creep, no
 *      silent behaviour change";
 *   3. failure at any point reverts the write byte-for-byte from the snapshot taken before writing, and
 *      the concrete errors go to the local model ONCE; a second failure hands the unit to the council
 *      (the caller re-runs it as a normal worker), with the reason recorded.
 *
 * The prompt the local model gets is the owner's §3 verbatim in spirit: exact goal + definition of done,
 * pasted file contents (not references), constraints (no new dependencies, existing style, only APIs
 * shown), required output format (code only), and "say UNKNOWN instead of inventing".
 */
import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "../config.js";
import { run as runCmd } from "../util/exec.js";
import { generate, health, isSwitchedOff, isTimeout } from "./client.js";
const LOCAL_SYSTEM = `You write ONE code change. You return FULL FILES, not diffs.

Rules:
- Output only the JSON object described in the user message. No prose anywhere else.
- Write only the files the change requires, using the exact relative paths given.
- Use only the functions, imports and APIs you can see in the context you are given. Library APIs from
  memory are forbidden: if a helper is not visible in the context, you cannot use it.
- Keep the project's own style: match the indentation, quoting and naming you can see in the pasted files.
- If the context is not enough to do the change honestly, reply {"files":[],"unknown":"what is missing"}.
  Do not approximate. Do not invent a module, a function or an export. UNKNOWN is the correct answer.`;
/** The JSON contract, duplicated from the client's `format: "json"` guarantee: Ollama enforces shape; we enforce content. */
const ReplySchema = {
    parse(text) {
        try {
            const raw = JSON.parse(text);
            if (raw && typeof raw === "object" && "files" in raw) {
                const files = raw.files;
                if (!Array.isArray(files))
                    return { unknown: "files was not an array" };
                const clean = files
                    .filter((f) => {
                    const o = f;
                    return o && typeof o === "object" && typeof o.path === "string" && typeof o.content === "string" && o.path.length > 0;
                })
                    .slice(0, 12);
                const unknown = typeof raw.unknown === "string" ? raw.unknown : undefined;
                return { files: clean, unknown };
            }
            return { unknown: "the reply carried no files array" };
        }
        catch (e) {
            return { unknown: `the reply was not valid JSON (${e instanceof Error ? e.message : String(e)})` };
        }
    },
};
/** Resolve a path inside the project; anything outside is refused, not clamped. */
const resolveInProject = (rel) => {
    const root = projectDir();
    const abs = path.resolve(root, rel.replace(/^\.\//, ""));
    const rel2 = path.relative(root, abs);
    if (rel2.startsWith("..") || path.isAbsolute(rel2))
        return null;
    return abs;
};
/** Real file contents, pasted (never referenced), inside a token budget — that budget is a hard consequence of num_ctx. */
async function buildContext(unit, index, budgetTokens) {
    const root = projectDir();
    const budgetChars = budgetTokens * 4;
    const terms = [...unit.objective.split(/\W+/), ...unit.doneWhen].map((t) => t.toLowerCase()).filter((t) => t.length > 3);
    const scoped = [...new Set(unit.scope)].filter((f) => index.files.some((idx) => idx.path === f));
    const rest = index.files
        .filter((f) => !scoped.includes(f.path))
        .map((f) => ({ path: f.path, score: new Set(terms).size ? +[...terms].filter((t) => f.symbols.some((s) => s.name.toLowerCase().includes(t)) || f.path.toLowerCase().includes(t)).length : 0 }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);
    const chosen = [...scoped, ...rest.map((x) => x.path)];
    const parts = [];
    let chars = 0;
    for (const rel of chosen) {
        let text;
        try {
            text = await fs.readFile(path.resolve(root, rel), "utf8");
        }
        catch {
            continue; // A file the index names but the disk does not hold is not pasted partially — it is not pasted.
        }
        const block = `--- FILE ${rel} ---\n${text}`;
        if (chars + block.length > budgetChars * 0.92) {
            const head = text.split("\n").slice(0, Math.floor(((budgetChars - chars) / (budgetChars || 1)) * (text.length / 4)) + 60);
            parts.push(`--- FILE ${rel} (truncated to fit the context budget) ---\n${head.join("\n")}\n... (truncated)\n--- END ${rel} (partially shown) ---`);
            break;
        }
        parts.push(block);
        chars += block.length;
    }
    return parts.join("\n\n") || "(the server could not read any file for this unit — the honest local answer is UNKNOWN)";
}
/**
 * Read what the model means to change, and read it as data:
 * every import/export identifier it uses but the index has never seen is a mechanical reject —
 * a made-up import is not a style note, it is a failure of the rebuild.
 * Exported for the arithmetic gate: this is deterministic logic and it is asserted directly.
 */
export function checkImports(files, index, known) {
    const problems = [];
    for (const f of files) {
        for (const m of f.content.matchAll(/(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?["']([^"']+)["']/g)) {
            const spec = m[1];
            // Bare and scoped-specifier and node: imports are not files; tsconfig aliases are internal edges
            // the index resolves elsewhere. Both are skipped here — the check only judges relative paths.
            if (!spec.startsWith(".") && !spec.startsWith("/"))
                continue;
            const dir = path.posix.dirname(f.path.split("\\").join("/"));
            const base = path.posix.normalize(path.posix.join(dir, spec.split("\\").join("/")));
            // The ESM extension dance: a .js specifier in a TS repo resolves to the sibling .ts/.tsx.
            const candidates = [
                base,
                base.replace(/\.js$/, ".ts"),
                base.replace(/\.js$/, ".tsx"),
                base.replace(/\.jsx$/, ".tsx"),
                base.replace(/\.mjs$/, ".ts"),
                `${base}.ts`,
                `${base}.tsx`,
                `${base}.d.ts`,
                `${base}/index.ts`,
                `${base}/index.tsx`,
            ];
            const resolves = candidates.some((c) => index.files.some((idx) => idx.path === c));
            if (!resolves)
                problems.push(`${f.path}: imports "${spec}" — no file in this project resolves it`);
        }
        for (const m of f.content.matchAll(/import\s+\{([^}]+)\}/g)) {
            for (const rawName of m[1].split(",")) {
                const name = rawName.trim().replace(/\s+as\s+.*$/, "");
                if (!name || name.startsWith("type ") || name.startsWith("default"))
                    continue;
                if (!known.has(name) && !/^(node|fs|path|os|crypto|util|events|stream)$/.test(name)) {
                    problems.push(`${f.path}: imports the name "${name}", which no indexed file declares or uses`);
                }
            }
        }
    }
    return problems;
}
/** The audit ladder's deterministic half. Returns failure reasons, empty = pass. */
export async function auditDeterministic(files, unit, local, log) {
    const problems = [];
    const root = projectDir();
    for (const f of files) {
        const abs = resolveInProject(f.path);
        if (!abs)
            problems.push(`${f.path}: outside the project — refused, never clamped`);
    }
    if (problems.length)
        return problems;
    const timeoutMs = local.audit.timeoutSec * 1000;
    const cmd = async (label, command, okPattern) => {
        if (!command)
            return;
        const parts = command.split(/\s+/);
        const r = await runCmd(parts[0], parts.slice(1), root, timeoutMs);
        const ok = r.code === 0 && (!okPattern || okPattern.test(r.out));
        log(`  audit ${label}: exit ${r.code}${r.timedOut ? " (timeout)" : ""}, ${r.out.length} bytes of output`);
        if (!ok) {
            const tail = r.out.split("\n").filter(Boolean).slice(-12).join("\n");
            problems.push(`${label} failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}):\n${tail}`);
        }
    };
    if (local.audit.typecheckCmd)
        await cmd("typecheck", local.audit.typecheckCmd);
    if (local.audit.lintCmd)
        await cmd("lint", local.audit.lintCmd);
    if (!local.audit.skipExistingTests) {
        if (local.audit.testCmd)
            await cmd("tests", local.audit.testCmd);
    }
    return problems;
}
/**
 * One delegated unit: build the prompt, call the local model (the queue and timeout live inside
 * `generate`), apply, audit, revert, maybe retry once, and report. Nothing here is allowed to skip the
 * revert on the way out — every exit path either ends with the files kept or restored.
 */
export async function delegateUnit(unit, mission, index, knownNames, local, settings, log) {
    const t0 = Date.now();
    const context = await buildContext(unit, index, Math.max(1200, local.numCtx - 1200));
    const prompt = [
        `GOAL: ${unit.objective}`,
        `MISSION: ${mission}`,
        `DEFINITION OF DONE: ${unit.doneWhen.length ? unit.doneWhen.join("; ") : "the change compiles and the project's tests still pass"}`,
        `ANSWER (you must satisfy these): ${unit.mustAnswer.join(" | ")}`,
        "",
        "=== PROJECT CONTEXT (real files, pasted in full — the only APIs you may use are the ones visible here) ===",
        context,
        "=== END CONTEXT ===",
        "",
        "Reply with the full JSON object only:",
        '{"files":[{"path":"<relative path inside the project>","content":"<COMPLETE new file content>"}]}',
        "or, when the context does not let you do the change honestly:",
        '{"unknown":"what is missing"}',
        "No explanations. No markdown fences. Full file contents — never a diff, never a snippet.",
    ].join("\n");
    const attempt = async (feedback) => {
        const promptWithFeedback = feedback ? `${prompt}\n\n=== YOUR PREVIOUS ATTEMPT WAS REJECTED, FIX EXACTLY THIS ===\n${feedback}\n=== END REJECTION ===` : prompt;
        const started = Date.now();
        try {
            const res = await generate(settings, { prompt: promptWithFeedback, system: LOCAL_SYSTEM, timeoutMs: settings.timeoutMs }, log);
            const parsed = ReplySchema.parse(res.text);
            const files = (parsed.files ?? []).map((f) => ({ path: f.path, content: f.content, existed: false }));
            return { files, unknown: parsed.unknown, localMs: Date.now() - started, raw: res.text };
        }
        catch (e) {
            const fallbackable = isSwitchedOff(e) || isTimeout(e);
            const message = e instanceof Error ? e.message : String(e);
            return { files: [], unknown: fallbackable ? message : `the local model failed (${message})`, localMs: Date.now() - started, error: message };
        }
    };
    const internal = async () => {
        const detail = { outcome: "fallback", reason: "", files: [], audit: [], ms: 0, localMs: 0, outputs: [] };
        // --- Health check the moment the mode actually delegates something. ---
        const health = await checkHealth(settings, log);
        if (!health) {
            detail.reason = "Ollama is unreachable or the model is not pulled — the council keeps this unit";
            detail.outcome = "fallback";
            return detail;
        }
        // The FIRST attempt always runs; the retry only exists when the first attempt produced something audit-worthy.
        const attemptResult = await attempt();
        detail.localMs += attemptResult.localMs;
        detail.outputs.push(attemptResult.raw ?? attemptResult.unknown ?? "");
        detail.audit.push(...(attemptResult.unknown ? [`local reply: UNKNOWN — ${attemptResult.unknown.slice(0, 300)}`] : []));
        if (attemptResult.unknown && !attemptResult.files.length) {
            // UNKNOWN is the model refusing to guess, not a failure to retry: zero files is a valid, applied outcome.
            detail.outcome = "skipped-unknown";
            detail.reason = `the local model answered UNKNOWN instead of inventing context (${attemptResult.unknown.slice(0, 200)})`;
            detail.files = [];
            return detail;
        }
        if (!attemptResult.files.length) {
            detail.outcome = "fallback";
            detail.reason = `the local model produced no files: ${attemptResult.unknown ?? "empty files array"}`;
            return detail;
        }
        if (attemptResult.files.length > local.maxFilesPerUnit) {
            detail.audit.push(`capped: the unit tried to write ${attemptResult.files.length} files, the cap is ${local.maxFilesPerUnit} — rejected`);
            detail.outcome = "rejected-and-taken-over";
            detail.reason = "the local model tried to write more files than the cap allows";
            return detail;
        }
        // --- the apply-audit-revert cycle, at most twice (first attempt + one retry) ---
        const tryOnce = async (files, feedback) => {
            // Snapshot, write, audit, revert on failure.
            const scopeDirs = unit.scope.map((s) => path.dirname(path.resolve(projectDir(), s.replace(/^\.\//, ""))));
            const snapshots = [];
            for (const f of files) {
                const abs = resolveInProject(f.path);
                if (!abs)
                    return { ok: false, reason: `${f.path}: outside the project — refused` };
                // The unit may only touch what its share of the plan assigned: a scoped file, or a new file in a
                // directory that holds one. A well-scoped delegation can still reach one directory over.
                const dir = path.dirname(abs);
                if (!scopeDirs.some((d) => dir === d || dir.startsWith(`${d}${path.sep}`))) {
                    return { ok: false, reason: `${f.path}: outside the unit's own scope (${unit.scope.join(", ")}) — a delegated unit writes only what it was assigned` };
                }
                const before = await fs.readFile(abs, "utf8").catch(() => null);
                snapshots.push({ path: abs, existed: before !== null, before });
            }
            try {
                for (let i = 0; i < files.length; i++) {
                    const abs = resolveInProject(files[i].path);
                    await fs.mkdir(path.dirname(abs), { recursive: true });
                    await fs.writeFile(abs, files[i].content);
                    detail.files.push({ path: files[i].path, bytes: files[i].content.length, status: "written" });
                }
                // Deterministic audit first.
                let problems = await auditDeterministic(files, unit, local, log);
                if (!problems.length)
                    problems = checkImports(files, index, knownNames);
                if (!problems.length && !local.audit.skipExistingTests) {
                    // The council spec review — one host-model call at temperature 0.
                    problems = await specReview(unit, mission, files, feedback);
                }
                if (problems.length) {
                    await revert(snapshots, detail);
                    return { ok: false, feedback: problems.join("\n"), reason: `audit rejected the write: ${problems[0].slice(0, 300)}` };
                }
                for (const f of detail.files)
                    if (f.status === "written")
                        f.status = "kept";
                return { ok: true, reason: "the audit ladder passed: deterministic checks, import check, then the council spec review" };
            }
            catch (e) {
                await revert(snapshots, detail);
                return { ok: false, reason: `the audit threw: ${e instanceof Error ? e.message : String(e)} — the write was reverted` };
            }
        };
        const one = await tryOnce(attemptResult.files);
        if (one.ok) {
            detail.outcome = "applied";
            detail.reason = one.reason;
            return detail;
        }
        detail.reason = one.reason;
        // --- one retry with the concrete audit errors fed back ---
        const retry = await attempt(one.feedback);
        detail.localMs += retry.localMs;
        detail.outputs.push(retry.raw ?? retry.unknown ?? "");
        if (retry.error || (retry.unknown && !retry.files.length) || !retry.files.length) {
            detail.outcome = "rejected-and-taken-over";
            detail.reason = `the retry produced nothing auditable (${retry.unknown ?? retry.error ?? "empty"}); the council takes this unit over`;
            return detail;
        }
        if (retry.files.length > local.maxFilesPerUnit) {
            detail.outcome = "rejected-and-taken-over";
            detail.reason = "the retry also tried to write more files than the cap allows; the council takes this unit over";
            return detail;
        }
        const second = await tryOnce(retry.files, one.feedback);
        if (second.ok) {
            detail.outcome = "applied-with-retry";
            detail.reason = "the retry passed the audit ladder after the first attempt's concrete rejection was fed back";
            return detail;
        }
        detail.outcome = "rejected-and-taken-over";
        detail.reason = `the retry also failed the audit (${second.reason}); the council takes this unit over`;
        return detail;
    };
    const detail = await internal();
    detail.ms = Date.now() - t0;
    log(`  local delegation: ${detail.outcome} in ${detail.ms} ms — ${detail.reason}`);
    return detail;
}
/** Health check before any write. Returns false when the mode cannot safely run at all. */
async function checkHealth(settings, log) {
    const h = await health(settings, 8000);
    if (!h.ok) {
        log(`  local delegation: Ollama is unreachable (${h.detail ?? "no detail"}); the council keeps this unit`);
        return false;
    }
    if (h.modelMissing) {
        log(`  local delegation: the model "${settings.model}" is not pulled (${h.models.join(", ")} available); the council keeps this unit`);
        return false;
    }
    return true;
}
/** The council's spec review, one host-model call. Replaces a build system's word with a reading. */
async function specReview(unit, mission, files, priorFeedback) {
    const { askJson } = await import("../collective/ask.js");
    const { z } = await import("zod");
    const SpecSchema = z.object({ decision: z.enum(["pass", "fail"]), issues: z.array(z.string()).max(10).default([]) });
    const diff = files.map((f) => `--- ${f.path} (final content) ---\n${f.content}`).join("\n\n");
    const ask = await askJson({
        role: "worker",
        system: "You review code a small local model wrote. Be suspicious; the local model invents APIs when the context is vague. Answer pass ONLY if every required change is really there and nothing else moved: no invented functions or imports, no scope creep, no silent behaviour change. Mild style differences are not issues.",
        user: `MISSION: ${mission}\nUNIT OBJECTIVE: ${unit.objective}\nDONE WHEN: ${unit.doneWhen.join("; ") || "(not stated)"}\nMUST ANSWER:\n${unit.mustAnswer.map((q) => `- ${q}`).join("\n")}\n${priorFeedback ? `The FIRST attempt was rejected for:\n${priorFeedback}\n` : ""}\n=== THE WRITTEN CODE ===\n${diff}\n=== END ===\n\nReply JSON only: {"decision":"pass|fail","issues":["..."]}`,
        schema: SpecSchema,
        maxTokens: 900,
        attempts: 2,
        temperature: 0,
    });
    return ask.value.decision === "pass" ? [] : ask.value.issues.length ? ask.value.issues.map((i) => `council spec review: ${i}`) : ["council spec review: failed without naming an issue"];
}
/** Byte-perfect restore, recorded per file. */
async function revert(snapshots, detail) {
    for (const s of snapshots) {
        try {
            if (s.existed && s.before !== null)
                await fs.writeFile(s.path, s.before);
            else
                await fs.rm(s.path, { force: true });
            const tracked = detail.files.find((f) => `${s.path}`.endsWith(f.path) || s.path.endsWith(f.path));
            if (tracked)
                tracked.status = "reverted";
        }
        catch {
            // A failed revert is worse than a failed write: say so and do not pretend it was clean.
            detail.audit.push(`REVERT FAILED for ${s.path}: this file may hold partial local output — restore it from version control`);
        }
    }
}
