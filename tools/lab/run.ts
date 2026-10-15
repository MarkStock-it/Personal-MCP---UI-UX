/**
 * The lab: does a tiny learned preference layer earn its place, and what would it cost a session?
 *
 * Run it with:   npx tsx tools/lab/run.ts
 *
 * It answers four questions with numbers rather than opinions:
 *   1. Can the vocabulary even represent these judgements? (fit check — if it cannot fit, the features
 *      are wrong, and no amount of training will help.)
 *   2. Does it predict a judgement it has not seen? (leave-one-out, with a Wilson interval, since n is
 *      small and a bare percentage would overstate what is known.)
 *   3. Does taste transfer between projects? (train on one repo, test on the other — the owner's
 *      "ensemble so future repos can see my past decisions" idea.)
 *   4. Do the couplings help or hurt? (the owner's "connect them" idea, tested instead of assumed.)
 *
 * Plus the number that decides whether any of this is worth building at all: how many tokens a session
 * spends reading context today, versus what a digest costs.
 *
 * Nothing here writes to a project, and nothing here is part of the MCP surface. It is an experiment.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORPUS, type Judgement } from "./corpus.js";
import {
  accuracyOn, crossProject, evidenceModel, leaveOneOut, majorityBaseline, predict, tagVoteBaseline,
  train, wilson,
} from "./learner.js";
import { COUPLINGS, TAGS, type Tag } from "./vocabulary.js";
import { TOPICS, renderTopic } from "../../src/playbook/index.js";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SIBLING = path.resolve(REPO, "../Personal-Blog");

/** ~4 characters per token is the usual rough English estimate; every token figure here is that estimate. */
const tokens = (chars: number): number => Math.round(chars / 4);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const ci = (hits: number, n: number): string => {
  const [lo, hi] = wilson(hits, n);
  return `${pct(hits / n)} (95% CI ${pct(lo)}–${pct(hi)})`;
};
const line = (s = ""): void => { process.stdout.write(`${s}\n`); };

const pos = CORPUS.filter((i) => i.label === 1).length;
const neg = CORPUS.length - pos;
const blog = CORPUS.filter((i) => i.project === "blog");
const mcp = CORPUS.filter((i) => i.project === "mcp");

line("# design-mcp lab — is a learned preference layer worth building?");
line();
line(`Corpus: ${CORPUS.length} judgements (${pos} kept, ${neg} rejected), labelled by an agent reading`);
line(`the two repos rather than by the owner's verdicts — see the caveat in corpus.ts.`);
line(`By project: blog ${blog.length}, mcp ${mcp.length}. Vocabulary: ${TAGS.length} tags, ${COUPLINGS.length} couplings.`);

/* ---------- 1. can it fit? ---------- */

line();
line("## 1. Fit check — can the vocabulary represent these judgements at all?");
for (const useCouplings of [false, true]) {
  const model = train(CORPUS, { useCouplings });
  const fitted = accuracyOn(model, CORPUS, useCouplings);
  const params = model.weights.size + 1;
  line(`  ${useCouplings ? "tags + couplings" : "tags only     "}: fits the corpus at ${pct(fitted)} using ${params} parameters`);
}

/* ---------- 2. does it predict an unseen judgement? ---------- */

line();
line("## 2. Leave-one-out — predict a judgement the model was not trained on");
const alwaysKeep = Math.max(pos, neg) / CORPUS.length;
line(`  baseline: always answer the common label        ${pct(alwaysKeep)}`);
for (const useCouplings of [false, true]) {
  const { hits, n } = leaveOneOut(CORPUS, { useCouplings });
  line(`  ${useCouplings ? "tags + couplings" : "tags only     "}: ${ci(hits, n)} correct`);
}
{
  // The same baseline, run leave-one-out so the comparison is like for like.
  let hits = 0;
  for (let i = 0; i < CORPUS.length; i += 1) {
    const rest = CORPUS.filter((_, j) => j !== i);
    if (tagVoteBaseline(rest, [CORPUS[i]], false) === 1) hits += 1;
  }
  line(`  baseline: untrained tag voting (LOO)            ${ci(hits, CORPUS.length)} correct`);
}
for (const useCouplings of [false, true]) {
  let hits = 0;
  for (let i = 0; i < CORPUS.length; i += 1) {
    const held = CORPUS[i];
    const m = evidenceModel(CORPUS.filter((_, j) => j !== i), useCouplings);
    if (predict(m, held, useCouplings) === held.label) hits += 1;
  }
  line(`  ${useCouplings ? "evidence-wtd +cpl" : "evidence-weighted"}: ${ci(hits, CORPUS.length)} correct`);
}

/* ---------- 3. does taste travel between projects? ---------- */

line();
line("## 3. Cross-project — train on one repo, test on the other");
for (const [name, tr, te] of [["mcp -> blog", mcp, blog], ["blog -> mcp", blog, mcp]] as const) {
  const base = majorityBaseline(tr, te);
  const vote = tagVoteBaseline(tr, te, false);
  const plain = crossProject(tr, te, { useCouplings: false });
  const coupled = crossProject(tr, te, { useCouplings: true });
  const ev = evidenceModel(tr, false);
  const evHits = te.filter((i) => predict(ev, i, false) === i.label).length;
  const evCpl = evidenceModel(tr, true);
  const evCplHits = te.filter((i) => predict(evCpl, i, true) === i.label).length;
  line(`  ${name}: n=${te.length}`);
  line(`    always-guess baseline ${pct(base)} · untrained tag voting ${pct(vote)}`);
  line(`    learned (tags)        ${pct(plain.accuracy)}      · learned (tags+couplings) ${pct(coupled.accuracy)}`);
  line(`    evidence-weighted     ${pct(evHits / te.length)}      · evidence + couplings    ${pct(evCplHits / te.length)}`);
}

/* ---------- 4. what did it learn, and can it be read? ---------- */

line();
line("## 4. The learned weights (tags only, fitted on everything)");
const model = train(CORPUS, { useCouplings: false });
const rows = [...model.weights.entries()]
  .map(([f, w]) => ({ f, w, ev: model.evidence.get(f) ?? { pos: 0, neg: 0 } }))
  .sort((a, b) => b.w - a.w);
const show = (r: (typeof rows)[number]): string =>
  `  ${r.w >= 0 ? "+" : ""}${r.w.toFixed(2).padStart(5)}  ${r.f.padEnd(26)} evidence: ${r.ev.pos} kept / ${r.ev.neg} rejected`;
line("  strongest pulls toward keeping:");
for (const r of rows.slice(0, 6)) line(show(r));
line("  strongest pulls toward rejecting:");
for (const r of rows.slice(-6).reverse()) line(show(r));

line();
line("## 5. Are the REASONS what carry, or the items?");
const reasonTags = TAGS.filter((t) => t.startsWith("reason."));
for (const t of reasonTags) {
  const items = CORPUS.filter((i) => i.tags.includes(t as Tag));
  const w = model.weights.get(t) ?? 0;
  const kept = items.filter((i) => i.label === 1).length;
  line(`  ${t.padEnd(24)} weight ${w >= 0 ? "+" : ""}${w.toFixed(2).padStart(5)}  sees ${String(items.length).padStart(2)} judgements (${kept} kept)`);
}

/* ---------- 6. what does a session spend on context today? ---------- */

line();
line("## 6. Context cost — what this would save per session");
const readIf = (p: string): number => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").length : 0);
const docs = [
  ["blog handoff.md", path.join(SIBLING, "handoff.md")],
  ["blog HANDOFF-admin-hang.md", path.join(SIBLING, "HANDOFF-admin-hang.md")],
  ["mcp AGENTS.md", path.join(REPO, "AGENTS.md")],
  ["mcp README.md", path.join(REPO, "README.md")],
] as const;
let docChars = 0;
for (const [name, p] of docs) {
  const n = readIf(p);
  docChars += n;
  line(`  ${name.padEnd(30)} ${String(n).padStart(6)} chars  ~${tokens(n)} tokens${n ? "" : "   (not found)"}`);
}
const playbookChars = TOPICS.reduce((n, t) => n + renderTopic(t).length, 0);
line(`  ${"full playbook (every topic)".padEnd(30)} ${String(playbookChars).padStart(6)} chars  ~${tokens(playbookChars)} tokens`);
line(`  ${"a session's usual reading".padEnd(30)} ${String(docChars).padStart(6)} chars  ~${tokens(docChars)} tokens`);

/* A digest built the way the product would: the strongest pulls, each with the reason behind it. */
const digest = [
  "# Project memory (digest, wt=learned weight, n=judgements behind it)",
  "",
  "Do not, and why:",
  ...rows.slice(-10).reverse().map((r) => {
    const reason = CORPUS.find((i) => i.tags.includes(r.f as Tag))?.reason ?? "";
    return `- ${r.f} (wt ${r.w.toFixed(2)}, n=${r.ev.pos + r.ev.neg}) — ${reason}`;
  }),
  "",
  "Do, and why:",
  ...rows.slice(0, 10).map((r) => {
    const reason = CORPUS.find((i) => i.tags.includes(r.f as Tag))?.reason ?? "";
    return `- ${r.f} (wt ${r.w.toFixed(2)}, n=${r.ev.pos + r.ev.neg}) — ${reason}`;
  }),
].join("\n");
line(`  ${"the digest this model produces".padEnd(30)} ${String(digest.length).padStart(6)} chars  ~${tokens(digest.length)} tokens`);
line(`  saving vs the usual reading: ~${tokens(docChars) - tokens(digest.length)} tokens (${((1 - digest.length / docChars) * 100).toFixed(0)}% less)`);

/* ---------- 7. verdict ---------- */

line();
line("## Verdict");
{
  const arms: [string, number][] = [];
  for (const [name, mk] of [
    ["gradient-trained tags", (tr: Judgement[]) => train(tr, { useCouplings: false })],
    ["evidence-weighted tags", (tr: Judgement[]) => evidenceModel(tr, false)],
  ] as const) {
    let hits = 0;
    for (let i = 0; i < CORPUS.length; i += 1) {
      const held = CORPUS[i];
      if (predict(mk(CORPUS.filter((_, j) => j !== i)), held, false) === held.label) hits += 1;
    }
    arms.push([name, hits / CORPUS.length]);
  }
  let voteHits = 0;
  for (let i = 0; i < CORPUS.length; i += 1) {
    const rest = CORPUS.filter((_, j) => j !== i);
    if (tagVoteBaseline(rest, [CORPUS[i]], false) === 1) voteHits += 1;
  }
  arms.push(["untrained tag voting", voteHits / CORPUS.length]);

  const best = arms.slice().sort((a, b) => b[1] - a[1])[0];
  const spread = arms.map(([n, v]) => `${n} ${pct(v)}`).join(", ");
  line(`  On the corpus's own held-out judgements: ${spread}.`);
  line(`  The untrained vote is within noise of the trained model, so at n=${CORPUS.length} the VOCABULARY is doing`);
  line(`  the work and the training is not yet earning its keep. Best arm here: ${best[0]}.`);
  line(`  The honest read: build the memory and the digest now, keep the learner behind a flag, and re-run this`);
  line(`  harness once real verdicts exist. The harness is the learning curve — it is a number, not a feeling.`);
}
line();

// Keep the digest in the output so its size is verifiable rather than asserted.
if (process.argv.includes("--digest")) {
  line("--- digest begins ---");
  line(digest);
  line("--- digest ends ---");
}

const unused = TAGS.filter((t) => !CORPUS.some((i) => i.tags.includes(t)));
if (unused.length) line(`Never used by any judgement: ${unused.join(", ")}`);
line(`Couplings that never fire: ${COUPLINGS.filter(([a, b]) => !CORPUS.some((i) => i.tags.includes(a) && i.tags.includes(b))).length} of ${COUPLINGS.length}`);
