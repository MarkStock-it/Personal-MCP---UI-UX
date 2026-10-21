/**
 * The run's memory, and the reason a failed run leaves nothing behind.
 *
 * Two rules, both load-bearing:
 *   - **Journal before the effect.** A line is appended (and the manifest written) BEFORE the write it
 *     describes, so a crash mid-write is recoverable rather than invisible.
 *   - **Pre-images are written by the server, not through the tool layer.** No tool can read `.design-mcp/`
 *     (see `sandbox.ts`), so a model cannot edit the evidence that is about to be used to revert it.
 *
 * The revert is byte-perfect by construction: the first bytes of every touched file are kept once, keyed by
 * sha256, and restoring means writing those bytes back; a file the run created is unlinked. A failed revert is
 * reported (`failed`), never smoothed over — same instinct as `src/ollama/delegate.ts`.
 *
 * The cap is deliberate: a run that would snapshot more than `snapshotCapBytes` is stopped before it writes,
 * with the size named. Silently skipping a pre-image would turn the revert into a guess.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface PreImage {
  rel: string;
  existed: boolean;
  /** sha256 (hex) of the bytes as they were; absent when the file did not exist. */
  sha?: string;
  bytes: number;
}

export interface CommandRecord {
  command: string;
  cwd: string;
  code: number | null;
  ms: number;
  timedOut: boolean;
  /** Tail of the combined output, already truncated by the caller. */
  output: string;
}

export interface RunnerJournal {
  dir: string;
  root: string;
  files: Map<string, PreImage>;
  commands: CommandRecord[];
  refusals: string[];
  snapshotBytes: number;
  snapshotCapBytes: number;
}

export interface RevertReport {
  restored: string[];
  deleted: string[];
  failed: { path: string; reason: string }[];
}

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * `root` is where the run wrote (the worktree, in worktree isolation) and is what a revert targets. `recordRoot`
 * is where the record lives — always the owner's real checkout, so a worktree run leaves its report, journal and
 * patch somewhere the owner will actually look, not inside a directory that gets removed.
 */
export async function createJournal(root: string, runId: string, capBytes = 20 * 1024 * 1024, recordRoot = root): Promise<RunnerJournal> {
  const dir = path.join(recordRoot, ".design-mcp", "agent", runId);
  await fs.mkdir(path.join(dir, "pre-images"), { recursive: true });
  const journal: RunnerJournal = {
    dir,
    root,
    files: new Map(),
    commands: [],
    refusals: [],
    snapshotBytes: 0,
    snapshotCapBytes: capBytes,
  };
  await writeManifest(journal);
  return journal;
}

/** One line, before the thing it describes. Writability is best-effort; the manifest is the record. */
export async function recordEvent(journal: RunnerJournal, event: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  try {
    await fs.appendFile(path.join(journal.dir, "journal.jsonl"), line);
  } catch {
    /* A journal that cannot be appended must not stop the run; the manifest still holds the pre-images. */
  }
}

export async function writeManifest(journal: RunnerJournal): Promise<void> {
  const manifest = {
    root: journal.root,
    files: [...journal.files.values()],
    commands: journal.commands,
    refusals: journal.refusals,
    snapshotBytes: journal.snapshotBytes,
  };
  try {
    await fs.writeFile(path.join(journal.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * Record the bytes of a file BEFORE the first write to it. Idempotent per path: the first capture is the one
 * that is restored, so a run that writes the same file five times still reverts to its pre-run state.
 */
export async function capture(journal: RunnerJournal, abs: string, rel: string): Promise<void> {
  if (journal.files.has(rel)) return;
  let before: Buffer | null = null;
  try {
    before = await fs.readFile(abs);
  } catch {
    before = null;
  }
  const bytes = before?.length ?? 0;
  if (journal.snapshotBytes + bytes > journal.snapshotCapBytes) {
    throw new Error(
      `the snapshot cap was reached (${Math.round(journal.snapshotCapBytes / 1024 / 1024)} MB, ${journal.snapshotBytes} bytes already): ` +
        `${rel} would push it over, so the run stops rather than writing without a way back`
    );
  }
  let sha: string | undefined;
  if (before) {
    sha = sha256(before);
    await fs.writeFile(path.join(journal.dir, "pre-images", sha), before);
    journal.snapshotBytes += bytes;
  }
  const entry: PreImage = { rel, existed: before !== null, ...(sha ? { sha } : {}), bytes };
  journal.files.set(rel, entry);
  await recordEvent(journal, { event: "capture", path: rel, existed: entry.existed, bytes, sha });
  await writeManifest(journal);
}

export async function recordCommand(journal: RunnerJournal, rec: CommandRecord): Promise<void> {
  journal.commands.push(rec);
  await recordEvent(journal, {
    event: "command",
    command: rec.command,
    cwd: rec.cwd,
    code: rec.code,
    ms: rec.ms,
    timedOut: rec.timedOut,
    output: rec.output.slice(-2000),
  });
  await writeManifest(journal);
}

export async function recordRefusal(journal: RunnerJournal, reason: string): Promise<void> {
  journal.refusals.push(reason);
  await recordEvent(journal, { event: "refusal", reason: reason.slice(0, 500) });
}

/** Byte-perfect restore. Files the run created are removed; everything else gets its first bytes back. */
export async function revert(journal: RunnerJournal): Promise<RevertReport> {
  const report: RevertReport = { restored: [], deleted: [], failed: [] };
  for (const entry of journal.files.values()) {
    const abs = path.join(journal.root, entry.rel);
    try {
      if (entry.existed && entry.sha) {
        const bytes = await fs.readFile(path.join(journal.dir, "pre-images", entry.sha));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, bytes);
        report.restored.push(entry.rel);
      } else {
        await fs.rm(abs, { force: true });
        report.deleted.push(entry.rel);
      }
    } catch (e) {
      report.failed.push({ path: entry.rel, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  await recordEvent(journal, { event: "revert", ...report });
  return report;
}

/** The patch a failed run leaves behind, so the work is readable rather than destroyed. */
export async function writePatch(journal: RunnerJournal, patch: string): Promise<string> {
  const file = path.join(journal.dir, "proposed.patch");
  await fs.writeFile(file, patch);
  return file;
}
