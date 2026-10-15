/**
 * The model the lab is testing: one weight per named feature, plus a bias. Nothing hidden.
 *
 * Why this shape and not a network: the owner's goal is a preference layer that learns from tens of
 * judgements, not thousands, and that can be read, argued with and edited. A linear model over named
 * features does both. Every parameter is a row a human can look at, and every prediction can be
 * explained by listing which features pushed which way.
 *
 * Training is plain online logistic regression: for each judgement, the features that fired move
 * their weights toward the label, and an L2 term pulls everything slowly back toward zero so a feature
 * seen once cannot dominate forever. `decay` matters because taste changes: an old preference should
 * fade in the absence of new evidence rather than being locked in.
 *
 * Everything is seeded, so two runs on the same corpus produce the same numbers.
 */
import type { Judgement } from "./corpus.js";
import { featuresOf } from "./vocabulary.js";

export interface Model {
  /** Feature name -> weight. The whole model is this table plus a bias. */
  weights: Map<string, number>;
  bias: number;
  /** How often each feature fired, split by label: the honest "how sure can it be" number. */
  evidence: Map<string, { pos: number; neg: number }>;
  /** Rounds actually run. */
  epochs: number;
}

export interface Options {
  useCouplings?: boolean;
  epochs?: number;
  lr?: number;
  /** L2 strength. Higher = more sceptical of a feature with little evidence. */
  l2?: number;
}

/** Deterministic PRNG (mulberry32) so a run is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function features(item: Judgement, useCouplings: boolean): string[] {
  return featuresOf(item.tags, useCouplings);
}

export function train(items: Judgement[], opts: Options = {}): Model {
  const useCouplings = opts.useCouplings ?? false;
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.6;
  const l2 = opts.l2 ?? 0.02;

  const weights = new Map<string, number>();
  const evidence = new Map<string, { pos: number; neg: number }>();
  const rand = rng(20261015);
  let bias = 0;

  for (const item of items) {
    for (const f of features(item, useCouplings)) {
      const e = evidence.get(f) ?? { pos: 0, neg: 0 };
      if (item.label === 1) e.pos += 1; else e.neg += 1;
      evidence.set(f, e);
      if (!weights.has(f)) weights.set(f, 0);
    }
  }

  const order = items.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    // Fisher-Yates with the seeded RNG: same corpus, same order, every run.
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const idx of order) {
      const item = items[idx];
      const fs = features(item, useCouplings);
      let z = bias;
      for (const f of fs) z += weights.get(f) ?? 0;
      const err = (item.label === 1 ? 1 : 0) - sigmoid(z);   // gradient of the log loss
      bias += lr * err * 0.1;                                // the bias learns slowly on purpose
      for (const f of fs) {
        const w = weights.get(f) ?? 0;
        weights.set(f, w + lr * (err - l2 * w));
      }
    }
  }
  return { weights, bias, evidence, epochs };
}

export function score(model: Model, item: Judgement, useCouplings: boolean): number {
  let z = model.bias;
  for (const f of features(item, useCouplings)) z += model.weights.get(f) ?? 0;
  return sigmoid(z);
}

export const predict = (model: Model, item: Judgement, useCouplings: boolean): 1 | -1 =>
  score(model, item, useCouplings) >= 0.5 ? 1 : -1;

/** Accuracy of a fitted model on a set it did not see. */
export function accuracyOn(model: Model, items: Judgement[], useCouplings: boolean): number {
  if (!items.length) return Number.NaN;
  const hit = items.filter((i) => predict(model, i, useCouplings) === i.label).length;
  return hit / items.length;
}

/** Leave-one-out: refit without the item, then ask about it. The honest small-data estimate. */
export function leaveOneOut(items: Judgement[], opts: Options = {}): { hits: number; n: number } {
  const useCouplings = opts.useCouplings ?? false;
  let hits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const held = items[i];
    const model = train(items.filter((_, j) => j !== i), opts);
    if (predict(model, held, useCouplings) === held.label) hits += 1;
  }
  return { hits, n: items.length };
}

/** Train on one project, test on the other: does taste transfer, or is each repo its own island? */
export function crossProject(trainSet: Judgement[], testSet: Judgement[], opts: Options = {}): {
  accuracy: number; n: number; hits: number;
} {
  const useCouplings = opts.useCouplings ?? false;
  const model = train(trainSet, opts);
  const hits = testSet.filter((i) => predict(model, i, useCouplings) === i.label).length;
  return { accuracy: testSet.length ? hits / testSet.length : Number.NaN, n: testSet.length, hits };
}

/**
 * The same table, but every weight is derived from evidence instead of from gradient steps.
 *
 * Why: plain training gave `reason.trust` a weight of -4.48 off TWO judgements, because nothing stopped
 * it. A weight that size from that little evidence is a confident claim the data does not support.
 * Here each feature contributes its LIFT over the base rate with a prior of `alpha` worth of fictional
 * observations, so a feature seen once lands near zero on its own and only repeated evidence moves it.
 * The bias carries the base rate.
 */
export function evidenceModel(trainSet: Judgement[], useCouplings: boolean, alpha = 2): Model {
  const evidence = new Map<string, { pos: number; neg: number }>();
  for (const item of trainSet) {
    for (const f of features(item, useCouplings)) {
      const e = evidence.get(f) ?? { pos: 0, neg: 0 };
      if (item.label === 1) e.pos += 1; else e.neg += 1;
      evidence.set(f, e);
    }
  }
  const kept = trainSet.filter((i) => i.label === 1).length;
  const prior = trainSet.length ? kept / trainSet.length : 0.5;
  const clamp = (p: number): number => Math.min(1 - 1e-6, Math.max(1e-6, p));
  const logit = (p: number): number => Math.log(clamp(p) / (1 - clamp(p)));

  const weights = new Map<string, number>();
  for (const [f, e] of evidence) {
    const seen = e.pos + e.neg;
    const pKept = (e.pos + alpha * prior) / (seen + alpha);     // smoothed, so n=1 barely counts
    weights.set(f, logit(pKept) - logit(prior));
  }
  return { weights, bias: logit(prior), evidence, epochs: 0 };
}

/* ---------- baselines, so a number means something ---------- */

/** Always answer with the more common label. */
export function majorityBaseline(trainSet: Judgement[], testSet: Judgement[]): number {
  const pos = trainSet.filter((i) => i.label === 1).length;
  const guess: 1 | -1 = pos >= trainSet.length / 2 ? 1 : -1;
  return testSet.length ? testSet.filter((i) => i.label === guess).length / testSet.length : Number.NaN;
}

/**
 * No learning at all: each feature votes the polarity it carried in the training set, the votes are
 * summed, and the sign decides. If the trained weights cannot beat this, the training is not earning
 * its keep — which is worth knowing before any of it ships.
 */
export function tagVoteBaseline(trainSet: Judgement[], testSet: Judgement[], useCouplings: boolean): number {
  const vote = new Map<string, number>();
  for (const item of trainSet) {
    for (const f of features(item, useCouplings)) vote.set(f, (vote.get(f) ?? 0) + item.label);
  }
  const pos = trainSet.filter((i) => i.label === 1).length;
  const fallback: 1 | -1 = pos >= trainSet.length / 2 ? 1 : -1;
  let hits = 0;
  for (const item of testSet) {
    let sum = 0;
    for (const f of features(item, useCouplings)) sum += vote.get(f) ?? 0;
    const guess: 1 | -1 = sum === 0 ? fallback : sum > 0 ? 1 : -1;
    if (guess === item.label) hits += 1;
  }
  return testSet.length ? hits / testSet.length : Number.NaN;
}

/** Wilson score interval: with n this small, a bare percentage would overstate what it knows. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] {
  if (!n) return [Number.NaN, Number.NaN];
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - spread) / denom, (centre + spread) / denom];
}
