/**
 * `agent_run` — the orchestration, and the only entry point.
 *
 * Order matters and it is deliberate: refuse before doing anything (mode off, another run active, dirty tree,
 * model not pulled), then take the lock, build the index, journal, loop, gate, report. Every exit path releases
 * the lock and records the counters, because "is this earning its keep" needs a number under it even when the
 * run failed.
 *
 * This is the single exception to the "no command runner" rule, which is why it is config-gated and has no
 * runtime flip: `agent.enabled` is read from the file, and there is no tool argument that can set it. See
 * `AGENTS.md` (Hands) and `docs/agent-exec-plan.md`.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "../config.js";
import { getIndex } from "../codebase/store.js";
import { health } from "../ollama/client.js";
import { startJob } from "../jobs.js";
import { run as runCmd } from "../util/exec.js";
import { createJournal, recordEvent } from "./journal.js";
import { ollamaChat, runToolLoop } from "./loop.js";
import { gateRun } from "./gate.js";
import { renderReport } from "./report.js";
import { normalizeRel } from "./sandbox.js";
const emptyCounters = () => ({
    runs: 0,
    kept: 0,
    reverted: 0,
    unsafe: 0,
    failed: 0,
    rounds: 0,
    toolCalls: 0,
    commands: 0,
    refusals: 0,
    wallMs: 0,
    modelMs: 0,
});
const countersFile = (root) => path.join(stateDir(), "agent-state.json");
const lockFile = (root) => path.join(root, ".design-mcp", "agent", "lock.json");
export function readAgentCounters(root) {
    try {
        const raw = JSON.parse(fsSync.readFileSync(countersFile(root), "utf8"));
        return { ...emptyCounters(), ...raw };
    }
    catch {
        return emptyCounters();
    }
}
function bumpCounters(root, delta) {
    const prev = readAgentCounters(root);
    const next = { ...prev };
    for (const [k, v] of Object.entries(delta))
        next[k] = prev[k] + v;
    try {
        fsSync.mkdirSync(stateDir(), { recursive: true });
        fsSync.writeFileSync(countersFile(root), `${JSON.stringify(next, null, 2)}\n`);
    }
    catch {
        /* best effort, same as local-mode's counters */
    }
    return next;
}
const settingsFor = (cfg) => ({
    host: cfg.host.replace(/\/$/, ""),
    model: cfg.model,
    numCtx: cfg.numCtx,
    temperature: cfg.temperature,
    numThread: cfg.numThread,
    keepAliveM: cfg.keepAliveM,
    maxOutputTokens: cfg.maxOutputTokens,
    timeoutMs: cfg.timeoutSec * 1000,
    maxConcurrent: 1,
});
async function acquireLock(root, runId, maxWallClockSec) {
    const file = lockFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
        const raw = await fs.readFile(file, "utf8");
        const held = JSON.parse(raw);
        const ageMs = held.startedAt ? Date.now() - Date.parse(held.startedAt) : Number.POSITIVE_INFINITY;
        if (ageMs < maxWallClockSec * 2000) {
            return `another agent run is active in this project (${held.runId ?? "unknown"}, started ${Math.round(ageMs / 1000)}s ago${held.pid ? `, pid ${held.pid}` : ""}). One run at a time: wait for it to finish, or delete .design-mcp/agent/lock.json if you know it is dead.`;
        }
        await recordEvent({ dir: path.dirname(file), root, files: new Map(), commands: [], refusals: [], snapshotBytes: 0, snapshotCapBytes: 0 }, {
            event: "stale-lock",
            held,
        });
    }
    catch {
        /* no lock file, or an unreadable one: take it */
    }
    await fs.writeFile(file, `${JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
    return null;
}
async function releaseLock(root, runId) {
    const file = lockFile(root);
    try {
        const held = JSON.parse(await fs.readFile(file, "utf8"));
        if (held.runId && held.runId !== runId)
            return; // somebody else's lock: leave it alone
    }
    catch {
        return;
    }
    await fs.rm(file, { force: true });
}
const systemPrompt = (writeRoots, bashMode) => [
    "You are working inside one repository through a small set of tools. You cannot see anything you have not asked for, and you cannot touch anything outside the project.",
    "Work like a careful engineer: read a file before you change it, make the smallest change that does the task, and run the project's own checks before you finish.",
    "Every write is snapshotted, and an end-of-run gate re-checks your edits, reviews the diff and runs the project's tests. A change that fails is reverted, and a wrong whole-file rewrite throws the run away.",
    writeRoots.length
        ? `You may write only under: ${writeRoots.join(", ")}. Anything else is refused, and the refusal will tell you why.`
        : "This run is READ-ONLY: agent.writeRoots is empty, so every write is refused. Read, search and report; do not pretend to have changed a file.",
    bashMode === "off"
        ? "You cannot run commands in this run."
        : "Commands go through a policy: read the refusal message when one is refused rather than retrying it word for word.",
    "Do not claim a command passed unless you ran it and saw the exit code in its result.",
    "Finish by calling `finish` with a summary of what you changed and anything you could not do. Your summary is recorded as your account; the gate, not the summary, decides what is kept.",
].join("\n");
const taskPrompt = (task) => [`TASK: ${task}`, "", "Start by orienting yourself (list_files / search / read_context), then read the files you intend to change."].join("\n");
/** Refuses before anything runs, with the exact fix in the message. */
async function preflight(root, config, writeRoots) {
    const cfg = config.agent;
    if (!cfg.enabled) {
        throw new Error([
            "agent_run is OFF.",
            'It is config-file only on purpose: add "agent": { "enabled": true } to design-mcp.config.json in this project, name the directories it may write in "writeRoots", then restart the server or reload its config.',
            "There is no runtime flip and no tool argument that enables it — a model must never be one call away from giving itself a shell.",
        ].join("\n"));
    }
    for (const dir of writeRoots) {
        const n = normalizeRel(dir);
        if (!n.ok)
            throw new Error(`agent.writeRoots: ${n.reason}`);
    }
    // Refused rather than silently downgraded: a config value that ends up running in-place anyway would make the
    // report claim an isolation the run never had.
    if (cfg.isolation === "worktree") {
        throw new Error('agent.isolation is set to "worktree", which this build does not implement yet. Set it to "in-place" (the default): the snapshot and the end-of-run gate are what protect the tree, and the run says so in its report.');
    }
    const h = await health(settingsFor(cfg));
    if (!h.ok) {
        throw new Error(`Ollama is not reachable at ${cfg.host} (${h.detail ?? "no detail"}). Start it with \`ollama serve\` and pull the model (\`ollama pull ${cfg.model}\`).`);
    }
    if (h.modelMissing) {
        throw new Error(`The agent model "${cfg.model}" is not pulled. Available: ${h.models.join(", ") || "none"}.\nRun: ollama pull ${cfg.model}`);
    }
    const runId = `a-${Date.now().toString(36)}`;
    // Clean first, lock second: taking the lock writes .design-mcp/agent/lock.json, which would make the tree
    // dirty for the check that immediately follows. .design-mcp/ itself is this server's own state, so it is
    // excluded from the check either way — the owner is told to gitignore it, but a check that fails before the
    // first run because the server wrote its own index would be a bug, not a safeguard.
    if (cfg.requireClean) {
        const st = await runCmd("git", ["status", "--porcelain"], root, 30_000, { shell: false });
        const dirty = st.out
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .filter((l) => !l.includes(".design-mcp/"));
        if (st.code === 0 && dirty.length) {
            {
                const lines = dirty;
                throw new Error([
                    `The tree has uncommitted changes (${lines.length} path(s)), and agent.requireClean is true.`,
                    "A revert must never be able to eat work that was never ours. Commit or stash it, or set agent.requireClean to false if you accept that the snapshot only covers the files the run touches.",
                    ...lines.slice(0, 8).map((l) => `  ${l}`),
                ].join("\n"));
            }
        }
    }
    const lock = await acquireLock(root, runId, cfg.maxWallClockSec);
    if (lock)
        throw new Error(lock);
    try {
        const { index } = await getIndex(root, config.codebase);
        return { runId, index };
    }
    catch (e) {
        await releaseLock(root, runId);
        throw e;
    }
}
/**
 * Start one run as a job. Returns immediately; the host polls `design_status`. The textual answer is the first
 * thing the owner needs: what started, where the record will be, and how to follow it.
 */
export async function startAgentRun(root, config, input) {
    const cfg = input.dryRun ? { ...config.agent, writeRoots: [] } : { ...config.agent, writeRoots: input.writeRoots ?? config.agent.writeRoots };
    const task = input.task.trim();
    if (!task)
        throw new Error("agent_run needs a task: one or two sentences saying what to change or find out");
    const { runId, index } = await preflight(root, config, cfg.writeRoots);
    const outcomeRef = {};
    const job = startJob("agent", async (log) => {
        const t0 = Date.now();
        let journalDir = path.join(root, ".design-mcp", "agent", runId);
        const writes = [];
        let rounds = 0;
        let toolCalls = 0;
        let modelMs = 0;
        let stop = "not-started";
        let summary = "";
        let countersBumped = false;
        try {
            log(`agent run ${runId}: ${task}`);
            log(`model ${cfg.model} · writeRoots ${cfg.writeRoots.length ? cfg.writeRoots.join(", ") : "(none: read-only)"} · caps ${input.maxRounds ?? cfg.maxRounds} rounds / ${cfg.maxToolCalls} calls / ${cfg.maxWallClockSec}s`);
            const journal = await createJournal(root, runId);
            journalDir = journal.dir;
            await recordEvent(journal, { event: "start", task, model: cfg.model, writeRoots: cfg.writeRoots, dryRun: !!input.dryRun });
            const ctx = {
                sandbox: { root, writeRoots: cfg.writeRoots },
                journal,
                index,
                cfg,
                audit: config.local.audit,
                log,
                readPaths: new Set(),
                writes,
            };
            const loop = await runToolLoop({
                ctx,
                chat: ollamaChat(cfg),
                system: systemPrompt(cfg.writeRoots, cfg.bash.mode),
                task: taskPrompt(task),
                maxRounds: Math.min(input.maxRounds ?? cfg.maxRounds, 60),
                maxToolCalls: cfg.maxToolCalls,
                maxWallClockSec: cfg.maxWallClockSec,
                numCtx: cfg.numCtx,
                log,
            });
            rounds = loop.rounds;
            toolCalls = loop.toolCalls;
            modelMs = loop.modelMs;
            stop = loop.stop;
            summary = loop.summary;
            log(`  loop ended: ${stop} after ${rounds} round(s), ${toolCalls} tool call(s)`);
            const gate = await gateRun({ root, index, cfg, local: config.local, journal, writes, task, summary, log });
            outcomeRef.outcome = gate.outcome;
            const wallMs = Date.now() - t0;
            const report = renderReport({
                runId,
                task,
                model: cfg.model,
                outcome: gate.outcome,
                stop,
                checks: gate.checks,
                summary,
                writes: writes.map((w) => ({ rel: w.rel, bytes: Buffer.byteLength(w.after), created: w.before === null })),
                commands: journal.commands,
                refusals: journal.refusals,
                rounds,
                toolCalls,
                wallMs,
                modelMs,
                ...(gate.patchFile ? { patchFile: gate.patchFile } : {}),
                dir: journal.dir,
            });
            await fs.writeFile(path.join(journal.dir, "report.md"), `${report}\n`);
            await fs.writeFile(path.join(journal.dir, "result.json"), `${JSON.stringify({ runId, task, model: cfg.model, outcome: gate.outcome, stop, checks: gate.checks, writes: writes.map((w) => w.rel), rounds, toolCalls, wallMs, modelMs, summary, patch: gate.patchFile }, null, 2)}\n`);
            bumpCounters(root, {
                runs: 1,
                kept: gate.outcome === "kept" ? 1 : 0,
                reverted: gate.outcome === "reverted" ? 1 : 0,
                unsafe: gate.outcome === "unsafe" ? 1 : 0,
                rounds,
                toolCalls,
                commands: journal.commands.length,
                refusals: journal.refusals.length,
                wallMs,
                modelMs,
            });
            countersBumped = true;
            return report;
        }
        catch (e) {
            outcomeRef.outcome = "failed";
            if (!countersBumped) {
                bumpCounters(root, { runs: 1, failed: 1, rounds, toolCalls, wallMs: Date.now() - t0, modelMs });
            }
            const message = e instanceof Error ? e.message : String(e);
            log(`  run failed: ${message}`);
            return [`agent run ${runId} FAILED before the gate.`, message, "", `Record: ${journalDir}`].join("\n");
        }
        finally {
            await releaseLock(root, runId);
        }
    });
    const text = [
        `Agent run started (job ${job.id}), model ${cfg.model}.`,
        `Task: ${task}`,
        `Writes allowed under: ${cfg.writeRoots.length ? cfg.writeRoots.join(", ") : "nothing (read-only)"}`,
        `Caps: ${input.maxRounds ?? cfg.maxRounds} rounds · ${cfg.maxToolCalls} tool calls · ${cfg.maxWallClockSec}s.`,
        "It reads, searches, writes and runs commands itself, then the gate re-checks the edits, reviews the diff and runs the project's tests. Whatever fails is reverted and kept as proposed.patch.",
        `Follow it with design_status (job ${job.id}). Record: .design-mcp/agent/${runId}/`,
    ].join("\n");
    return { job, text };
}
