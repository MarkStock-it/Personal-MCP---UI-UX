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
export {};
