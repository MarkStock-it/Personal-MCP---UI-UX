/**
 * The design playbook: curated, offline design knowledge for premium, dynamic interfaces.
 *
 * WHY THIS EXISTS
 * The rest of this server generates and tests *websites*. This module is the missing
 * half: the knowledge a design agent needs while it is choosing motion, colour, type,
 * layout and material — plus the deterministic checks that keep it honest. Everything
 * here is static data, so it works with no API keys and no network.
 *
 * HOW TO WRITE AN ENTRY (keep this bar — these entries are read by future design agents)
 * - Original prose only. Explain the reasoning in your own sentences; never paste or
 *   closely paraphrase text from a source. Sources are recorded for provenance, not copied.
 * - Be specific and opinionated. "Use 4.5:1 for body text, 3:1 for large text and UI edges"
 *   beats "make sure contrast is good". Numbers, names and thresholds, not vibes.
 * - Short: `intent` one line, `why` two sentences at most, `do` 3-6 imperatives,
 *   `pattern` under ~25 lines, and only the parameters that actually get tuned.
 * - Fill `verify` whenever the entry makes a claim that can be checked in a browser
 *   (a measurement, a keyboard pass, a reduced-motion pass). Verification beats assertion.
 * - No duplication across entries or topics. If two entries overlap, keep one and
 *   cross-reference it by id.
 * - Respect the accessibility and performance floor: any motion or effect you suggest
 *   must say what it does under `prefers-reduced-motion` and what it costs per frame.
 *
 * SOURCES AND LICENCES (see the repo's source-usage rules)
 * - `adapted: true` ONLY when wording or code was actually derived from the source, and
 *   then `change` is required and the licence must permit adaptation.
 * - Safe to adapt, with attribution recorded: Google developer docs / web.dev (CC BY 4.0),
 *   Material Components repos and IBM Carbon repo (Apache-2.0), Motion (MIT),
 *   Robert Penner's easing set (BSD-3-Clause/MIT).
 * - Cite only, do NOT adapt text from: W3C/WAI documents (W3C Document License forbids
 *   derivatives), MDN (CC BY-SA share-alike), Apple Human Interface Guidelines, Microsoft
 *   Fluent 2, GSAP docs, Refactoring UI, Josh Comeau, easings.net (GPL-3.0). Put
 *   "cited, not adapted" in `change` when you merely consulted such a source.
 * - General ideas, spec numbers (a contrast ratio, a target size) and standard easing
 *   vocabulary are facts, not copyrightable text — express them yourself and cite where
 *   you learned them.
 */

/** Where a piece of knowledge came from, and on what terms. */
export interface Source {
  /** Short description, e.g. "WCAG 2.2 contrast minimums". */
  title: string;
  url: string;
  /** Exact licence name, or "proprietary / all rights reserved" when it is not open. */
  license: string;
  /** True only if prose or code was actually adapted from this source. */
  adapted: boolean;
  /** Required when adapted; otherwise say "cited, not adapted" and what you took from it. */
  change?: string;
}

/** One unit of design knowledge. */
export interface Entry {
  /** kebab-case, unique within its topic, stable — other entries reference it. */
  id: string;
  /** Short human name, 2-5 words. */
  name: string;
  /** One line: the problem this solves and when to reach for it. */
  intent: string;
  /** Why it reads as premium rather than decorative. Two sentences at most. */
  why: string;
  /** 3-6 imperative rules. Concrete and checkable. */
  do: string[];
  /** Optional failure modes, each naming what it looks like when it goes wrong. */
  avoid?: string[];
  /** Optional short code pattern (CSS, JS, SVG, GLSL). Plain text, no fences, under ~25 lines. */
  pattern?: string;
  /** Optional tunable numbers mapped to their meaning, e.g. { "stagger": "40-80ms" }. */
  params?: Record<string, string>;
  /** Optional: how to check the claim in a real browser. */
  verify?: string;
  sources: Source[];
}

/** A topic groups related entries and maps to one knowledge resource. */
export interface Topic {
  /** stable kebab-case id, also the resource path and tool argument. */
  id: string;
  title: string;
  /** One or two lines on what the topic covers and who it is for. */
  summary: string;
  entries: Entry[];
}

/** A machine-detectable design default that signals generic, unexamined work. */
export interface SlopCheck {
  id: string;
  /** What is being detected, in a few words. */
  what: string;
  /** Regular expression source, applied line by line (case-insensitive unless you set `flags`). */
  pattern: string;
  /** Optional ripgrep-style flags for the compiled RegExp, e.g. "i" or "im". */
  flags?: string;
  /** What to do instead. Must be a concrete better move, not "don't do that". */
  instead: string;
  /** "high" = this alone makes a design look generated; "medium" = contributes; "low" = worth a look. */
  severity: "high" | "medium" | "low";
}

/** One scored section of the design critique rubric. */
export interface RubricSection {
  id: string;
  title: string;
  /** Relative weight in the total score; all weights should sum to roughly 100. */
  weight: number;
  /** What the reviewer looks for. */
  lookFor: string[];
  /** Concrete failure signs to call out. */
  flag: string[];
  /** How to verify with evidence rather than opinion. */
  verify: string;
  /** Score anchors from 0 (bad) to 4 (excellent), exactly five strings. */
  anchors: [string, string, string, string, string];
}
