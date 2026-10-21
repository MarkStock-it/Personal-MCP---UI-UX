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
import type { AgentConfig, Config } from "../config.js";
import { stateDir } from "../config.js";
import { getIndex } from "../codebase/store.js";
import { health } from "../ollama/client.js";
import { startJob, type Job } from "../jobs.js";
import { run as runCmd } from "../util/exec.js";
import { createJournal, recordEvent } from "./journal.js";
import { ollamaChat, runToolLoop } from "./loop.js";
import { exportPatch, gateRun } from "./gate.js";
import { renderReport } from "./report.js";
import { normalizeRel } from "./sandbox.js";
import type { ToolContext, WriteRecord } from "./tools.js";

export interface AgentRunInput {
  task: string;
  /** Overrides agent.writeRoots for this run. An empty array means read-only. */
  writeRoots?: string[];
  maxRounds?: number;
  /** Read-only by construction: same as writeRoots: []. */
  dryRun?: boolean;
}

export interface AgentCounters {
  runs: number;
  kept: number;
  reverted: number;
  unsafe: number;
  failed: number;
  rounds: number;
  toolCalls: number;
  commands: number;
  refusals: number;
  wallMs: number;
  modelMs: number;
}

const emptyCounters = (): AgentCounters => ({
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

const countersFile = (root: string): string => path.join(stateDir(), "agent-state.json");
const lockFile = (root: string): string => path.join(root, ".design-mcp", "agent", "lock.json");

export function readAgentCounters(root: string): AgentCounters {
  try {
    const raw = JSON.parse(fsSync.readFileSync(countersFile(root), "utf8")) as Partial<AgentCounters>;
    return { ...emptyCounters(), ...raw };
  } catch {
    return emptyCounters();
  }
}

function bumpCounters(root: string, delta: Partial<AgentCounters>): AgentCounters {
  const prev = readAgentCounters(root);
  const next = { ...prev };
  for (const [k, v] of Object.entries(delta) as [keyof AgentCounters, number][]) next[k] = prev[k] + v;
  try {
    fsSync.mkdirSync(stateDir(), { recursive: true });
    fsSync.writeFileSync(countersFile(root), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* best effort, same as local-mode's counters */
  }
  return next;
}

const settingsFor = (cfg: AgentConfig) => ({
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

async function acquireLock(root: string, runId: string, maxWallClockSec: number): Promise<string | null> {
  const file = lockFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const raw = await fs.readFile(file, "utf8");
    const held = JSON.parse(raw) as { runId?: string; startedAt?: string; pid?: number };
    const ageMs = held.startedAt ? Date.now() - Date.parse(held.startedAt) : Number.POSITIVE_INFINITY;
    if (ageMs < maxWallClockSec * 2000) {
      return `another agent run is active in this project (${held.runId ?? "unknown"}, started ${Math.round(ageMs / 1000)}s ago${
        held.pid ? `, pid ${held.pid}` : ""
      }). One run at a time: wait for it to finish, or delete .design-mcp/agent/lock.json if you know it is dead.`;
    }
    await recordEvent({ dir: path.dirname(file), root, files: new Map(), commands: [], refusals: [], snapshotBytes: 0, snapshotCapBytes: 0 }, {
      event: "stale-lock",
      held,
    });
  } catch {
    /* no lock file, or an unreadable one: take it */
  }
  await fs.writeFile(file, `${JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`);
  return null;
}

async function releaseLock(root: string, runId: string): Promise<void> {
  const file = lockFile(root);
  try {
    const held = JSON.parse(await fs.readFile(file, "utf8")) as { runId?: string };
    if (held.runId && held.runId !== runId) return; // somebody else's lock: leave it alone
  } catch {
    return;
  }
  await fs.rm(file, { force: true });
}

const systemPrompt = (writeRoots: string[], bashMode: string): string =>
  [
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

const taskPrompt = (task: string): string =>
  [`TASK: ${task}`, "", "Start by orienting yourself (list_files / search / read_context), then read the files you intend to change."].join("\n");

/** Refuses before anything runs, with the exact fix in the message. */
async function preflight(
  root: string,
  config: Config,
  writeRoots: string[]
): Promise<{ runId: string; index: Awaited<ReturnType<typeof getIndex>>["index"]; worktree?: string }> {
  const cfg = config.agent;
  if (!cfg.enabled) {
    throw new Error(
      [
        "agent_run is OFF.",
        'It is config-file only on purpose: add "agent": { "enabled": true } to design-mcp.config.json in this project, name the directories it may write in "writeRoots", then restart the server or reload its config.',
        "There is no runtime flip and no tool argument that enables it — a model must never be one call away from giving itself a shell.",
      ].join("\n")
    );
  }
  for (const dir of writeRoots) {
    const n = normalizeRel(dir);
    if (!n.ok) throw new Error(`agent.writeRoots: ${n.reason}`);
  }
  const h = await health(settingsFor(cfg));
  if (!h.ok) {
    throw new Error(
      `Ollama is not reachable at ${cfg.host} (${h.detail ?? "no detail"}). Start it with \`ollama serve\` and pull the model (\`ollama pull ${cfg.model}\`).`
    );
  }
  if (h.modelMissing) {
    throw new Error(
      `The agent model "${cfg.model}" is not pulled. Available: ${h.models.join(", ") || "none"}.\nRun: ollama pull ${cfg.model}`
    );
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
        throw new Error(
          [
            `The tree has uncommitted changes (${lines.length} path(s)), and agent.requireClean is true.`,
            "A revert must never be able to eat work that was never ours. Commit or stash it, or set agent.requireClean to false if you accept that the snapshot only covers the files the run touches.",
            ...lines.slice(0, 8).map((l) => `  ${l}`),
          ].join("\n")
        );
      }
    }
  }

  const lock = await acquireLock(root, runId, cfg.maxWallClockSec);
  if (lock) throw new Error(lock);
  try {
    const { index } = await getIndex(root, config.codebase);

    // Worktree isolation: the run gets its own checkout at HEAD and the owner's tree is never written to. The
    // patch is the deliverable, and the report says so — "kept" here means kept in the worktree, not applied.
    let worktree: string | undefined;
    if (cfg.isolation === "worktree") {
      const repo = await runCmd("git", ["rev-parse", "--is-inside-work-tree"], root, 15_000, { shell: false });
      if (repo.code !== 0 || !/true/.test(repo.out)) {
        throw new Error(
          'agent.isolation is "worktree", which needs a git repository with at least one commit. Use "in-place" for a directory that is not a repo, or commit once first.'
        );
      }
      worktree = path.join(root, ".design-mcp", "agent", runId, "tree");
      const add = await runCmd("git", ["worktree", "add", "--detach", worktree, "HEAD"], root, 120_000, { shell: false });
      if (add.code !== 0) {
        throw new Error(`could not create the worktree at ${worktree}: ${add.out.trim().split("\n").slice(-3).join(" ")}`);
      }
      // A worktree has no node_modules, so the project's own test command would fail for a reason that has
      // nothing to do with the change. Symlinked from the real checkout, read-only in practice, and said out
      // loud in the report.
      const hasLocal = await fs.stat(path.join(worktree, "node_modules")).then(() => true).catch(() => false);
      const hasSource = await fs.stat(path.join(root, "node_modules")).then(() => true).catch(() => false);
      if (!hasLocal && hasSource) await fs.symlink(path.join(root, "node_modules"), path.join(worktree, "node_modules"), "junction").catch(() => {});
    }

    return { runId, index, ...(worktree ? { worktree } : {}) };
  } catch (e) {
    await releaseLock(root, runId);
    throw e;
  }
}

/**
 * Start one run as a job. Returns immediately; the host polls `design_status`. The textual answer is the first
 * thing the owner needs: what started, where the record will be, and how to follow it.
 */
export async function startAgentRun(root: string, config: Config, input: AgentRunInput): Promise<{ job: Job; text: string }> {
  const cfg: AgentConfig = input.dryRun ? { ...config.agent, writeRoots: [] } : { ...config.agent, writeRoots: input.writeRoots ?? config.agent.writeRoots };
  const task = input.task.trim();
  if (!task) throw new Error("agent_run needs a task: one or two sentences saying what to change or find out");

  const { runId, index, worktree } = await preflight(root, config, cfg.writeRoots);
  const runRoot = worktree ?? root;
  const outcomeRef: { outcome?: "kept" | "reverted" | "unsafe" | "failed" } = {};

  const job = startJob("agent", async (log) => {
    const t0 = Date.now();
    let journalDir = path.join(root, ".design-mcp", "agent", runId);
    const writes: WriteRecord[] = [];
    let rounds = 0;
    let toolCalls = 0;
    let modelMs = 0;
    let stop = "not-started";
    let summary = "";
    let countersBumped = false;
    try {
      log(`agent run ${runId}: ${task}`);
      log(`model ${cfg.model} · writeRoots ${cfg.writeRoots.length ? cfg.writeRoots.join(", ") : "(none: read-only)"} · caps ${input.maxRounds ?? cfg.maxRounds} rounds / ${cfg.maxToolCalls} calls / ${cfg.maxWallClockSec}s`);

      if (worktree) log(`isolation: worktree — the run writes to ${worktree}; your checkout is not touched.`);
      const journal = await createJournal(runRoot, runId, 20 * 1024 * 1024, root);
      journalDir = journal.dir;
      await recordEvent(journal, { event: "start", task, model: cfg.model, writeRoots: cfg.writeRoots, dryRun: !!input.dryRun, isolation: cfg.isolation, ...(worktree ? { worktree } : {}) });

      const ctx: ToolContext = {
        sandbox: { root: runRoot, writeRoots: cfg.writeRoots },
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

      const gate = await gateRun({ root: runRoot, index, cfg, local: config.local, journal, writes, task, summary, log });
      outcomeRef.outcome = gate.outcome;

      // A worktree run has not touched the owner's tree, so the patch IS the deliverable. On a kept run the
      // patch is written here; on a refused one the gate already wrote it before restoring the worktree.
      let patchFile = gate.patchFile;
      if (worktree && gate.outcome === "kept" && writes.length) {
        patchFile = await exportPatch({ root: runRoot, index, cfg, local: config.local, journal, writes, task, summary, log });
      }
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
        isolation: cfg.isolation,
        ...(worktree ? { worktree } : {}),
        ...(patchFile ? { patchFile } : {}),
        dir: journal.dir,
      });

      await fs.writeFile(path.join(journal.dir, "report.md"), `${report}\n`);
      await fs.writeFile(
        path.join(journal.dir, "result.json"),
        `${JSON.stringify({ runId, task, model: cfg.model, outcome: gate.outcome, isolation: cfg.isolation, worktree, stop, checks: gate.checks, writes: writes.map((w) => w.rel), rounds, toolCalls, wallMs, modelMs, summary, patch: patchFile }, null, 2)}\n`
      );
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
    } catch (e) {
      outcomeRef.outcome = "failed";
      if (!countersBumped) {
        bumpCounters(root, { runs: 1, failed: 1, rounds, toolCalls, wallMs: Date.now() - t0, modelMs });
      }
      const message = e instanceof Error ? e.message : String(e);
      log(`  run failed: ${message}`);
      return [`agent run ${runId} FAILED before the gate.`, message, "", `Record: ${journalDir}`].join("\n");
    } finally {
      // A worktree is a scratch checkout: remove it once the record and the patch are written. A kept worktree
      // run still hands the patch over, so nothing is lost by removing the directory it was produced in.
      if (worktree) {
        const rm = await runCmd("git", ["worktree", "remove", "--force", worktree], root, 60_000, { shell: false });
        if (rm.code !== 0) log(`  note: could not remove the worktree at ${worktree}; remove it with \`git worktree remove --force\``);
        await runCmd("git", ["worktree", "prune"], root, 30_000, { shell: false });
      }
      await releaseLock(root, runId);
    }
  });

  const text = [
    `Agent run started (job ${job.id}), model ${cfg.model}.`,
    `Task: ${task}`,
    `Writes allowed under: ${cfg.writeRoots.length ? cfg.writeRoots.join(", ") : "nothing (read-only)"}`,
    `Caps: ${input.maxRounds ?? cfg.maxRounds} rounds · ${cfg.maxToolCalls} tool calls · ${cfg.maxWallClockSec}s.`,
    "It reads, searches, writes and runs commands itself, then the gate re-checks the edits, reviews the diff and runs the project's tests. Whatever fails is reverted and kept as proposed.patch.",
    ...(worktree
      ? [
          `Isolation: worktree — it works in its own checkout at ${worktree}, so your tree is not written to.`,
          `A passing run hands you a patch: ${path.join(root, ".design-mcp", "agent", runId, "proposed.patch")}`,
        ]
      : []),
    `Follow it with design_status (job ${job.id}). Record: .design-mcp/agent/${runId}/`,
  ].join("\n");
  return { job, text };
}
