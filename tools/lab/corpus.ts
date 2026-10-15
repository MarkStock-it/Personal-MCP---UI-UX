/**
 * The lab's corpus: real judgements, each with the reason it was made.
 *
 * WHERE THESE COME FROM
 * Every item is a decision that already exists in one of the two repos, quoted short and attributed
 * to its file. Nothing here is invented, and nothing is paraphrased into a nicer shape: the point is
 * to learn from what was actually decided, not from a tidy version of it.
 *
 * WHY EACH ITEM CARRIES A REASON
 * A rejection stored as a bare "no" turns into a blocklist, and a blocklist stops exploration. What
 * generalises is the REASON: "rejected because it costs a full-viewport repaint every frame" tells the
 * model something about a pattern it has never seen, while "rejected: shader" tells it nothing it can
 * transfer. So `reason` is required, and `tags` are the reason expressed in the feature vocabulary.
 *
 * THE LABELLING CAVEAT (read this before trusting a number)
 * Tag assignment here is done by an agent reading the artifacts, not by the owner pressing approve or
 * reject. That inflates the scores: part of what the model learns is the labeller's own consistency.
 * In production the labels arrive from explicit verdicts and the tags are proposed by the model and
 * confirmed by the owner. This corpus is a seed for the harness, not evidence about the owner.
 *
 * Label: +1 = kept, wanted, or adopted. -1 = rejected, avoided, or forbidden.
 */
import type { Tag } from "./vocabulary.js";

export interface Judgement {
  /** Stable id, cited in the report. */
  id: string;
  /** Which repo it came from, so cross-project transfer can be tested by leaving one out. */
  project: "blog" | "mcp";
  /** File the judgement is quoted from. */
  source: string;
  /** Short quote of the decision itself. */
  quote: string;
  /** Why it was decided, in the owner's own terms where possible. */
  reason: string;
  /** +1 kept/adopted, -1 rejected/forbidden. */
  label: 1 | -1;
  /** The reason expressed in the fixed vocabulary (see vocabulary.ts). */
  tags: Tag[];
}

export const CORPUS: Judgement[] = [
  /* ---------- the blog: decisions with reasons (handoff.md) ---------- */
  {
    id: "blog-water-surface", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "The one bold idea: give the pond real water. One fixed canvas paints slow bands of light and shade from a seeded noise field.",
    reason: "Implements a concept that was already named but never drawn, so the idea exists for a passive reader.",
    label: 1, tags: ["motion.ambient", "motion.pointer", "material.depth", "craft.intent"],
  },
  {
    id: "blog-reject-webgl", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Rejected: a WebGL/shader surface (weight, battery).",
    reason: "Costs weight and battery on the reader's device for an effect the canvas already achieves.",
    label: -1, tags: ["motion.costly", "perf.weight", "perf.budget", "reason.cost"],
  },
  {
    id: "blog-reject-scroll-descent", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Rejected: a scroll-driven descent (fights the calm).",
    reason: "The interaction fights the calm the page is built around.",
    label: -1, tags: ["motion.entrance", "material.soft", "reason.intent-mismatch"],
  },
  {
    id: "blog-text-never-blurred", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "The text layer is never blurred, translucent or scaled by depth's material. Depth is atmosphere; legibility is the floor.",
    reason: "A material effect must never be allowed to reduce legibility.",
    label: 1, tags: ["type.legibility", "color.contrast-floor", "material.depth", "reason.legibility"],
  },
  {
    id: "blog-ambient-fine-pointer", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Ambient drift runs continuously for fine pointers only and repaints at 15Hz when idle (60Hz while the pointer is active).",
    reason: "Keeps the surface alive where it is seen, and pays nothing where it is not.",
    label: 1, tags: ["motion.ambient", "perf.budget", "layout.responsive", "craft.measure"],
  },
  {
    id: "blog-reject-maxheight-anim", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Excerpts are always visible and clamped, instead of revealed by animating max-height (that shifted layout on hover).",
    reason: "The animation shifted layout, which is a cost the reader pays for decoration.",
    label: 1, tags: ["motion.entrance", "perf.budget", "layout.rhythm", "craft.measure"],
  },
  {
    id: "blog-title-clamp", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Pond titles clamp to 3 lines; the full text stays in the DOM and on the post page.",
    reason: "A shape cannot hold an arbitrary title, but the text must not be lost either.",
    label: 1, tags: ["layout.measure", "type.legibility", "layout.responsive"],
  },
  {
    id: "blog-tints-farthest-first", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Tints are assigned farthest-first (minimum hue distance) rather than hash % 6, which had allowed two posts to land on nearly the same colour.",
    reason: "Deterministic assignment that guarantees perceptual separation, instead of one that collides.",
    label: 1, tags: ["color.seeded", "color.accent-discipline", "craft.measure"],
  },
  {
    id: "blog-reject-harsh-fields", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Owner's rejection respected: no harsh/neon/high-contrast colour fields.",
    reason: "Hard colour fields are the opposite of the soft, calm palette the site is for.",
    label: -1, tags: ["material.hard", "color.accent-discipline", "reason.intent-mismatch"],
  },
  {
    id: "blog-soft-pastels", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Owner's favourites kept intact: soft watery pastels.",
    reason: "The palette the owner keeps coming back to.",
    label: 1, tags: ["material.soft", "material.tinted-neutral"],
  },
  {
    id: "blog-grain-saturate", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "body::after grain needs feColorMatrix saturate 0: feTurbulence is per-channel and is otherwise coloured speckle.",
    reason: "A one-line detail that decides whether the texture reads as grain or as confetti.",
    label: 1, tags: ["material.texture", "craft.explain", "craft.measure"],
  },
  {
    id: "blog-sync-first-frame", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Paint one water frame synchronously on load: the loop alone left a throttled tab blank.",
    reason: "Found by measuring a real failure mode, not by guessing.",
    label: 1, tags: ["craft.measure", "motion.ambient", "perf.budget"],
  },
  {
    id: "blog-no-build-step", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "Do not add a heavy dependency or a build step to the blog; it must stay one file.",
    reason: "A build step would cost more than the site gains, for a personal blog.",
    label: -1, tags: ["perf.weight", "process.no-shortcut", "reason.cost"],
  },
  {
    id: "blog-muted-ratio", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "muted text is #615C7D (5.12:1), it was #6C6788 at 4.34:1, which failed AA body text.",
    reason: "The old value was measured, found failing, and replaced with a number that passes.",
    label: 1, tags: ["color.contrast-floor", "craft.measure", "reason.legibility"],
  },
  {
    id: "blog-placeholder-opaque", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "A placeholder is text, so it has to clear 4.5:1 like any other; Chrome's default grey measured 4.49:1.",
    reason: "Convention is not an exemption; the default was measured and failed.",
    label: 1, tags: ["color.contrast-floor", "a11y.semantics", "craft.measure"],
  },
  {
    id: "blog-tap-target", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "line-height is 1, which left this link a 12px-tall tap target, so it takes vertical padding to reach 24px.",
    reason: "A nav link must be reachable by thumb, and the inline exception does not cover it.",
    label: 1, tags: ["a11y.target-size", "layout.responsive"],
  },
  {
    id: "blog-main-focus", project: "blog", source: "Personal-Blog/handoff.md",
    quote: "main is focusable, not focus-styled, and provides a skip link instead.",
    reason: "A ring around a whole page reads as a stray rule, so the accessible answer is the skip link.",
    label: 1, tags: ["a11y.focus", "a11y.semantics"],
  },
  {
    id: "blog-drop-ceiling", project: "blog", source: "Personal-Blog/server/src/page.html",
    quote: "A drop is capped: auto-fit collapses the empty tracks, so one published post took the whole row and grew taller than the screen.",
    reason: "Measured at 1464px on a 1728px laptop, so the layout needed a ceiling rather than a share.",
    label: 1, tags: ["layout.measure", "layout.responsive", "craft.measure"],
  },
  {
    id: "blog-proportional-inset", project: "blog", source: "Personal-Blog/server/src/page.html",
    quote: "The padding hangs off the drop's own width: a percentage padding resolved against the track, not the drop.",
    reason: "The inset must be a share of the thing being inset, or the shape stops being the shape.",
    label: 1, tags: ["craft.measure", "layout.measure", "craft.explain"],
  },
  {
    id: "blog-prose-wrap", project: "blog", source: "Personal-Blog/server/src/page.html",
    quote: "Prose wraps anywhere: a pasted 41-character URL pushed a 390px phone into a horizontal scroll.",
    reason: "Writer content must never be able to widen the page.",
    label: 1, tags: ["layout.responsive", "craft.measure", "type.legibility"],
  },

  /* ---------- the blog: process judgements (HANDOFF-admin-hang.md) ---------- */
  {
    id: "mcp-readonly-diagnosis", project: "blog", source: "Personal-Blog/HANDOFF-admin-hang.md",
    quote: "Do not fix anything, do not edit, commit or push, and do not weaken the CSP, the rate limits or the auth to make a test pass.",
    reason: "A diagnosis that changes the system cannot be trusted about the system.",
    label: 1, tags: ["process.no-shortcut", "craft.measure"],
  },
  {
    id: "blog-no-prod-restart", project: "blog", source: "Personal-Blog/HANDOFF-admin-hang.md",
    quote: "Never restart the production pm2 process without asking.",
    reason: "A deploy boundary exists so the owner keeps control of the live site.",
    label: 1, tags: ["process.no-shortcut", "process.boundary"],
  },
  {
    id: "blog-measured-vs-inferred", project: "blog", source: "Personal-Blog/HANDOFF-admin-hang.md",
    quote: "Separate what you measured from what you inferred.",
    reason: "An inference dressed as a measurement is how a wrong fix ships.",
    label: 1, tags: ["craft.measure", "craft.explain", "process.no-shortcut"],
  },
  {
    id: "blog-report-blocked", project: "blog", source: "Personal-Blog/HANDOFF-admin-hang.md",
    quote: "If a hypothesis cannot be tested from this machine, report it as blocked, not as passed.",
    reason: "An untested claim reported as passing is worse than no claim.",
    label: 1, tags: ["craft.explain", "craft.measure", "process.no-shortcut"],
  },
  {
    id: "blog-no-secret-printing", project: "blog", source: "Personal-Blog/HANDOFF-admin-hang.md",
    quote: "Never print ADMIN_PASSWORD_HASH, SESSION_SECRET or DB_PASSWORD; report only presence and length.",
    reason: "A secret that reaches a transcript has leaked, however local the transcript looks.",
    label: 1, tags: ["process.no-secrets", "process.boundary"],
  },
  {
    id: "blog-deploy-boundary", project: "blog", source: "Personal-Blog/HANDOFF-admin-hang.md",
    quote: "Anything touching the live host is read-only unless the owner approves otherwise.",
    reason: "Read-only until approved is the default that keeps a shared host safe.",
    label: 1, tags: ["process.boundary", "process.no-shortcut"],
  },

  /* ---------- the MCP repo: its own rules (AGENTS.md) ---------- */
  {
    id: "mcp-no-stdout", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Do not write to stdout in src/index.ts (it carries the protocol); use console.error.",
    reason: "A single stray line breaks the transport, so the rule matters more than the convenience.",
    label: -1, tags: ["process.no-shortcut", "craft.explain", "reason.consistency"],
  },
  {
    id: "mcp-no-node-modules", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Do not commit node_modules; two packages were tracked historically, do not add more.",
    reason: "Repository weight that every clone pays for.",
    label: -1, tags: ["perf.weight", "process.no-shortcut", "reason.cost"],
  },
  {
    id: "mcp-no-weakened-check", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Do not weaken a smoke check to make a build pass.",
    reason: "A gate that bends to a deadline stops being a gate.",
    label: -1, tags: ["process.no-shortcut", "craft.measure", "reason.trust"],
  },
  {
    id: "mcp-thresholds-agree", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Any threshold stated in src/playbook/floor.ts must match the numbers in the gates and the budgets in the config.",
    reason: "Two disagreeing numbers mean the documentation is lying about the system.",
    label: 1, tags: ["craft.measure", "process.consistency", "craft.explain"],
  },
  {
    id: "mcp-original-prose", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Write original prose. Never paste or closely paraphrase a source.",
    reason: "Knowledge can be learned from a source without taking its text.",
    label: 1, tags: ["process.attribution", "craft.explain"],
  },
  {
    id: "mcp-cite-only", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Cite only, never adapt text from: W3C/WAI, MDN, Apple HIG, Fluent 2, GSAP, Refactoring UI, easings.net.",
    reason: "Some licences forbid derivatives, so the boundary is which sources may be adapted at all.",
    label: 1, tags: ["process.attribution", "process.boundary"],
  },
  {
    id: "mcp-few-good-entries", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "Prefer few, usable entries over a data dump. No duplication between entries or topics.",
    reason: "Volume is not knowledge, and duplicates make the useful entry harder to find.",
    label: 1, tags: ["craft.explain", "process.consistency"],
  },
  {
    id: "mcp-one-place", project: "mcp", source: "Personal-MCP---UI-UX/AGENTS.md",
    quote: "src/rules.ts holds the original anti-default list; src/playbook/slop.ts builds on it; never duplicate those lists.",
    reason: "Rules that live in two places drift, and then neither is authoritative.",
    label: 1, tags: ["process.consistency", "craft.explain"],
  },

  /* ---------- the playbook: rejections, which is the design taste already written down ---------- */
  {
    id: "pb-reject-pure-extremes", project: "mcp", source: "src/playbook/color.ts",
    quote: "Pure #FFFFFF paper and pure #000000 ink: untinted extremes make every tinted colour beside them look dirty.",
    reason: "Untinted extremes make the family around them look wrong.",
    label: -1, tags: ["material.hard", "material.tinted-neutral", "reason.consistency"],
  },
  {
    id: "pb-reject-neon", project: "mcp", source: "src/playbook/color.ts",
    quote: "Saturation above about 60% at mid lightness on anything larger than an icon: that combination is what people mean by neon.",
    reason: "High saturation at scale is the specific thing that reads as neon.",
    label: -1, tags: ["material.hard", "color.accent-discipline", "reason.generic-default"],
  },
  {
    id: "pb-reject-two-accents", project: "mcp", source: "src/playbook/color.ts",
    quote: "Two mid-tone colours of similar lightness competing: that is two accents, and the page has no single focus.",
    reason: "Without a single focus the page has no hierarchy to read.",
    label: -1, tags: ["color.accent-discipline", "layout.measure", "reason.intent-mismatch"],
  },
  {
    id: "pb-reject-black-shadow", project: "mcp", source: "src/playbook/color.ts",
    quote: "A shadow colour taken from black; use a darker mix of the family so the shadow shares the page temperature.",
    reason: "A black shadow cools against a warm page and reads as a foreign element.",
    label: -1, tags: ["material.depth", "material.tinted-neutral", "reason.consistency"],
  },
  {
    id: "pb-reject-grey-placeholder", project: "mcp", source: "src/playbook/floor.ts",
    quote: "Light grey placeholder or caption text at 2-3:1 because 'it is not real content'. Placeholders and captions are text.",
    reason: "There is no such thing as text that does not need to be readable.",
    label: -1, tags: ["color.contrast-floor", "a11y.semantics", "reason.legibility"],
  },
  {
    id: "pb-reject-outline-none", project: "mcp", source: "src/playbook/floor.ts",
    quote: "outline:none with nothing in its place, which makes keyboard position unknowable.",
    reason: "Removing the only signal of keyboard position leaves keyboard users lost.",
    label: -1, tags: ["a11y.focus", "a11y.semantics", "reason.legibility"],
  },
  {
    id: "pb-reject-invert-first", project: "mcp", source: "src/playbook/color.ts",
    quote: "filter: invert() over the light theme as a first attempt.",
    reason: "A filter is a shortcut that flattens the palette instead of designing the dark theme.",
    label: -1, tags: ["material.hard", "process.no-shortcut", "reason.shortcut"],
  },
  {
    id: "pb-reject-modulo-tint", project: "mcp", source: "src/playbook/color.ts",
    quote: "TINTS[hash(id) % TINTS.length]: modulo over a small palette collides and near-collides routinely.",
    reason: "Assignment by modulo collides, so two items end up looking like the same thing.",
    label: -1, tags: ["color.seeded", "reason.consistency"],
  },
  {
    id: "pb-reject-fullbleed-accent", project: "mcp", source: "src/playbook/color.ts",
    quote: "Full-bleed accent section backgrounds on a soft palette: they reintroduce exactly the hard colour field the palette was built to avoid.",
    reason: "It undoes the palette's whole reason for existing.",
    label: -1, tags: ["material.hard", "material.soft", "layout.rhythm", "reason.intent-mismatch"],
  },
  {
    id: "pb-reject-tiny-target", project: "mcp", source: "src/playbook/floor.ts",
    quote: "A 16px icon button with no padding, which is a 16x16 hit area.",
    reason: "A hit area smaller than a fingertip cannot be used on a phone.",
    label: -1, tags: ["a11y.target-size", "layout.responsive", "reason.legibility"],
  },
  {
    id: "pb-reject-clean-run-faith", project: "mcp", source: "src/playbook/floor.ts",
    quote: "Treating a clean automated run as proof of accessibility: it proves the mechanical rules passed and nothing more.",
    reason: "A green run is evidence about the rules, not about the experience.",
    label: -1, tags: ["craft.measure", "a11y.semantics", "reason.trust"],
  },
  {
    id: "pb-reject-white-on-dark", project: "mcp", source: "src/playbook/color.ts",
    quote: "Keeping a pure-white component on a dark page; it becomes the brightest object and steals the hierarchy.",
    reason: "The brightest object wins attention, so an unimportant one must not be it.",
    label: -1, tags: ["material.hard", "material.depth", "layout.measure"],
  },

  /* ---------- the playbook: the keeps, so the corpus is not only rejections ---------- */
  {
    id: "pb-keep-contrast-floor", project: "mcp", source: "src/playbook/floor.ts",
    quote: "Use 4.5:1 for body text, 3:1 for large text and UI edges.",
    reason: "Named numbers that can be checked, rather than a direction to make it readable.",
    label: 1, tags: ["color.contrast-floor", "craft.measure", "type.legibility"],
  },
  {
    id: "pb-keep-compositor-only", project: "mcp", source: "src/playbook/floor.ts",
    quote: "Stick to compositor-only properties and manage layer count; state what the effect does under prefers-reduced-motion.",
    reason: "Motion that stays on the compositor is cheap, and the reduced-motion answer is part of the design.",
    label: 1, tags: ["perf.budget", "motion.ambient", "a11y.semantics", "layout.responsive"],
  },
  {
    id: "pb-keep-stagger", project: "mcp", source: "src/playbook/motion.ts",
    quote: "Stagger 40-80ms between related elements.",
    reason: "A specific range that reads as one gesture rather than a queue.",
    label: 1, tags: ["motion.entrance", "layout.rhythm", "craft.measure"],
  },
  {
    id: "pb-keep-tinted-neutrals", project: "mcp", source: "src/playbook/color.ts",
    quote: "Tint neutrals toward the brand hue so greys belong to the family.",
    reason: "Untinted greys fall out of the palette and read as a mistake.",
    label: 1, tags: ["material.tinted-neutral", "material.soft", "reason.consistency"],
  },
  {
    id: "pb-keep-line-length", project: "mcp", source: "src/playbook/layout.ts",
    quote: "Cap line length at 80 characters, measured in the actual typeface.",
    reason: "The measure is the one typographic number a reader feels immediately.",
    label: 1, tags: ["layout.measure", "type.legibility", "craft.measure"],
  },
  {
    id: "pb-keep-verify-in-browser", project: "mcp", source: "src/playbook/types.ts",
    quote: "Fill verify whenever the entry makes a claim that can be checked in a browser. Verification beats assertion.",
    reason: "A claim that can be checked should be checked.",
    label: 1, tags: ["craft.measure", "craft.explain"],
  },
];
