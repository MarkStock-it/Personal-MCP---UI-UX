/**
 * The conclusion repair pass — one second chance for a sentence the record contradicts.
 *
 * This is the third and last place the same pattern is applied, and for the same reason it pays in the
 * other two: a sentence that cannot stand is not worth deleting silently when the server already knows
 * exactly why it cannot stand. The citation repair hands a rejected finding back to its own unit with the
 * lines it cited and the line the quote really lives at; the edit repair hands an unplaceable step back to
 * the unit that proposed it with the anchor it gave and what the file actually contains. This one hands the
 * closing paragraph back to the leader that wrote it, sentence by sentence, with the record's own words:
 * which finding the mission deleted, what its own author said when withdrawing it, or that the file it
 * named is not in this repository.
 *
 * The evidence for one pass and not a loop is the same as the other two, and so is the shape: restating a
 * claim without care is not fixed by trying again (Huang et al., "Large Language Models Cannot Self-Correct
 * Reasoning Yet", https://arxiv.org/html/2310.01798v2), a single targeted repair after a deterministic
 * rejection does measurably beat resampling while repeated repair does not (Olausson et al.,
 * https://arxiv.org/abs/2306.09896), and correction rounds also break answers that were right — which is
 * why a repair can only answer the numbered sentences it was handed, and nothing else in the conclusion is
 * touched.
 *
 * Two outcomes are honest and both are recorded: rewrite the sentence so it says only what the record
 * supports, or give it up with a reason. A sentence that is given up is removed from the conclusion and
 * named in the pass record — a missing sentence is worse for the reader than a good one, but better than
 * one the mission itself contradicts, and never silent.
 */
import type { RepoIndex } from "../codebase/store.js";
import { askJson } from "./ask.js";
import { applyConclusionFixes, checkConclusion, type ConclusionFix, type ConclusionIssue } from "./conclusion.js";
import { ConclusionRepairSchema, conclusionRepairSystem, conclusionRepairUser } from "./roles.js";
import type { Synthesis } from "./roles.js";
import type { Verification } from "./verify.js";

/** How many files the leader is shown, so "a file that is not in it" is a rule it can actually obey. */
const MAX_FILE_LIST = 400;

export interface ConclusionRepairAttempt {
  sent: number;
  rewritten: number;
  withdrawn: { text: string; why: string }[];
  unaddressed: number;
  stillBroken: number;
  note: string;
  error?: string;
  ms: number;
}

export interface ConclusionRepairRound {
  attempt: ConclusionRepairAttempt;
  /** The conclusion as it stands after the pass: what the dossier shows as the mission's answer. */
  synthesis: Synthesis;
  /** The sentences that were handed back. */
  issues: ConclusionIssue[];
  /** What still contradicts the record after the pass. These are what the verdict counts. */
  remaining: ConclusionIssue[];
  calls: number;
  rewritten: number;
  withdrawn: number;
  ms: number;
}

export interface ConclusionRepairInput {
  projectRoot: string;
  index: RepoIndex;
  mission: string;
  synthesis: Synthesis;
  issues: ConclusionIssue[];
  verification: Verification;
  memoryBlock?: string;
  log: (m: string) => void;
}

export async function runConclusionRepairRound(input: ConclusionRepairInput): Promise<ConclusionRepairRound> {
  const t0 = Date.now();
  const files = input.index.files.map((f) => f.path).sort();
  const shown = files.slice(0, MAX_FILE_LIST);
  const attempted: ConclusionRepairAttempt = { sent: input.issues.length, rewritten: 0, withdrawn: [], unaddressed: input.issues.length, stillBroken: 0, note: "", ms: 0 };

  let synthesis = input.synthesis;
  let fixes: ConclusionFix[] = [];
  const started = Date.now();
  try {
    const asked = await askJson({
      role: "leader",
      system: conclusionRepairSystem(),
      user: conclusionRepairUser({
        mission: input.mission,
        issues: input.issues.map((i) => ({ index: i.index, kind: i.kind, field: i.field, text: i.text, because: i.because })),
        files: shown,
        fileCount: files.length,
        rejected: input.verification.rejected.map(
          (c) => `[${c.status}] ${c.unit} ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim}${c.detail ? ` — ${c.detail}` : ""}`
        ),
        memory: input.memoryBlock,
      }),
      schema: ConclusionRepairSchema,
      maxTokens: 1600,
      attempts: 2,
    });
    fixes = [
      ...asked.value.fixed.map((f): ConclusionFix => ({ fixes: f.fixes, text: f.text })),
      ...asked.value.dropped.map((d): ConclusionFix => ({ fixes: d.fixes, why: d.why })),
    ];
    attempted.note = asked.value.note;
    attempted.ms = Date.now() - started;
    synthesis = applyConclusionFixes(input.synthesis, input.issues, fixes);

    // Re-check the whole paragraph, not just the answered sentences: a rewrite can introduce a new
    // contradiction in place of the old one, and finding that is the point of gating the answer again.
    const remaining = await checkConclusion({
      synthesis,
      verification: input.verification,
      index: input.index,
      root: input.projectRoot,
      exists: new Map(),
    });
    const stillFlagged = new Set(remaining.map((r) => r.text.replace(/\s+/g, " ").trim()));
    const byNumber = new Map(input.issues.map((i) => [i.index, i]));
    for (const f of fixes) {
      const issue = byNumber.get(f.fixes);
      if (!issue) continue;
      if (f.why && !f.text) {
        attempted.withdrawn.push({ text: issue.text, why: f.why });
      } else if (f.text) {
        if (stillFlagged.has(f.text.replace(/\s+/g, " ").trim())) attempted.stillBroken++;
        else attempted.rewritten++;
      }
    }
    attempted.unaddressed = Math.max(0, input.issues.length - attempted.rewritten - attempted.withdrawn.length - attempted.stillBroken);
    input.log(
      `  leader: conclusion repair — ${attempted.rewritten} of ${input.issues.length} sentence(s) rewritten without contradicting the record, ${attempted.withdrawn.length} given up, ${attempted.stillBroken} still contradicting it`
    );
    return { attempt: attempted, synthesis, issues: input.issues, remaining, calls: 1, rewritten: attempted.rewritten, withdrawn: attempted.withdrawn.length, ms: Date.now() - t0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    attempted.error = message;
    attempted.ms = Date.now() - started;
    input.log(`  leader: conclusion repair failed (${message.split("\n").slice(0, 2).join(" ")})`);
    return { attempt: attempted, synthesis: input.synthesis, issues: input.issues, remaining: input.issues, calls: 1, rewritten: 0, withdrawn: 0, ms: Date.now() - t0 };
  }
}
