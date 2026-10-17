/**
 * The verdict: what the collective actually knows at the end of a mission, counted rather than described.
 *
 * Everything else in a dossier is either quoted from a file or written by a model. This block is neither:
 * it is arithmetic over the gate's own results, so it cannot be talked up. That matters because the one
 * failure mode this whole codebase is built against is a confident-sounding summary sitting on top of
 * evidence that does not support it — an audit of four generative search engines found only 51.5% of
 * generated sentences fully backed by their citations (Liu, Zhang & Liang,
 * https://arxiv.org/html/2304.09848v2). A mission's closing paragraph can read as certain while three
 * citations were deleted and one unit never reported, and the reader has no way to notice.
 *
 * So the grade is a function of counts only, and the downgrade rules are deliberately blunt:
 *   - no verified quote at all        -> NOTHING
 *   - fewer than two verified quotes, or more than half the units producing nothing -> THIN
 *   - a citation still wrong, a quote with thin support, or a unit that produced nothing -> at best PARTIAL
 *   - otherwise, with a closing pass -> STRONG
 * No model sees these numbers as a score to optimise. They are printed next to the evidence and next to
 * what was rejected, so the reader can check the arithmetic against the sections below.
 */
import type { Unit, WorkerReport } from "./roles.js";
import type { EditCheck } from "./edits.js";
import type { EditRepairRound } from "./editrepair.js";
import type { RepairRound } from "./repair.js";
import { normalise, type Verification } from "./verify.js";
import { handleFor } from "./personas.js";

export type Grade = "strong" | "partial" | "thin" | "nothing";

export interface VerdictInput {
  units: Unit[];
  reports: WorkerReport[];
  failed: { unit: string; error: string }[];
  /** The gate's answer for round one, before any repair was merged in. */
  roundOne: Verification;
  repair?: RepairRound;
  /** The gate's answer for the whole mission: round one plus whatever the repair pass re-cited. */
  merged: Verification;
  /** The edit gate's answer for the work the mission proposes to do, after any repair was merged in. */
  edits?: EditCheck;
  /** The one pass that handed unplaceable steps back to their own source, when it ran. */
  editRepair?: EditRepairRound;
  /** Sentences of the closing paragraph the mission's own record contradicted, before any repair. */
  conclusionFound?: number;
  /** The one pass that handed those sentences back to the leader, when it ran. */
  conclusionRepair?: { calls: number; rewritten: number; withdrawn: number; stillBroken: number };
  /** Sentences still contradicted by the record at the end. This is what keeps a run off STRONG. */
  conclusionStillStanding?: number;
  closingRan: boolean;
}

export interface VerdictTotals {
  verified: number;
  /** Distinct findings the gate rejected, across round one and the repair pass. */
  rejected: number;
  /** Every rejected attempt in the record, including the same finding failing twice. */
  rejectedAttempts: number;
  repaired: number;
  withdrawn: number;
  /** Citations that are still wrong at the end: unfixable in round one and not repaired since. */
  stillWrong: number;
  thin: number;
  units: number;
  /** Units that produced a usable report at all. */
  productive: number;
  /** Edits checked at all. */
  editsChecked: number;
  /** Edits that cannot be applied as described: no such file, anchor not found, lines past the end. */
  editsBroken: number;
  /** Edits whose anchor is real but whose line numbers are not. */
  editsStale: number;
  /** Edits anchored to nothing, so only their path was checked. */
  editsUnanchored: number;
  /** Edits that could not be placed and came back placed after one targeted repair. */
  editsRepaired: number;
  /** Edits their own author withdrew with a reason rather than guessing at a position again. */
  editsWithdrawnByAuthor: number;
  /** Sentences of the closing paragraph that contradicted this mission's own record. */
  conclusionsFound: number;
  /** Sentences the one repair pass rewrote without contradicting the record any more. */
  conclusionsRewritten: number;
  /** Sentences the leader gave up with a reason rather than restate something the record does not hold. */
  conclusionsWithdrawn: number;
  /** Sentences that still contradict the record at the end, counted after the repair pass. */
  conclusionsStanding: number;
  verifier: { unit: string; handle: string; reported: boolean; evidence: number } | null;
}

export interface Verdict {
  grade: Grade;
  totals: VerdictTotals;
  /** The rendered block, ready to drop into the dossier. */
  lines: string[];
  /** One line for a job status, so a poller sees the grade without reading the dossier. */
  headline: string;
}

export function missionVerdict(input: VerdictInput): Verdict {
  const units = input.units;
  const productive = units.filter((u) => input.reports.some((r) => r.unit === u.id)).length;
  // A finding the repair pass settled is not a wrong citation any more — whether it was re-cited correctly or
  // withdrawn by its own worker, which is the worker agreeing the code does not say it. What is left is the
  // only thing this number means: a citation that is still wrong at the end of the run.
  const settled = new Set([
    ...(input.repair?.verification.claims ?? []).filter((c) => c.status === "verified").map((c) => `${c.unit}|${normalise(c.claim)}`),
    ...(input.repair?.attempts ?? []).flatMap((a) => a.withdrawn.map((w) => `${a.unit}|${normalise(w.claim)}`)),
  ]);
  // Distinct findings, keyed by unit and claim: a failed repair that repeats the same finding is the same
  // problem twice, and counting it twice would make the mission look worse than it was.
  const unresolved = new Map<string, true>();
  for (const c of [...input.roundOne.rejected, ...(input.repair?.verification.rejected ?? [])]) {
    const k = `${c.unit}|${normalise(c.claim)}`;
    if (!settled.has(k)) unresolved.set(k, true);
  }
  const stillWrong = unresolved.size;
  const verifierUnit = units.find((u) => u.role === "verifier");
  const verifier = verifierUnit
    ? {
        unit: verifierUnit.id,
        handle: handleFor("verifier"),
        reported: input.reports.some((r) => r.unit === verifierUnit.id),
        evidence: input.merged.claims.filter((c) => c.unit === verifierUnit.id && c.status === "verified").length,
      }
    : null;

  const rejectedDistinct = new Set([...input.roundOne.rejected, ...(input.repair?.verification.rejected ?? [])].map((c) => `${c.unit}|${normalise(c.claim)}`)).size;

  const totals: VerdictTotals = {
    verified: input.merged.counts.verified,
    rejected: rejectedDistinct,
    rejectedAttempts: input.merged.rejected.length,
    repaired: input.repair?.repaired ?? 0,
    withdrawn: (input.repair?.attempts ?? []).reduce((n, a) => n + a.withdrawn.length, 0),
    stillWrong,
    thin: input.merged.thin.length,
    units: units.length,
    productive,
    editsChecked: input.edits?.edits.length ?? 0,
    editsBroken: input.edits?.broken ?? 0,
    editsStale: input.edits?.staleLines ?? 0,
    editsUnanchored: input.edits?.unanchored ?? 0,
    editsRepaired: input.editRepair?.fixed ?? 0,
    editsWithdrawnByAuthor: input.editRepair?.withdrawn ?? 0,
    conclusionsFound: input.conclusionFound ?? 0,
    conclusionsRewritten: input.conclusionRepair?.rewritten ?? 0,
    conclusionsWithdrawn: input.conclusionRepair?.withdrawn ?? 0,
    conclusionsStanding: input.conclusionStillStanding ?? 0,
    verifier,
  };

  // An edit whose anchor is missing is a defect of the same order as a citation whose quote is missing:
  // the run's own deliverable points somewhere that is not there. It stops a mission from grading STRONG,
  // and it is counted separately so the reader can see which of the two failed. Stale line numbers do not
  // downgrade on their own — the anchor is real — but they are named on their own line.
  //
  // A sentence of the closing paragraph that still contradicts this mission's own record is the same order
  // of defect again, one level up: the reader-facing summary states something the run itself deleted, or
  // names a file that does not exist. A rewritten sentence that no longer contradicts the record does not
  // hold the grade down; one that still does, does.
  const grade: Grade =
    totals.verified === 0
      ? "nothing"
      : totals.verified < 2 || productive * 2 <= units.length
        ? "thin"
        : totals.stillWrong === 0 && totals.thin === 0 && productive === units.length && totals.editsBroken === 0 && totals.conclusionsStanding === 0 && input.closingRan
          ? "strong"
          : "partial";

  const lines = [
    "## Verdict (counted from the gate's results, not written by a model)",
    `- Evidence: ${totals.verified} quote(s) re-read from the files and matched where they were cited${
      totals.repaired ? `, of which ${totals.repaired} came back in the repair pass after failing once` : ""
    }.`,
    `- Not evidence: ${totals.rejected} finding(s) the gate rejected${
      totals.rejectedAttempts > totals.rejected ? ` (${totals.rejectedAttempts} attempt(s) in the record below, counting the repair pass)` : ""
    }; ${totals.stillWrong} still wrong at the end, ${totals.withdrawn} withdrawn by their own worker with a reason rather than guessed at again.`,
    ...(totals.thin ? [`- Weak support: ${totals.thin} verified quote(s) share no wording with the claim they are attached to. They are listed separately below and were kept out of memory.`] : []),
    `- Coverage: ${totals.productive} of ${totals.units} unit(s) produced something usable.`,
    verifier
      ? `- Falsification: ${verifier.handle} (${verifier.unit}) ${verifier.reported ? `reported, with ${verifier.evidence} verified counter-observation(s)` : "produced nothing usable, so nothing in this run tried to destroy the plan"}.`
      : "- Falsification: the plan had no verifier unit, so nothing in this run tried to destroy it.",
    ...(totals.editsChecked
      ? [
          `- Proposed edits: ${totals.editsChecked} checked against the file as it is now — ${totals.editsBroken} cannot be applied as described (no such file, anchor not in the file, or a line range past the end)${totals.editsStale ? `, ${totals.editsStale} have a real anchor with stale line numbers` : ""}${totals.editsUnanchored ? `, ${totals.editsUnanchored} are anchored to nothing` : ""}.${totals.editsRepaired || totals.editsWithdrawnByAuthor ? ` One repair pass settled ${totals.editsRepaired} of them by re-placing the step and ${totals.editsWithdrawnByAuthor} by the author giving it up with a reason.` : ""}`,
        ]
      : []),
    `- Closing pass: ${input.closingRan ? "ran, over the verified findings only" : "did not run — the findings below are unmerged"}.`,
    ...(totals.conclusionsFound
      ? [
          `- Closing paragraph: ${totals.conclusionsFound} sentence(s) asserted something this mission's own record contradicts (a deleted finding restated, a claim its own author withdrew, a THIN SUPPORT quote stated as established, or a file that is not in this repository).${totals.conclusionsRewritten || totals.conclusionsWithdrawn ? ` One repair pass settled ${totals.conclusionsRewritten} of them by rewriting the sentence and ${totals.conclusionsWithdrawn} by the leader giving it up with a reason.` : ""}${totals.conclusionsStanding ? ` ${totals.conclusionsStanding} still stand, which is why this run is not graded STRONG.` : ""}`,
        ]
      : []),
    `- Grade: ${grade.toUpperCase()} — a count of what survived the gate, not a judgement of the answer.`,
    "",
    "This is arithmetic over citations, not an assessment: a verified quote proves the file says that and nothing more, an unfalsified plan is not a right one, and this run did not execute the project's own gates.",
  ];

  return {
    grade,
    totals,
    lines,
    headline: `verdict ${grade.toUpperCase()} (${totals.verified} verified, ${totals.rejected} rejected${totals.repaired ? `, ${totals.repaired} repaired` : ""}, ${totals.productive}/${totals.units} units usable${totals.editsBroken ? `, ${totals.editsBroken} edit(s) that cannot be applied as described` : ""}${totals.conclusionsStanding ? `, ${totals.conclusionsStanding} sentence(s) in the closing paragraph the record contradicts` : ""})`,
  };
}
