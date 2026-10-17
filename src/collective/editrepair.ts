/**
 * The edit repair pass — one second chance for a change that could not be placed.
 *
 * The gate will not let an unplaceable edit through, and it is right not to: an edit anchored to something
 * that is not in that file is a guess about where the code goes. But deleting it and moving on throws away
 * real work for a citation-shaped reason, which is exactly the mistake the citation repair pass was written
 * to stop making. This is that pass pointed at the work: the step goes back to whoever proposed it — the unit
 * that wrote it, or the leader for a step of the closing plan — carrying the server's own reason, and the
 * answer is re-gated at the same standard.
 *
 * Same evidence, same rules, for the same reasons:
 *   - one pass, never a loop. A single targeted repair after a deterministic rejection beats resampling,
 *     repeated repair decays (Olausson et al., https://arxiv.org/abs/2306.09896; Madaan et al.,
 *     https://arxiv.org/html/2303.17651v2), and the feedback only works because it is specific — which is
 *     what a real verifier can supply and a model criticising itself cannot (Huang et al.,
 *     https://arxiv.org/html/2310.01798v2).
 *   - a repair can only ADD. Steps that placed correctly are not re-sent, not edited, not replaced, because
 *     correction rounds also break what was already right (Chen et al., https://arxiv.org/html/2311.08516v3).
 *     The prompt is told how many steps were placed and are deliberately absent, so silence is not read as
 *     a request to rewrite them.
 *   - the gate decides. What comes back goes through `verifyEdits` exactly like the first attempt, the first
 *     attempt stays in the record (marked as superseded, never deleted), and "I cannot place this step, here
 *     is why" is a recorded, respectable outcome rather than a silent deletion.
 *   - a reply is matched to a question by arithmetic, not by a model: every returned step carries `fixes`,
 *     the number of the rejected step it replaces. Without that, "which of yours answers which of mine" is
 *     a judgement call, and this codebase does not make those when it can count instead.
 *
 * Which failures are repairable is deliberate. The four that can be re-placed from real source are: the
 * anchor is not in the file, the anchor is real but the lines are stale, the anchor occurs several times
 * with no range to pin it down, and the cited range is past the end of the file. A step naming a path that
 * is not in the index is also repairable, because the answer is usually a real file the unit owns — the
 * reason names the closest path. A path outside the project is NOT: that is a refusal, and a refusal is not
 * a defect to iterate on.
 */
import { packContext, renderPack } from "../codebase/pack.js";
import type { RepoIndex } from "../codebase/store.js";
import type { CollectiveConfig } from "../config.js";
import { pLimit } from "../util/limit.js";
import { askJson } from "./ask.js";
import { verifyEdits, type CheckedEdit, type EditCheck, type EditStatus, type ProposedEdit } from "./edits.js";
import { EditRepairSchema, editRepairLeaderSystem, editRepairSystem, editRepairUser, type RejectedStep, type Unit, type WorkerRole } from "./roles.js";

/** The statuses a source can do something about with the reason the gate gave it. */
const REPAIRABLE: EditStatus[] = ["anchor-not-found", "anchor-elsewhere", "anchor-ambiguous", "lines-out-of-range", "no-such-file"];

export const repairableEdits = (check: EditCheck): CheckedEdit[] => check.edits.filter((e) => REPAIRABLE.includes(e.status));

/** How many unplaceable steps one source is handed back in a single pass. */
const MAX_PER_SOURCE = 6;

export interface EditRepairAttempt {
  /** The unit id, or `plan` for the leader's own closing plan. */
  source: string;
  role?: WorkerRole;
  sent: number;
  /** Returned for the same step and now really placed. */
  fixed: number;
  /** Returned, but still not placeable anywhere: it stays broken downstream. */
  stillBroken: number;
  /** Steps their own author withdrew with a reason instead of guessing again. */
  withdrawn: { intent: string; why: string }[];
  /** Sent back and never addressed at all. */
  unaddressed: number;
  note: string;
  error?: string;
  ms: number;
}

export interface EditRepairRound {
  attempts: EditRepairAttempt[];
  /** What this pass re-checked, for `mergeEditChecks` to fold in. */
  check: EditCheck;
  /** Steps that are settled: `fixed` came back placed, `withdrawn` were given up by their author. */
  settled: { fixed: string[]; withdrawn: string[] };
  calls: number;
  fixed: number;
  stillBroken: number;
  withdrawn: number;
  ms: number;
}

export interface EditRepairInput {
  projectRoot: string;
  index: RepoIndex;
  units: Unit[];
  /** The first pass's gate result: what it rejected is what goes back. */
  edits: EditCheck;
  cfg: CollectiveConfig;
  /** The same hint block the workers saw, so a repair cannot change the premises. */
  memoryBlock?: string;
  /** The skill each unit was assigned, so a repaired step runs under the same instructions. */
  assigned?: Map<string, { name: string; path: string; text: string }>;
  concurrency: number;
  log: (m: string) => void;
  /** Shared with the citation and edit gates, so a file read once is not read again. */
  cache?: Map<string, string | null>;
}

/** What one source answered, before the aggregate re-gate turns it into an attempt record. */
interface RawAnswer {
  source: string;
  role?: WorkerRole;
  sent: CheckedEdit[];
  /** Each returned step, with where it landed in the aggregate list and which step it claims to replace. */
  mapped: { fixes: number; at: number }[];
  dropped: { fixes: number; why: string }[];
  note: string;
  error?: string;
  ms: number;
}

const withRole = (units: Unit[], source: string): WorkerRole | undefined => units.find((u) => u.id === source)?.role;

export async function runEditRepairRound(input: EditRepairInput): Promise<EditRepairRound> {
  const t0 = Date.now();
  const bySource = new Map<string, CheckedEdit[]>();
  for (const e of repairableEdits(input.edits)) bySource.set(e.source, [...(bySource.get(e.source) ?? []), e]);

  const limit = pLimit(Math.max(1, input.concurrency));
  const proposed: ProposedEdit[] = [];
  const raws: RawAnswer[] = [];

  await Promise.all(
    [...bySource.entries()].map(([source, edits]) =>
      limit(async () => {
        const sent = edits.slice(0, MAX_PER_SOURCE);
        const unit = input.units.find((u) => u.id === source);
        const isPlan = source === "plan";
        const started = Date.now();
        const placed = input.edits.edits.filter((e) => e.source === source && !REPAIRABLE.includes(e.status)).length;
        const rejected: RejectedStep[] = sent.map((e, i) => ({ index: i + 1, path: e.path, intent: e.intent, anchor: e.anchor, lines: e.lines, status: e.status, detail: e.detail }));
        try {
          // The files the rejected steps named, when they exist. A repair has to be able to see the source it
          // claims its anchor is in, or it is guessing again — and for a step with no real path there is
          // nothing to pack but the unit's own files, which is the honest context for "which file did I mean".
          const named = [...new Set(sent.map((e) => e.path).filter((p) => input.index.files.some((f) => f.path === p)))];
          const pack = await packContext(input.projectRoot, input.index, {
            query: sent.map((s) => `${s.intent} ${s.anchor ?? ""} ${s.path}`).join(" "),
            paths: named.length ? named : (unit?.scope ?? []),
            budget: input.cfg.contextTokensPerWorker,
            symbols: [],
          });
          const asked = await askJson({
            role: isPlan ? "leader" : "worker",
            system: isPlan ? editRepairLeaderSystem() : editRepairSystem(unit?.role ?? "implementer", input.assigned?.get(source)),
            user: editRepairUser({
              who: isPlan ? "the closing plan" : source,
              objective: unit?.objective,
              placedElsewhere: placed,
              rejected,
              pack: renderPack(pack),
              memory: input.memoryBlock,
            }),
            schema: EditRepairSchema,
            maxTokens: 1800,
            attempts: 2,
          });
          const mapped: RawAnswer["mapped"] = [];
          asked.value.steps.forEach((s, i) => {
            const target = s.fixes >= 1 && s.fixes <= sent.length ? sent[s.fixes - 1] : null;
            // A step offered for a number that was not asked about is a new edit, not a repair: it gets its
            // own identity so it cannot silently take credit for fixing the step it ignored.
            const sourceIndex = target ? target.sourceIndex : 1000 + i;
            mapped.push({ fixes: target ? s.fixes : 0, at: proposed.length });
            proposed.push({ source, sourceIndex, role: unit?.role, path: s.path, intent: s.intent, anchor: s.anchor, lines: s.lines, risk: s.risk, scope: unit?.scope });
          });
          raws.push({
            source,
            role: unit?.role,
            sent,
            mapped,
            dropped: asked.value.dropped.filter((d) => d.fixes >= 1 && d.fixes <= sent.length),
            note: asked.value.note,
            ms: Date.now() - started,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          raws.push({ source, role: unit?.role, sent, mapped: [], dropped: [], note: "", error: message, ms: Date.now() - started });
          input.log(`  ${source}: edit repair failed (${message.split("\n").slice(0, 2).join(" ")})`);
        }
      })
    )
  );

  // One re-gate over everything that came back, at exactly the standard of the first pass.
  const check = proposed.length ? await verifyEdits({ projectRoot: input.projectRoot, index: input.index, edits: proposed, cache: input.cache }) : emptyCheck();

  const fixed: string[] = [];
  const withdrew: string[] = [];
  const attempts: EditRepairAttempt[] = raws
    .map((raw) => {
      let fixedCount = 0;
      let stillBroken = 0;
      for (const m of raw.mapped) {
        const status = check.edits[m.at]?.status;
        if (m.fixes === 0) {
          // A step for a number nobody asked about: only counted when it fails, since a placed extra step is
          // new work rather than a repair.
          if (status !== "anchored") stillBroken++;
          continue;
        }
        const key = `${raw.source}|${raw.sent[m.fixes - 1].sourceIndex}`;
        if (status === "anchored") {
          fixedCount++;
          fixed.push(key);
        } else stillBroken++;
      }
      const withdrawn = raw.dropped.map((d) => ({ intent: raw.sent[d.fixes - 1].intent, why: d.why }));
      raw.dropped.forEach((d) => withdrew.push(`${raw.source}|${raw.sent[d.fixes - 1].sourceIndex}`));
      const addressed = new Set([...raw.mapped.filter((m) => m.fixes > 0).map((m) => m.fixes), ...raw.dropped.map((d) => d.fixes)]);
      if (!raw.error) {
        input.log(
          `  ${raw.source}: edit repair — ${fixedCount} of ${raw.sent.length} re-placed${withdrawn.length ? `, ${withdrawn.length} withdrawn` : ""}${stillBroken ? `, ${stillBroken} still not placeable` : ""}`
        );
      }
      return {
        source: raw.source,
        role: raw.role,
        sent: raw.sent.length,
        fixed: fixedCount,
        stillBroken,
        withdrawn,
        unaddressed: Math.max(0, raw.sent.length - addressed.size),
        note: raw.note,
        error: raw.error,
        ms: raw.ms,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source));

  return {
    attempts,
    check,
    settled: { fixed, withdrawn: withdrew },
    calls: raws.length,
    fixed: fixed.length,
    stillBroken: attempts.reduce((n, a) => n + a.stillBroken, 0),
    withdrawn: withdrew.length,
    ms: Date.now() - t0,
  };
}

const emptyCounts = (): Record<EditStatus, number> => ({
  anchored: 0,
  unanchored: 0,
  "anchor-elsewhere": 0,
  "anchor-ambiguous": 0,
  "anchor-not-found": 0,
  "lines-out-of-range": 0,
  "no-such-file": 0,
  "outside-project": 0,
});

const emptyCheck = (): EditCheck => ({ edits: [], counts: emptyCounts(), broken: 0, unanchored: 0, staleLines: 0, notes: [], ms: 0 });

/** The dossier section for this pass, rendered by `run.ts`. */
export function renderEditRepair(round: EditRepairRound): string[] {
  return [
    "## The edit repair pass (one second chance for a step that could not be placed)",
    `- ${round.calls} source(s) got their own unplaceable steps back with the server's reason: which lines they cited, where the anchor really is when it exists, how many times it occurs, or that the path is not in the index. ${round.fixed} step(s) came back placed, ${round.withdrawn} withdrawn with a reason, ${round.stillBroken} still not placeable.`,
    ...round.attempts.map(
      (a) =>
        `- ${a.source === "plan" ? "the closing plan (leader)" : `${a.source}${a.role ? ` (${a.role})` : ""}`}: ${a.sent} sent back → ${a.fixed} re-placed, ${a.withdrawn.length} withdrawn, ${a.unaddressed} left unaddressed${a.stillBroken ? `, ${a.stillBroken} still not placeable` : ""}${a.error ? ` — the pass FAILED: ${a.error.split("\n")[0]}` : ""}`
    ),
    ...round.attempts.flatMap((a) => a.withdrawn.map((w) => `    - ${a.source} withdrew: ${w.intent.replace(/\s+/g, " ").slice(0, 160)} — ${w.why.replace(/\s+/g, " ").slice(0, 200)}`)),
    "- Nothing that had already been placed was re-sent: a repair is allowed to add, never to rewrite a step that landed. Every returned step went through the same gate at the same standard, so a step that comes back unplaceable is still listed above as one that cannot be applied.",
  ];
}
