/**
 * The gate between what the collective says and what is true.
 *
 * Every finding a worker reports is re-read from disk here. The quote must be present at the cited
 * lines; whitespace is normalised away, nothing else is. A claim that fails is not "downgraded" — it is
 * marked rejected and removed from what the leader is allowed to build on, because a team that can
 * propagate an invented fact is worse than a single model that invents one.
 *
 * Finding the quote is still only half of it. An audit of four generative search engines found only
 * 51.5% of generated sentences fully supported by the citations attached to them, and 25.5% of the
 * citations did not support their sentence at all (Liu, Zhang & Liang, "Evaluating Verifiability in
 * Generative Search Engines", https://arxiv.org/html/2304.09848v2); in a medical audit about 30% of
 * cited statements were unsupported (SourceCheckup, https://pmc.ncbi.nlm.nih.gov/articles/PMC12003634/).
 * So a quote that really is where the worker said it can still fail to back the claim on top of it.
 *
 * This file can only check the blatant half of that, and it says so out loud: a quote that shares no
 * content word with its claim is flagged `thin` and read by the owner instead. The other direction is
 * NOT a check: shared words are not entailment (HANS showed non-entailing pairs with near-perfect
 * overlap, https://arxiv.org/html/1902.01007v4), so a high-overlap claim is labelled `overlap` — "the
 * wording lines up" — and never "supported". Grading a real claim against its quote needs a reading
 * model; what is here is the part that is honest without one.
 *
 * This runs with no model, so it cannot be talked out of its answer.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Unit, WorkerReport } from "./roles.js";

export type ClaimStatus = "verified" | "found-elsewhere" | "quote-not-found" | "file-missing" | "outside-project";

export type Support = "overlap" | "thin" | "unchecked";

/** What the support flag does and does not mean. Printed wherever the flag is. */
export const SUPPORT_MEANING: Record<Support, string> = {
  overlap: "the quote shares wording with the claim — nothing more; wording is not entailment",
  thin: "the quote is in the file but shares no content word with the claim, so it does not visibly back it: read that line yourself",
  unchecked: "no claim text to compare, so only the quote's location was checked",
};

export const STATUS_MEANING: Record<ClaimStatus, string> = {
  verified: "the quote is in the file at the cited lines",
  "found-elsewhere": "the quote is in the file, but not at the cited lines: the line numbers were wrong",
  "quote-not-found": "the quote is not in that file at all: the claim is unverified",
  "file-missing": "that path does not exist in the project",
  "outside-project": "that path is outside the project: refused, not read",
};

export interface CheckedClaim {
  unit: string;
  role: string;
  claim: string;
  path: string;
  lines?: [number, number];
  quote: string;
  confidence: string;
  status: ClaimStatus;
  foundAt?: number;
  detail?: string;
  /** Only set when the quote was found: does it even look like it backs the claim? See `supportOf`. */
  support?: Support;
  /** True for a finding that was rejected once and re-verified on the repair pass. */
  repaired?: boolean;
}

export interface UnitSummary {
  unit: string;
  role: string;
  verdict: string;
  answered: boolean;
  verified: number;
  rejected: number;
  total: number;
  unknowns: number;
  answer: string;
}

export interface Verification {
  claims: CheckedClaim[];
  rejected: CheckedClaim[];
  units: UnitSummary[];
  conflicts: string[];
  counts: Record<ClaimStatus, number>;
  /** Verified quotes that share no content word with the claim they are attached to. */
  thin: CheckedClaim[];
  supportCounts: Record<Support, number>;
  unparsed: { unit: string; error: string }[];
  ms: number;
}

/** Whitespace-insensitive, otherwise exact. Line-number gutters are stripped so a quote of a quote still matches. */
export function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*\|/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const head = (s: string, n = 48) => normalise(s).slice(0, n);

/** Words that carry no claim-specific meaning. Removing them can only make the check more cautious. */
const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "all", "also", "because", "before", "being", "below", "between", "both",
  "could", "does", "doing", "done", "down", "during", "each", "every", "from", "further", "have", "having", "here", "however",
  "instead", "into", "itself", "just", "least", "less", "many", "might", "more", "most", "much", "must", "next", "nothing",
  "only", "other", "others", "over", "rather", "same", "should", "since", "some", "still", "such", "than", "that", "their",
  "them", "then", "there", "these", "they", "this", "those", "through", "thus", "under", "until", "very", "were", "what",
  "when", "where", "which", "while", "will", "with", "within", "without", "would", "your",
  // Code words that appear in almost any snippet, so they say nothing about support either way.
  "code", "file", "files", "function", "functions", "line", "lines", "value", "values", "type", "types", "used", "uses", "using",
]);

/** Content words of a claim or a quote: identifiers and prose, minus the words that mean nothing here. */
export function contentWords(text: string): string[] {
  return normalise(text)
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .flatMap((w) => w.split("_").filter(Boolean))
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/** Cheap stemming: a five-character prefix, so "exported"/"export" and "normalise"/"normalises" meet. */
export function shareStem(a: string, b: string): boolean {
  const n = Math.min(5, a.length, b.length);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/**
 * Does this quote look like it backs this claim? One-sided on purpose: the only answer that can be given
 * without a reading model is "these two have nothing to do with each other". A claim with fewer than two
 * content words, or no claim text at all, is `unchecked` rather than guessed at.
 */
export function supportOf(claim: string | undefined, quote: string): Support {
  if (!claim || claim.trim().length < 12) return "unchecked";
  const claimWords = contentWords(claim);
  if (claimWords.length < 2) return "unchecked";
  const quoteWords = contentWords(quote);
  if (!quoteWords.length) return "unchecked";
  return claimWords.some((t) => quoteWords.some((w) => shareStem(t, w))) ? "overlap" : "thin";
}

export interface VerifyInput { projectRoot: string; units: Unit[]; reports: WorkerReport[]; cache?: Map<string, string | null> }

export async function verifyReports(input: VerifyInput): Promise<Verification> {
  const t0 = Date.now();
  const root = path.resolve(input.projectRoot);
  const files = input.cache ?? new Map<string, string | null>();
  const counts: Record<ClaimStatus, number> = { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 };
  const claims: CheckedClaim[] = [];
  const rejected: CheckedClaim[] = [];
  const unparsed: { unit: string; error: string }[] = [];

  const read = async (rel: string): Promise<string | null> => {
    if (files.has(rel)) return files.get(rel)!;
    let text: string | null = null;
    try {
      text = await fs.readFile(path.join(root, rel), "utf8");
    } catch {
      text = null;
    }
    files.set(rel, text);
    return text;
  };

  for (const report of input.reports) {
    const unit = input.units.find((u) => u.id === report.unit);
    const role = unit?.role ?? "explorer";
    if (!unit) unparsed.push({ unit: report.unit, error: "the report names a unit that is not in the plan" });

    for (const f of report.findings) {
      const rel = f.path.replace(/^\.\//, "").replace(/\\/g, "/");
      const abs = path.resolve(root, rel);
      const claim: CheckedClaim = { unit: report.unit, role, claim: f.claim, path: rel, lines: f.lines, quote: f.quote, confidence: f.confidence, status: "quote-not-found" };

      if (!abs.startsWith(root + path.sep) && abs !== root) {
        claim.status = "outside-project";
        claim.detail = "refused: nothing outside the project is read";
      } else if (normalise(f.quote).length < 8) {
        claim.status = "quote-not-found";
        claim.detail = "the quote is too short to prove anything (under 8 characters after normalising)";
      } else {
        const text = await read(rel);
        if (text === null) {
          claim.status = "file-missing";
          claim.detail = "no such file (or unreadable)";
        } else {
          const normFile = normalise(text);
          const q = normalise(f.quote);
          if (f.lines) {
            const slice = text.split("\n").slice(Math.max(0, f.lines[0] - 1), f.lines[1]);
            if (normalise(slice.join("\n")).includes(q)) {
              claim.status = "verified";
              claim.foundAt = f.lines[0];
            } else if (normFile.includes(q)) {
              claim.status = "found-elsewhere";
              claim.foundAt = locate(text, q);
              claim.detail = `the quote is real but lives near line ${claim.foundAt}, not ${f.lines[0]}-${f.lines[1]}`;
            } else {
              // The most common rejection by far: line numbers were given and the text is not there. The
              // nearest-line note is what makes this repairable, and it used to be unreachable in exactly
              // this branch — the hint only appeared when no lines were cited at all.
              const near = nearestLine(text, q);
              claim.detail = near
                ? `not found at ${f.lines[0]}-${f.lines[1]}; the closest line is ${near.line}: "${near.text}"`
                : `not found in that file at or near ${f.lines[0]}-${f.lines[1]}, and nothing there resembles it`;
            }
          } else if (normFile.includes(q)) {
            claim.status = "found-elsewhere";
            claim.foundAt = locate(text, q);
            claim.detail = `no line range was cited; the quote is near line ${claim.foundAt}`;
          } else {
            // Last tolerance: a quote that merely edits the punctuation of a real line is still rejected,
            // but we say which line it resembles so the worker can repair it instead of guessing again.
            const near = nearestLine(text, q);
            claim.detail = near ? `not found; closest line is ${near.line}: "${near.text}"` : "not found in that file, and nothing there resembles it";
          }
        }
      }
      if (claim.status === "verified") claim.support = supportOf(f.claim, f.quote);

      counts[claim.status]++;
      claims.push(claim);
      if (claim.status !== "verified") rejected.push(claim);
    }
  }

  const units: UnitSummary[] = input.reports.map((r) => {
    const mine = claims.filter((c) => c.unit === r.unit);
    const ok = mine.filter((c) => c.status === "verified").length;
    return {
      unit: r.unit,
      role: input.units.find((u) => u.id === r.unit)?.role ?? "explorer",
      verdict: r.verdict,
      answered: r.answer.trim().length > 0,
      verified: ok,
      rejected: mine.length - ok,
      total: mine.length,
      unknowns: r.unknowns.length,
      answer: r.answer,
    };
  });

  return { claims, rejected, units, conflicts: conflictsIn(input.units, input.reports), counts, thin: thinOf(claims), supportCounts: supportCountsOf(claims), unparsed, ms: Date.now() - t0 };
}

const thinOf = (claims: CheckedClaim[]): CheckedClaim[] => claims.filter((c) => c.status === "verified" && c.support === "thin");

function supportCountsOf(claims: CheckedClaim[]): Record<Support, number> {
  const out: Record<Support, number> = { overlap: 0, thin: 0, unchecked: 0 };
  for (const c of claims) if (c.status === "verified" && c.support) out[c.support]++;
  return out;
}

/**
 * Fold a second pass's claims into the mission's verification (used by the repair round).
 *
 * Nothing is replaced or removed: the first attempt stays in `rejected` where it belongs, and a repaired
 * finding joins `claims` marked `repaired`, so a reader can always see that the same unit said it twice
 * and only the second citation survived. Counts are recomputed from the merged list, never carried over.
 */
export function mergeVerification(base: Verification, extra: Verification): Verification {
  // A worker that ignores the instruction not to re-send a finding that already passed must not be able to
  // inflate the evidence: a finding identical to one the mission already recorded — same unit, file, lines,
  // claim and quote — is dropped here. Any difference at all (a corrected line number, new wording) is kept,
  // because "same quote, right lines" is precisely what a repaired citation looks like.
  const key = (c: CheckedClaim) => `${c.unit}|${c.path}|${c.lines ? `${c.lines[0]}-${c.lines[1]}` : ""}|${normalise(c.claim)}|${normalise(c.quote)}`;
  const seen = new Set(base.claims.map(key));
  const added = extra.claims.filter((c) => !seen.has(key(c))).map((c) => ({ ...c, repaired: true }));
  const claims = [...base.claims, ...added];
  const counts: Record<ClaimStatus, number> = { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 };
  for (const c of claims) counts[c.status]++;
  const units: UnitSummary[] = base.units.map((u) => {
    const mine = claims.filter((c) => c.unit === u.unit);
    const ok = mine.filter((c) => c.status === "verified").length;
    return { ...u, verified: ok, rejected: mine.length - ok, total: mine.length };
  });
  return {
    claims,
    rejected: claims.filter((c) => c.status !== "verified"),
    units,
    conflicts: base.conflicts,
    counts,
    thin: thinOf(claims),
    supportCounts: supportCountsOf(claims),
    unparsed: [...base.unparsed, ...extra.unparsed],
    ms: base.ms + extra.ms,
  };
}

/** Approximate line where a normalised quote sits, by matching its first words against each line. */
export function locate(text: string, q: string): number | undefined {
  const lines = text.split("\n");
  const needle = head(q, 40);
  if (!needle) return undefined;
  for (let i = 0; i < lines.length; i++) {
    if (normalise(lines[i]).includes(needle)) return i + 1;
  }
  for (let i = 0; i < lines.length - 2; i++) {
    if (normalise(lines.slice(i, i + 3).join("\n")).includes(needle)) return i + 1;
  }
  return undefined;
}

export function nearestLine(text: string, q: string): { line: number; text: string } | null {
  const words = new Set(q.split(" ").filter((w) => w.length > 3));
  if (!words.size) return null;
  const scored: { line: number; text: string; score: number }[] = [];
  text.split("\n").forEach((l, i) => {
    const n = normalise(l);
    if (n.length < 8) return;
    let score = 0;
    for (const w of words) if (n.includes(w)) score++;
    if (score) scored.push({ line: i + 1, text: l.trim().slice(0, 120), score });
  });
  const best = scored.sort((a, b) => b.score - a.score || a.line - b.line)[0];
  return best && best.score >= 2 ? { line: best.line, text: best.text } : null;
}

/** Two units that write to the same file cannot see each other. Catch it before the work is merged. */
export function conflictsIn(units: Unit[], reports: WorkerReport[]): string[] {
  const owners = new Map<string, Set<string>>();
  const writers = new Set(["implementer", "architect"]);
  for (const u of units) {
    if (!writers.has(u.role)) continue;
    for (const p of u.scope) {
      const set = owners.get(p) ?? new Set<string>();
      set.add(u.id);
      owners.set(p, set);
    }
  }
  for (const r of reports) {
    if (!writers.has(units.find((u) => u.id === r.unit)?.role ?? "")) continue;
    for (const s of r.steps) {
      const set = owners.get(s.path) ?? new Set<string>();
      set.add(r.unit);
      owners.set(s.path, set);
    }
  }
  return [...owners.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([p, ids]) => `${p} is claimed by ${[...ids].join(" and ")} — those units cannot see each other's work; merge them or hand the file to one of them`)
    .sort();
}

/** The same gate, for claims the host's own assistant wants checked before it answers. */
export async function verifyCallerClaims(
  projectRoot: string,
  claims: { claim?: string; path: string; lines?: [number, number]; quote: string; confidence?: "high" | "medium" | "low" }[]
): Promise<Verification> {
  const units: Unit[] = [{ id: "caller", role: "explorer", objective: "claims supplied by the caller, checked against the files", scope: [], mustAnswer: ["is every quote where it says it is?"], doneWhen: [], local: false }];
  const reports: WorkerReport[] = [
    {
      unit: "caller",
      answer: `${claims.length} caller-supplied claim(s)`,
      findings: claims.map((c) => ({
        claim: c.claim ?? c.quote.replace(/\s+/g, " ").slice(0, 80),
        path: c.path,
        lines: c.lines,
        quote: c.quote,
        confidence: c.confidence ?? "medium",
      })),
      steps: [],
      unknowns: [],
      openQuestions: [],
      verdict: "ok",
    },
  ];
  return verifyReports({ projectRoot, units, reports });
}

export function renderVerification(v: Verification, opts: { quotes?: boolean; limit?: number } = {}): string {
  const total = v.claims.length;
  const order: ClaimStatus[] = ["verified", "found-elsewhere", "quote-not-found", "file-missing", "outside-project"];
  const lines = [
    `${total} claim(s) checked against the files in ${v.ms} ms: ${order.map((s) => `${v.counts[s]} ${s}`).filter((s) => !s.startsWith("0 ")).join(", ") || "none"}.`,
    ...(v.unparsed.length ? [`${v.unparsed.length} worker report(s) could not be used: ${v.unparsed.map((u) => `${u.unit} (${u.error})`).join("; ")}`] : []),
    "",
    "Per unit:",
    ...v.units.map((u) => `  ${u.unit} (${u.role}): ${u.verified}/${u.total} claims verified, verdict ${u.verdict}, ${u.unknowns} unknown(s) admitted — ${u.answer.replace(/\s+/g, " ").slice(0, 160)}`),
  ];
  if (v.rejected.length) {
    lines.push("", "REJECTED (do not build on these):");
    for (const c of v.rejected.slice(0, opts.limit ?? 20)) {
      lines.push(`  - [${c.status}] ${c.unit} ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim.replace(/\s+/g, " ").slice(0, 140)}`);
      if (c.detail) lines.push(`      ${c.detail}`);
      if (opts.quotes) lines.push(`      quoted: "${c.quote.replace(/\s+/g, " ").slice(0, 120)}"`);
    }
    if (v.rejected.length > (opts.limit ?? 20)) lines.push(`  ... and ${v.rejected.length - (opts.limit ?? 20)} more`);
  }
  if (v.thin.length) {
    lines.push(
      "",
      `VERIFIED BUT THIN (the quote is really there and shares no content word with the claim — a citation is not support; check these by hand):`,
      ...v.thin.slice(0, opts.limit ?? 20).map((c) => `  - ${c.unit} ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim.replace(/\s+/g, " ").slice(0, 140)}`)
    );
  }
  if (v.conflicts.length) lines.push("", "CONFLICTS:", ...v.conflicts.map((c) => `  - ${c}`));
  return lines.join("\n");
}
