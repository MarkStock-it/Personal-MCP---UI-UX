/**
 * The repair round — the collective's one second chance.
 *
 * A rejected finding used to be a dead end: the quote was not where the worker said it was, so it was
 * deleted and the unit's work was simply smaller. That throws away a real finding because of a bad
 * citation. This pass hands the finding back to the same worker with the server's own reason: which file,
 * which lines it cited, and — when the quote exists somewhere else — where it actually is.
 *
 * It is one pass, and only for the citations that are repairable, because the evidence says more than
 * that does not pay. Feeding a compile/test failure back and letting the model try again measurably beats
 * independent resampling when the budget is one repair per failure, but spending the same budget on
 * repeated repairs does not (Olausson et al., "Is Self-Repair a Silver Bullet for Code Generation?",
 * https://arxiv.org/abs/2306.09896); the gains from refinement are largest in the first round and shrink
 * after it (Madaan et al., "Self-Refine", https://arxiv.org/html/2303.17651v2); and debugging effectiveness
 * is reported to decay 60-80% within two to three attempts
 * (https://pmc.ncbi.nlm.nih.gov/articles/PMC12715212/). The feedback has to be specific to work at all —
 * model-generated critique without a reliable external signal often makes answers *worse*
 * (Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet", https://arxiv.org/html/2310.01798v2:
 * GPT-3.5 on CommonSenseQA 75.8% -> 38.1% after one unguided correction round). Which is exactly what this
 * server has and a self-critique loop does not: a deterministic verifier that found a concrete defect at a
 * concrete line.
 *
 * Two rules keep the pass honest:
 *   - A repair can only ADD. Claims that already verified are never re-sent, never edited, never replaced,
 *     because correction rounds also break answers that were right (Chen et al. report losses of 0-11.4
 *     points on initially correct answers, https://arxiv.org/html/2311.08516v3).
 *   - The gate decides. Repaired findings go through `verifyReports` exactly like round one, the first
 *     attempt stays in `rejected` for the record, and "I withdrew this claim, here is why" is a recorded,
 *     respectable outcome rather than a silent deletion.
 */
import type { CollectiveConfig } from "../config.js";
import { packContext, renderPack } from "../codebase/pack.js";
import type { RepoIndex } from "../codebase/store.js";
import { pLimit } from "../util/limit.js";
import { askJson } from "./ask.js";
import { RepairSchema, repairSystem, repairUser, type Unit, type WorkerRole } from "./roles.js";
import { normalise, verifyReports, type CheckedClaim, type Verification } from "./verify.js";

/** The statuses a worker can actually do something about: the quote is real, or the citation is wrong. */
const REPAIRABLE: CheckedClaim["status"][] = ["quote-not-found", "found-elsewhere"];

/** How many rejected findings one unit is handed back in a single pass. */
const MAX_REPAIRS_PER_UNIT = 8;

export const repairableRejections = (v: Verification): CheckedClaim[] => v.rejected.filter((c) => REPAIRABLE.includes(c.status));

export interface RepairAttempt {
  unit: string;
  role: WorkerRole;
  /** Findings handed back because the gate rejected them (capped per unit). */
  sent: number;
  /** Findings whose own claim came back citable: the same claim, with the citation corrected. */
  recited: number;
  /** Verified findings put in the rejected one's place, worded differently. Honest, but not the same fix. */
  replaced: number;
  /** Claims the worker withdrew with a reason instead of guessing again. */
  withdrawn: { claim: string; why: string }[];
  /** Sent back and never addressed at all. */
  unaddressed: number;
  note: string;
  error?: string;
  ms: number;
}

export interface RepairRound {
  attempts: RepairAttempt[];
  /** What this pass re-checked, as its own Verification, for `mergeVerification` to fold in. */
  verification: Verification;
  calls: number;
  /** Claims that failed once and now pass, at real lines, with real quotes. */
  repaired: number;
  /** Findings sent back that are still not verifiable anywhere. They stay rejected downstream. */
  stillRejected: number;
  ms: number;
}

export interface RepairInput {
  projectRoot: string;
  index: RepoIndex;
  units: Unit[];
  verification: Verification;
  cfg: CollectiveConfig;
  /** The same hint block the workers saw, so a repair cannot change the premises. */
  memoryBlock?: string;
  /** The skill each unit was assigned in round one, so the repair runs under the same instructions. */
  assigned?: Map<string, { name: string; path: string; text: string }>;
  concurrency: number;
  log: (m: string) => void;
}

const emptyVerification = (): Verification => ({
  claims: [],
  rejected: [],
  units: [],
  conflicts: [],
  counts: { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 },
  thin: [],
  supportCounts: { overlap: 0, thin: 0, unchecked: 0 },
  unparsed: [],
  ms: 0,
});

export async function runRepairRound(input: RepairInput): Promise<RepairRound> {
  const t0 = Date.now();
  const attempts: RepairAttempt[] = [];
  /** The claims this pass produced, per unit, kept beside the attempt records rather than inside them. */
  const produced = new Map<string, CheckedClaim[]>();
  const limit = pLimit(Math.max(1, input.concurrency));

  const byUnit = new Map<string, CheckedClaim[]>();
  for (const c of repairableRejections(input.verification)) {
    byUnit.set(c.unit, [...(byUnit.get(c.unit) ?? []), c]);
  }

  await Promise.all(
    [...byUnit.entries()].map(([unitId, claims]) =>
      limit(async () => {
        const unit = input.units.find((u) => u.id === unitId);
        if (!unit) return;
        const sent = claims.slice(0, MAX_REPAIRS_PER_UNIT);
        const started = Date.now();
        try {
          const pack = await packContext(input.projectRoot, input.index, {
            query: [unit.objective, ...unit.mustAnswer].join(" "),
            paths: unit.scope,
            budget: input.cfg.contextTokensPerWorker,
            symbols: [],
          });
          const asked = await askJson({
            role: "worker",
            system: repairSystem(unit.role, input.assigned?.get(unit.id)),
            user: repairUser(unit, renderPack(pack), sent, input.memoryBlock),
            schema: RepairSchema,
            maxTokens: 1800,
            attempts: 2,
          });
          const findings = asked.value.findings.map((f) => ({ ...f, unit: unitId }));
          const checked = findings.length
            ? await verifyReports({
                projectRoot: input.projectRoot,
                units: input.units,
                reports: [{ unit: unitId, answer: asked.value.note || "repair pass", findings, steps: [], unknowns: [], openQuestions: [], verdict: "ok" }],
              })
            : emptyVerification();
          // Which of the sent findings were actually addressed. A claim that comes back with the same text is
          // a re-citation; a verified finding with different text was offered in its place, which is honest but
          // is not the same claim fixed. Both are counted, separately, because the reader can tell them apart.
          const sentTexts = new Set(sent.map((c) => normalise(c.claim)));
          const recited = checked.claims.filter((c) => c.status === "verified" && sentTexts.has(normalise(c.claim))).length;
          const replaced = checked.claims.filter((c) => c.status === "verified" && !sentTexts.has(normalise(c.claim))).length;
          const withdrawn = asked.value.dropped.map((d) => ({ claim: d.claim, why: d.why }));
          const addressed = withdrawn.filter((w) => sentTexts.has(normalise(w.claim))).length;
          produced.set(unitId, checked.claims);
          attempts.push({
            unit: unitId,
            role: unit.role,
            sent: sent.length,
            recited,
            replaced,
            withdrawn,
            unaddressed: Math.max(0, sent.length - recited - addressed),
            note: asked.value.note,
            ms: Date.now() - started,
          });
          input.log(
            `  ${unitId}: repair pass — ${recited} of ${sent.length} re-cited under the same claim, ${replaced} replaced by a different finding${withdrawn.length ? `, ${withdrawn.length} withdrawn` : ""}`
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          attempts.push({ unit: unitId, role: unit.role, sent: sent.length, recited: 0, replaced: 0, withdrawn: [], unaddressed: sent.length, note: "", error: message, ms: Date.now() - started });
          input.log(`  ${unitId}: repair pass failed (${message.split("\n").slice(0, 2).join(" ")})`);
        }
      })
    )
  );

  const claims = [...produced.values()].flat();
  const counts: Verification["counts"] = { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 };
  for (const c of claims) counts[c.status]++;
  const verification: Verification = { ...emptyVerification(), claims, counts };
  return {
    attempts: attempts.sort((a, b) => a.unit.localeCompare(b.unit)),
    verification,
    calls: attempts.length,
    repaired: counts.verified,
    stillRejected: claims.length - counts.verified,
    ms: Date.now() - t0,
  };
}
