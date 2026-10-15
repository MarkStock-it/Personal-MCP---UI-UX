/**
 * The mission loop.
 *
 *   leader   reads the digest (never the files) and cuts the mission into independent units
 *   workers  run in parallel, each on its own packed slice of real source, and may only claim what it quotes
 *   server   re-reads every quote and deletes what does not survive
 *   leader   closes the mission using the checked evidence only, and names what stays unverified
 *
 * One process, no shared memory between the copies, and the only facts that travel are ones the server
 * confirmed exist in the repository. The dossier is the artefact: short, cited, and explicit about the
 * difference between checked and assumed, which is what keeps the next reader honest.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { packContext, renderPack } from "../codebase/pack.js";
import { estimateTokens, getIndex, renderDigest } from "../codebase/store.js";
import { pLimit } from "../util/limit.js";
import { askJson } from "./ask.js";
import { LeaderPlanSchema, SynthesisSchema, WorkerReportSchema, leaderSystem, leaderUser, synthesisSystem, workerSystem, workerUser, } from "./roles.js";
import { admitFromMission, loadMemory, renderMemoryBlock } from "./memory.js";
import { renderConversation, runPeerRound } from "./peer.js";
import { handleFor } from "./personas.js";
import { discoverSkills, findSkill, readSkill } from "../skills/index.js";
import { verifyReports } from "./verify.js";
export const missionsDir = (root) => path.join(root, ".design-mcp", "collective");
export async function runMission(projectRoot, cfg, input, log) {
    const t0 = Date.now();
    const warnings = [];
    const id = `m-${Date.now().toString(36)}`;
    const loaded = await getIndex(projectRoot, cfg.codebase, {});
    const index = loaded.index;
    log(`${index.name}: ${index.totals.files} files indexed${loaded.cached ? " (cache verified, unchanged)" : ` in ${index.buildMs} ms`}`);
    const digest = renderDigest(index, { tokens: cfg.codebase.digestTokens, focus: input.focus ?? input.mission });
    const digestTokens = estimateTokens(digest);
    log(`digest: ~${digestTokens} tokens (budget ${cfg.codebase.digestTokens}) — this is all the leader sees of the repo`);
    const memory = cfg.collective.memory ? await loadMemory(projectRoot) : { items: [], stale: [], live: [] };
    const memoryBlock = cfg.collective.memory ? renderMemoryBlock(memory, { tokens: cfg.collective.memoryTokensInPrompt }) : "";
    if (memory.live.length || memory.stale.length) {
        log(`memory: ${memory.live.length} live entr${memory.live.length === 1 ? "y" : "ies"} in front of the collective${memory.stale.length ? `, ${memory.stale.length} retired as stale` : ""}`);
    }
    // The owner's skills. Only their names and one-line intents go to the leader; the text itself is read
    // later, and only for the units that were actually assigned one, so an unused skill costs nothing.
    const scan = cfg.skills.enabled ? await discoverSkills(projectRoot, cfg.skills) : { skills: [], roots: [], notes: [] };
    const offered = input.skills?.length
        ? scan.skills.filter((s) => input.skills.some((n) => s.name.toLowerCase() === n.toLowerCase()))
        : scan.skills;
    if (input.skills?.length) {
        const missing = input.skills.filter((n) => !offered.some((s) => s.name.toLowerCase() === n.toLowerCase()));
        if (missing.length)
            warnings.push(`skill(s) asked for but not found under the configured roots: ${missing.join(", ")}`);
    }
    const skillIndex = offered.length
        ? offered.slice(0, 40).map((s) => `- ${s.name} — ${s.description.replace(/\s+/g, " ").slice(0, 180)}`).join("\n")
        : "";
    if (offered.length)
        log(`skills: ${offered.length} of the owner's skills offered to the leader${scan.skills.length - offered.length ? ` (${scan.skills.length - offered.length} not shortlisted)` : ""}`);
    warnings.push(...scan.notes);
    const maxUnits = Math.min(cfg.collective.maxUnits, input.units ?? cfg.collective.maxUnits);
    const planAsk = await askJson({
        role: "leader",
        system: leaderSystem(maxUnits, skillIndex || undefined),
        user: leaderUser({ mission: input.mission, digest, focus: input.focus, paths: input.paths, maxUnits, memory: memoryBlock }),
        schema: LeaderPlanSchema,
        maxTokens: 2200,
        attempts: 2,
    });
    const plan = planAsk.value;
    log(`leader planned ${plan.units.length} unit(s) in ${planAsk.ms} ms: ${plan.units.map((u) => `${u.id}(${u.role})`).join(", ")}`);
    warnings.push(...planAsk.warnings.map((w) => `leader: ${w}`));
    const known = new Map(index.files.map((f) => [f.path, f]));
    const units = dedupeUnits(plan.units.slice(0, maxUnits).map((u) => {
        // The leader naming a file that does not exist is the cheapest hallucination to catch, so catch it here.
        const missing = u.scope.filter((p) => !known.has(p.replace(/^\.\//, "")));
        if (missing.length)
            warnings.push(`unit ${u.id} scoped files that do not exist and the scope was trimmed: ${missing.join(", ")}`);
        return { ...u, scope: u.scope.map((p) => p.replace(/^\.\//, "")).filter((p) => known.has(p)) };
    }));
    if (!units.some((u) => u.role === "verifier"))
        warnings.push("the leader did not include a verifier unit, so nothing is trying to falsify the plan");
    // Resolve the assigned skills before anything is dispatched: a skill whose file cannot be read is a
    // defect in the plan, and it is cheaper to say so here than to let a worker run under a false premise.
    const assigned = new Map();
    for (const u of units) {
        if (!u.skill)
            continue;
        const found = findSkill(offered, u.skill);
        if (!found) {
            warnings.push(`unit ${u.id} was assigned skill "${u.skill}", which is not under the configured roots, so the unit ran without it`);
            continue;
        }
        try {
            const text = await readSkill(found, cfg.skills.maxInPromptKB);
            assigned.set(u.id, { name: found.name, path: found.path, text, bytes: text.length });
            log(`  ${u.id}: following the owner's skill "${found.name}" (${Math.round(text.length / 1024)} KB read into its prompt)`);
        }
        catch (e) {
            warnings.push(`unit ${u.id} could not read the skill "${u.skill}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const workerCount = Math.min(cfg.collective.maxWorkers, input.workers ?? cfg.collective.maxWorkers, Math.max(1, units.length));
    const limit = pLimit(workerCount);
    let contextTokens = 0;
    const reports = [];
    const failed = [];
    log(`dispatching ${units.length} worker(s), ${workerCount} at a time, each on its own slice of source`);
    await Promise.all(units.map((unit) => limit(async () => {
        const query = [unit.objective, ...unit.mustAnswer].join(" ");
        const pack = await packContext(projectRoot, index, {
            query,
            paths: unit.scope,
            budget: cfg.collective.contextTokensPerWorker,
            symbols: [],
        });
        contextTokens += pack.tokens;
        log(`  ${unit.id}: ${pack.slices.length} file(s), ~${pack.tokens} tokens packed in ${pack.ms} ms`);
        try {
            const asked = await askJson({
                role: "worker",
                system: workerSystem(unit.role, assigned.get(unit.id)),
                user: workerUser(unit, renderPack(pack), memoryBlock),
                schema: WorkerReportSchema,
                maxTokens: 2600,
                attempts: 2,
            });
            const report = { ...asked.value, unit: unit.id };
            reports.push(report);
            if (report.verdict === "blocked")
                warnings.push(`unit ${unit.id} reported itself blocked`);
            warnings.push(...asked.warnings.map((w) => `unit ${unit.id}: ${w}`));
            if (!pack.slices.length)
                warnings.push(`unit ${unit.id} got an empty context pack: its answer can only be "unknown"`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failed.push({ unit: unit.id, error: message });
            log(`  ${unit.id}: FAILED (${message.split("\n").slice(0, 2).join(" ")})`);
            warnings.push(`unit ${unit.id} produced nothing usable: ${message.split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
        }
    })));
    const verification = await verifyReports({ projectRoot, units, reports });
    log(`verification: ${verification.counts.verified} verified, ${verification.rejected.length} rejected of ${verification.claims.length} claims (${verification.ms} ms, no model involved)`);
    if (verification.conflicts.length)
        for (const c of verification.conflicts)
            log(`  conflict: ${c}`);
    // Round two: the copies finally read each other. Only verified findings are exchanged, their replies go
    // through the same gate, and an unevidenced rebuttal is recorded as exactly that rather than as doubt.
    let conversation;
    if (cfg.collective.peerRound && reports.length >= 2) {
        log(`round two: ${reports.length} worker(s) read each other (verified findings only)`);
        conversation = await runPeerRound({ projectRoot, units, reports, verification, memoryBlock, concurrency: workerCount, log });
        if (conversation.unevidenced)
            log(`  ${conversation.unevidenced} rebuttal(s) came with no quote and stand as unproven`);
    }
    else if (cfg.collective.peerRound) {
        warnings.push("round two was skipped: it needs at least two workers to have reported");
    }
    let synthesis;
    let closingRan = false;
    if (cfg.collective.synthesize && reports.length) {
        const evidence = renderEvidence(units, reports, verification);
        const conversationText = conversation ? `\n\n=== THE CONVERSATION (round two) ===\n${renderConversation(conversation, units).join("\n")}` : "";
        try {
            const asked = await askJson({
                role: "leader",
                system: synthesisSystem(),
                user: `MISSION: ${input.mission}\n\nThe workers' checked evidence, and what was rejected:\n\n${evidence}${conversationText}`,
                schema: SynthesisSchema,
                maxTokens: 2200,
                attempts: 2,
            });
            synthesis = asked.value;
            closingRan = true;
            warnings.push(...asked.warnings.map((w) => `synthesis: ${w}`));
            log(`leader closed the mission in ${asked.ms} ms`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            warnings.push(`the closing pass failed: ${message.split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
            synthesis = fallbackSynthesis(plan, verification);
        }
    }
    else {
        synthesis = fallbackSynthesis(plan, verification);
    }
    // Memory is admitted on the way out, and quality-gated on purpose: a claim needs a quote the server
    // re-read and a mission that actually closed. Adding everything is a measured way to make the next
    // mission worse, so the rejected claims are kept too — as things not to say again.
    let admitted = [];
    let reinforced = 0;
    if (cfg.collective.memory) {
        const recorded = await admitFromMission({
            root: projectRoot,
            mission: input.mission,
            verification,
            closingRan,
            conflictPaths: verification.conflicts.map((c) => c.split(" ")[0]),
            cap: cfg.collective.memoryItems,
            perMission: 6,
        });
        admitted = recorded.added;
        reinforced = recorded.reinforced;
        if (recorded.added.length)
            log(`memory: recorded ${recorded.added.length} entr${recorded.added.length === 1 ? "y" : "ies"} for future missions`);
        else if (recorded.reinforced)
            log(`memory: nothing new, but ${recorded.reinforced} earlier entr${recorded.reinforced === 1 ? "y" : "ies"} confirmed again`);
        warnings.push(...recorded.skipped);
    }
    const stats = {
        workers: units.length,
        calls: reports.length + failed.length + 1 + (closingRan ? 1 : 0) + (conversation?.responses.length ?? 0),
        verified: verification.counts.verified,
        rejected: verification.rejected.length,
        contextTokens,
        digestTokens,
        cached: loaded.cached,
        closingRan,
        peerCalls: conversation?.responses.length ?? 0,
        ms: Date.now() - t0,
    };
    const memoryState = { added: admitted, reinforced, stale: memory.stale, live: memory.live.length };
    const skillsUsed = units.flatMap((u) => {
        const a = assigned.get(u.id);
        return a ? [{ name: a.name, unit: u.id, path: a.path, bytes: a.bytes }] : [];
    });
    const dossier = renderDossier({ id, input, index, plan, units, reports, failed, verification, synthesis, conversation, memory: memoryState, skills: skillsUsed, offered: offered.map((s) => s.name), stats, warnings });
    const dir = missionsDir(projectRoot);
    const file = path.join(dir, `${id}.md`);
    try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, dossier);
        await prune(dir, cfg.collective.keepDossiers);
    }
    catch {
        warnings.push("the dossier could not be written to .design-mcp/collective/ (read-only project?)");
    }
    return { id, file, dossier, plan, verification, synthesis, conversation, memory: memoryState, skills: skillsUsed, stats, warnings };
}
/** Unit ids must be unique and stable: the reports are matched back to the plan by id. */
function dedupeUnits(units) {
    const seen = new Map();
    return units.map((u) => {
        const n = seen.get(u.id) ?? 0;
        seen.set(u.id, n + 1);
        return n === 0 ? u : { ...u, id: `${u.id}-${n + 1}` };
    });
}
function renderEvidence(units, reports, v) {
    const blocks = [];
    for (const r of reports) {
        const unit = units.find((u) => u.id === r.unit);
        const mine = v.claims.filter((c) => c.unit === r.unit && c.status === "verified");
        blocks.push([
            `### unit ${r.unit} (${unit?.role ?? "?"}) — verdict ${r.verdict}`,
            `objective: ${unit?.objective ?? "(unknown)"}`,
            `mustAnswer: ${(unit?.mustAnswer ?? []).join(" | ")}`,
            `answer: ${r.answer}`,
            r.steps.length ? `proposed steps: ${r.steps.map((s) => `${s.path} (${s.risk}): ${s.intent}`).join("; ")}` : "",
            "verified findings (quote checked against the file by the server):",
            ...mine.map((c) => `  - ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""} — ${c.claim}\n      quote: ${c.quote.replace(/\s+/g, " ").slice(0, 300)}`),
            r.unknowns.length ? `unknowns: ${r.unknowns.join(" | ")}` : "",
            r.openQuestions.length ? `open questions: ${r.openQuestions.join(" | ")}` : "",
        ]
            .filter(Boolean)
            .join("\n"));
    }
    const rejected = v.rejected.length
        ? ["### rejected findings (these quotes were NOT found where they were cited — never re-introduce them as facts)", ...v.rejected.map((c) => `  - [${c.status}] ${c.unit} ${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 160)}${c.detail ? ` (${c.detail})` : ""}`)].join("\n")
        : "";
    const conflicts = v.conflicts.length ? ["### conflicts between units", ...v.conflicts.map((c) => `  - ${c}`)].join("\n") : "";
    return [...blocks, rejected, conflicts].filter(Boolean).join("\n\n");
}
/** When the closing pass fails or is switched off, the verified findings still reach the reader in order. */
function fallbackSynthesis(plan, v) {
    return {
        answer: [
            "No synthesis pass was run. The verified findings below are the collective's output.",
            ...v.units.map((u) => `- ${u.unit} (${u.role}, ${u.verified}/${u.total} verified): ${u.answer.replace(/\s+/g, " ").slice(0, 400)}`),
        ].join("\n"),
        plan: [],
        risks: plan.risks,
        unverified: v.rejected.map((c) => `${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 140)} (${c.status})`),
        firstAction: "Read the verified findings below and decide the first edit yourself.",
        definitionOfDone: ["The project's own gates pass (see the digest for its test and build commands)."],
    };
}
export function renderDossier(d) {
    const { index: idx, synthesis: s, plan, verification: v, stats } = d;
    const t = idx.conventions;
    return [
        `# Collective mission ${d.id}`,
        `${d.input.mission}`,
        "",
        `repo: ${idx.name} (${idx.totals.files} files, ${idx.totals.lines} lines) · ${d.units.length} unit(s) · ${stats.calls} model call(s) · ${stats.ms} ms`,
        `verified ${stats.verified}, rejected ${stats.rejected} · leader saw a ~${stats.digestTokens}-token digest, workers ~${stats.contextTokens} tokens of real source`,
        "",
        "## Restated in this repository's own terms",
        plan.restated,
        "",
        "## What the collective concluded",
        s.answer,
        "",
        `## First action\n${s.firstAction}`,
        ...(s.plan.length ? ["", "## Plan", ...s.plan.map((p, i) => `${i + 1}. ${p.step}${p.path ? ` — ${p.path}` : ""} (${p.risk} risk): ${p.intent}`)] : []),
        ...(s.definitionOfDone.length ? ["", "## Definition of done", ...s.definitionOfDone.map((x) => `- ${x}`)] : []),
        "",
        "## Evidence (every quote below was re-read from the file by the server)",
        ...v.units.map((u) => [
            `### ${handleFor(u.role)} (${u.unit}) — ${u.role}, ${u.verified}/${u.total} claims verified, verdict ${u.verdict}${d.skills.find((s) => s.unit === u.unit) ? `, followed the skill "${d.skills.find((s) => s.unit === u.unit).name}"` : ""}`,
            u.answer,
            ...v.claims.filter((c) => c.unit === u.unit && c.status === "verified").map((c) => `- ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : c.foundAt ? `:~${c.foundAt}` : ""}: ${c.claim}\n    \`${c.quote.replace(/\s+/g, " ").slice(0, 240)}\``),
        ].join("\n")),
        ...(v.rejected.length ? ["", "## Rejected: cited but not found in the file (never build on these)", ...v.rejected.map((c) => `- [${c.status}] ${c.unit} ${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 200)}${c.detail ? `\n    ${c.detail}` : ""}`)] : []),
        ...(v.conflicts.length ? ["", "## Conflicts", ...v.conflicts.map((c) => `- ${c}`)] : []),
        ...(d.conversation ? ["", "## The conversation (round two)", ...renderConversation(d.conversation, d.units)] : []),
        ...(d.conversation?.responses.some((r) => r.dissent.length)
            ? ["", "## They do not all agree (unproven dissent, kept for the owner)", ...d.conversation.responses.flatMap((r) => r.dissent.map((x) => `- ${r.unit}: ${x}`))]
            : []),
        "",
        ...(d.offered.length
            ? [
                "",
                "## Skills (the owner's own instructions, offered to the leader)",
                `- offered for assignment: ${d.offered.slice(0, 20).join(", ")}${d.offered.length > 20 ? ` (and ${d.offered.length - 20} more)` : ""}`,
                ...(d.skills.length
                    ? d.skills.map((s) => `- ${s.unit} followed **${s.name}** — ${Math.round(s.bytes / 1024)} KB of its text was in that worker's prompt (${s.path})`)
                    : ["- the leader assigned none of them, so no skill text reached any prompt."]),
                "- A skill is how to work, never what is true: it cannot be cited as a fact about this code, and nothing it says was checked against the source.",
            ]
            : []),
        "",
        "## Memory",
        `- ${d.memory.live} entr${d.memory.live === 1 ? "y" : "ies"} from earlier missions were given to this run as hints.`,
        ...(d.memory.added.length
            ? ["- recorded for future missions (each carries the quote the server re-read):", ...d.memory.added.map((m) => `    - [${m.kind}] ${m.path ?? ""}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}`)]
            : d.memory.reinforced
                ? [`- nothing new, but ${d.memory.reinforced} earlier entr${d.memory.reinforced === 1 ? "y" : "ies"} were confirmed again by this mission.`]
                : ["- nothing was solid enough to record."]),
        ...(d.memory.stale.length ? [`- ${d.memory.stale.length} earlier entr${d.memory.stale.length === 1 ? "y" : "ies"} retired: the code they quoted is gone or changed, so they were kept out of every prompt.`] : []),
        "- Memory is a hint list and never a citation. Nothing in it counts until someone quotes the file again.",
        ...(d.failed.length ? ["", "## Workers that produced nothing usable", ...d.failed.map((f) => `- ${f.unit}: ${f.error.split("\n")[0]}`)] : []),
        "",
        "## Unknowns the collective admitted",
        ...(plan.unknowns.length || d.reports.some((r) => r.unknowns.length || r.openQuestions.length)
            ? [
                ...plan.unknowns.map((x) => `- leader: ${x}`),
                ...d.reports.flatMap((r) => [...r.unknowns.map((x) => `- ${r.unit} (did not know): ${x}`), ...r.openQuestions.map((x) => `- ${r.unit} (asked): ${x}`)]),
            ]
            : ["- (none: nobody admitted an unknown, which is worth being suspicious about)"]),
        ...(s.unverified.length ? ["", "## Unverified (claimed, but not checkable from the source we read)", ...s.unverified.map((x) => `- ${x}`)] : []),
        "",
        "## Method and cost",
        stats.closingRan
            ? `- leader: one planning pass over a ${stats.digestTokens}-token digest computed from the files (no file contents), then one closing pass over the checked findings only.`
            : `- leader: one planning pass over a ${stats.digestTokens}-token digest, with no closing pass (it needs at least one usable worker report). The findings below are unmerged.`,
        `- workers: ${d.units.map((u) => `${handleFor(u.role)}(${u.id})`).join(", ")} — parallel, no shared context in round one.`,
        stats.peerCalls
            ? `- round two: the same copies read each other's verified findings (${stats.peerCalls} replies, quote-checked like everything else). Agreement between copies of one model is not independent evidence and is never counted as verification here.`
            : "- round two did not run, so no worker saw another's findings.",
        d.memory.live || d.memory.added.length
            ? `- memory: ${d.memory.live} live entr${d.memory.live === 1 ? "y" : "ies"} were in front of it at the start (hints, never citations); ${d.memory.added.length} recorded from this mission${d.memory.stale.length ? `; ${d.memory.stale.length} retired as stale` : ""}.`
            : "- memory: nothing recorded yet from this repository.",
        d.skills.length ? `- skills: ${d.skills.map((s) => `${s.name} → ${s.unit}`).join(", ")} (read from disk into that worker's prompt; not evidence).` : "- skills: none assigned by the leader.",
        `- verification: ${v.claims.length} quotes re-read from disk in ${v.ms} ms, ${v.counts.verified} matched at the cited lines, ${v.counts["found-elsewhere"]} matched elsewhere (line numbers wrong), ${v.counts["quote-not-found"]} not found.`,
        `- index: ${idx.totals.files} files, ${stats.cached ? "reused from cache" : `built in ${idx.buildMs} ms`}; ${idx.skipped.length} file(s) skipped.`,
        ...(d.warnings.length ? ["", "## Warnings raised while running", ...[...new Set(d.warnings)].map((w) => `- ${w}`)] : []),
        "",
        "## What this does NOT check",
        `- A verified quote proves the code says that. It does not prove the conclusion drawn from it is right.`,
        `- Nothing here ran the project's own gates. After implementing, run: ${[t.test ? `\`${t.test}\`` : null, t.build ? `\`${t.build}\`` : null, t.lint ? `\`${t.lint}\`` : null].filter(Boolean).join(", ") || "(this project declares no test, build or lint command — that is itself a finding)"}`,
        `- The index skipped ${idx.skipped.length} file(s) and extracts symbols with a lightweight parser, so a path can be missing from every context above without being missing from the repo.`,
    ]
        .filter((l) => l !== undefined)
        .join("\n");
}
async function prune(dir, keep) {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep)))
        await fs.rm(path.join(dir, f), { force: true });
}
export async function loadDossier(root, id) {
    const clean = id.replace(/[^a-z0-9-]/gi, "");
    const dir = missionsDir(root);
    const files = await fs.readdir(dir).catch(() => []);
    const hit = files.find((f) => f === `${clean}.md`) ?? files.filter((f) => f.startsWith(clean)).sort().at(-1);
    if (!hit) {
        const existing = files.map((f) => f.replace(/\.md$/, "")).join(", ");
        throw new Error(`No mission dossier "${id}" in .design-mcp/collective/${existing ? `. Existing: ${existing}` : " (none have been run in this project yet)"}`);
    }
    return fs.readFile(path.join(dir, hit), "utf8");
}
export async function listDossiers(root) {
    const dir = missionsDir(root);
    const files = await fs.readdir(dir).catch(() => []);
    const out = [];
    for (const f of files.filter((x) => x.endsWith(".md")).sort().reverse()) {
        const st = await fs.stat(path.join(dir, f)).catch(() => null);
        out.push({ id: f.replace(/\.md$/, ""), bytes: st?.size ?? 0 });
    }
    return out;
}
