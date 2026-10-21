/**
 * What the owner reads when a run ends. The order is the order they need it in: what happened to the tree
 * first, then why, then the numbers. The model's own account is quoted at the end and labelled as its account,
 * never as a result.
 */
import type { CommandRecord } from "./journal.js";

export interface ReportInput {
  runId: string;
  task: string;
  model: string;
  outcome: "kept" | "reverted" | "unsafe" | "failed";
  stop: string;
  checks: string[];
  summary: string;
  writes: { rel: string; bytes: number; created: boolean }[];
  commands: CommandRecord[];
  refusals: string[];
  rounds: number;
  toolCalls: number;
  wallMs: number;
  modelMs: number;
  patchFile?: string;
  dir: string;
}

const secs = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function renderReport(r: ReportInput): string {
  const head =
    r.outcome === "kept"
      ? "KEPT — the edit gate, the council review and the project's gates all passed."
      : r.outcome === "reverted"
        ? "REVERTED — the run did not pass the gate, so the tree was restored byte-for-byte."
        : r.outcome === "unsafe"
          ? "UNSAFE — the gate refused the run AND the revert did not complete. Read the failed paths below; restore them from version control."
          : "FAILED — the run ended before the gate (see the reason).";

  const lines = [
    `agent run ${r.runId}: ${head}`,
    `task: ${r.task}`,
    `model: ${r.model} · stopped on: ${r.stop} · ${r.rounds} round(s), ${r.toolCalls} tool call(s) · ${secs(r.wallMs)} wall, ${secs(r.modelMs)} in model calls`,
    "",
    r.writes.length ? `Files (${r.writes.length}):` : "Files: none written",
    ...r.writes.map((w) => `  ${w.created ? "new " : "edit"} ${w.rel} (${w.bytes} bytes)`),
    ...(r.patchFile
      ? ["", `The work is kept as a patch: ${r.patchFile}`, `  read it: git apply --stat ${r.patchFile}   ·   apply it: git apply ${r.patchFile}`]
      : []),
    "",
    "Gate:",
    ...(r.checks.length ? r.checks.map((c) => `  - ${c}`) : ["  (the run never reached the gate)"]),
    "",
    `Commands (${r.commands.length}):`,
    ...(r.commands.length
      ? r.commands.slice(-12).map((c) => `  ${c.code === 0 ? "ok  " : `exit ${String(c.code)}`} ${c.command} — ${secs(c.ms)}${c.timedOut ? " (timed out)" : ""}`)
      : ["  none"]),
    "",
    r.refusals.length ? `Refused ${r.refusals.length} call(s) — the model was told why each time. Last ${Math.min(3, r.refusals.length)}:` : "Refused calls: none",
    ...r.refusals.slice(-3).map((x) => `  - ${x.slice(0, 240)}`),
    "",
    "The run's own account (its words, not a verdict):",
    r.summary.trim() ? r.summary.trim().split("\n").map((l) => `  ${l}`).join("\n") : "  (it gave none)",
    "",
    `Record: ${r.dir}`,
    "What this proves: the files it wrote are where it said, the project's own commands were run, and nothing outside those files changed in the tree. What it does not prove: that the change is the right design.",
  ];
  return lines.join("\n");
}
