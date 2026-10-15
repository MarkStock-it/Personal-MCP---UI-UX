/**
 * The vocabulary: the "neurons" the lab learns over.
 *
 * A tag is a NAMED feature, and naming is the whole point. A weight on `material.hard` can be read,
 * argued with and edited; a weight buried in a hidden layer cannot. The vocabulary is deliberately
 * small and derived from what already exists in this repo and its sibling — the playbook's topics and
 * entry ids, plus the process rules in AGENTS.md — so the model starts from the owner's own language
 * rather than an invented one.
 *
 * Naming conventions
 * - `domain.aspect`: what a judgement is about (motion, material, type, colour, layout, a11y, perf,
 *   craft, process) and which aspect of it.
 * - `reason.*`: why something was rejected. These are the ones that generalise: a reason carries to a
 *   pattern the model has never seen, while an item-specific "no" carries nowhere. The owner asked for
 *   exactly this — learn why it was disliked, instead of refusing to explore the area again.
 *
 * COUPLINGS are the "connections": a feature that only fires when two tags co-occur, so the model can
 * represent "tight tracking is right with large type and wrong at body size" without a bias per pair
 * being written by hand. They cost a parameter each, which is why the lab reports what they do to
 * held-out accuracy rather than assuming they help.
 */

export const TAGS = [
  /* motion */
  "motion.ambient", "motion.pointer", "motion.entrance", "motion.costly",
  /* material */
  "material.soft", "material.hard", "material.tinted-neutral", "material.depth", "material.texture",
  /* type */
  "type.legibility",
  /* colour */
  "color.contrast-floor", "color.accent-discipline", "color.seeded",
  /* layout */
  "layout.measure", "layout.rhythm", "layout.responsive",
  /* accessibility */
  "a11y.focus", "a11y.semantics", "a11y.target-size",
  /* performance */
  "perf.weight", "perf.budget",
  /* craft: how the work is done */
  "craft.measure", "craft.explain", "craft.intent",
  /* process: boundaries and discipline */
  "process.no-shortcut", "process.consistency", "process.attribution", "process.boundary",
  "process.no-secrets",
  /* why it was rejected — the part that generalises */
  "reason.cost", "reason.intent-mismatch", "reason.legibility", "reason.consistency",
  "reason.generic-default", "reason.shortcut", "reason.trust",
] as const;

export type Tag = (typeof TAGS)[number];

/** Pairs that mean something together in a way neither tag means alone. */
export const COUPLINGS: [Tag, Tag][] = [
  ["motion.ambient", "motion.costly"],          // ambient motion that costs a full-frame repaint
  ["material.soft", "color.contrast-floor"],    // the tension this blog actually hit
  ["material.hard", "material.soft"],           // a hard field inside a soft palette
  ["perf.budget", "motion.costly"],
  ["layout.responsive", "a11y.target-size"],    // reachability on a phone
  ["type.legibility", "color.contrast-floor"],
  ["process.no-shortcut", "craft.measure"],     // discipline without measurement is theatre
  ["color.seeded", "color.accent-discipline"],
  ["layout.measure", "layout.rhythm"],
  ["material.tinted-neutral", "material.hard"],
  ["a11y.semantics", "a11y.focus"],
  ["craft.explain", "process.consistency"],
];

export const couplingId = (a: Tag, b: Tag): string => `${a}+${b}`;

/** The feature names a judgement activates. Couplings are off unless asked for. */
export function featuresOf(tags: Tag[], useCouplings: boolean): string[] {
  if (!useCouplings) return [...tags];
  const set = new Set<string>(tags);
  for (const [a, b] of COUPLINGS) {
    if (tags.includes(a) && tags.includes(b)) set.add(couplingId(a, b));
  }
  return [...set];
}

/** The tag a feature name came from, so a coupling's weight can be read under its parts. */
export function tagsOf(feature: string): Tag[] {
  return feature.includes("+") ? (feature.split("+") as Tag[]) : [feature as Tag];
}
