/**
 * Topic: slop — the anti-slop checklist.
 *
 * Two exports:
 *  - SLOP_TOPIC: the human-facing knowledge, six entries, read in order by a design agent
 *    before it starts inventing anything.
 *  - SLOP_CHECKS: the machine-facing equivalent. Each check is a line-oriented regex over
 *    source code, so `antislop_check` can point at a file and name what looks generated.
 *
 * The rules list and the banned typeface list are imported from ../rules.ts, not retyped.
 * That file is the single source of truth for "defaults to avoid": if the owner adds a rule
 * there, this topic's inventory and the concept/builder prompts all move together.
 */
import { BANNED_FONTS, BUILTIN_RULES, GENERIC_FONT_WORDS } from "../rules.js";
import type { SlopCheck, Topic } from "./types.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (list: string[]) => list.map(esc).join("|");

/**
 * system-ui is banned as a *display* choice, but it is a legitimate fallback at the end of a
 * stack, so it is handled by its own leading-position check instead of the named-family one.
 */
const NAMED_BANNED = BANNED_FONTS.filter((f) => f !== "system-ui");
const BANNED_ALT = alt(NAMED_BANNED);
/** Generics that only count as a smell when they lead the stack. */
const GENERIC_FIRST_ALT = alt([...GENERIC_FONT_WORDS, "system-ui", "ui-sans-serif", "ui-serif"]);

/**
 * For every built-in "default to avoid", the concrete better move. Keyed by the rule id in
 * ../rules.ts so the default text itself is never duplicated here.
 */
const BETTER_MOVE: Record<string, string> = {
  "builtin-1": "Lead with the content itself: an off-centre masthead, one action, and the real object or scene where the hero image would sit.",
  "builtin-2": "Make one feature the subject — large and specific — and show the others as a quiet list beside it instead of three equal cards.",
  "builtin-3": "Use a gradient only when it stands for something (light, water, atmosphere), keep it low-chroma, and give the shapes real form and edge.",
  "builtin-4": "Build depth from overlap, scale and blur; keep at most one shadow token, for elements that genuinely float above the page.",
  "builtin-5": "Choose a display face with a visible opinion and set a scale with at least a 3x jump between the topic label and the loudest size.",
  "builtin-6": "Draw the two or three shapes the idea actually needs as SVG in the page's own palette, and delete the rest.",
  "builtin-7": "If you go dark, tune it by hand — desaturated surfaces, no pure black, no glow — and find the idea somewhere other than the colour scheme.",
  "builtin-8": "Let the header belong to the page: an inline masthead, or one quiet line of navigation that scrolls away with the content.",
  "builtin-9": "Quote one real person in their own words with a link to the source. With no real quote, cut the section rather than cast it.",
  "builtin-10": "Write from the real material — names, numbers, dates, what actually happened — and delete any sentence that could belong to another site.",
  "builtin-11": "Alternate loud and quiet sections, and let the gap between them change; identical spacing everywhere is what makes a page read as a template.",
};

/** The canonical inventory, generated from the rule list so it can never drift out of sync. */
const INVENTORY = BUILTIN_RULES.map(
  (r) => `${r.text} -> ${BETTER_MOVE[r.id] ?? "decide it on purpose and be able to say why."}`
);

const REPO_RULES = {
  title: "design-mcp anti-default rules list (this repository)",
  url: "https://github.com/MarkStock-it/Personal-MCP---UI-UX/blob/main/src/rules.ts",
  license: "unlicensed private project (no LICENSE file) — the owner's own source of truth",
  adapted: false,
  change: "cited, not adapted; read at runtime so this inventory cannot drift from the rule list",
};
const WEBDEV_PAINT = {
  title: "web.dev — avoid large, complex layouts and layout thrashing",
  url: "https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing",
  license: "CC BY 4.0",
  adapted: false,
  change: "cited, not adapted (cost of paint-heavy effects such as shadow and blur)",
};
const MDN_SHADOW = {
  title: "MDN — box-shadow",
  url: "https://developer.mozilla.org/en-US/docs/Web/CSS/box-shadow",
  license: "CC BY-SA 2.5 or later",
  adapted: false,
  change: "cited, not adapted",
};
const GOOGLE_FONTS = {
  title: "Google Fonts — catalogue and per-family licences",
  url: "https://fonts.google.com/",
  license: "each family under its own licence (mostly SIL OFL 1.1); the site itself is proprietary",
  adapted: false,
  change: "cited, not adapted; used to confirm a suggested family exists and to point at its licence",
};
const UNICODE_EMOJI = {
  title: "Unicode — full emoji list and emoji charts",
  url: "https://www.unicode.org/emoji/charts/full-emoji-list.html",
  license: "Unicode License v3",
  adapted: false,
  change: "cited, not adapted (emoji render differently per platform and are not a controllable icon system)",
};
const WHATWG_ALT = {
  title: "WHATWG HTML Standard — images, alt requirements and decorative images",
  url: "https://html.spec.whatwg.org/multipage/images.html",
  license: "CC BY 4.0",
  adapted: false,
  change: "cited, not adapted",
};
const WCAG_22 = {
  title: "WCAG 2.2 — contrast minimums, focus visible, target size",
  url: "https://www.w3.org/TR/WCAG22/",
  license: "W3C Document License (2023)",
  adapted: false,
  change: "cited, not adapted; only the numeric thresholds are used",
};
const ARIA_APG = {
  title: "ARIA Authoring Practices Guide",
  url: "https://www.w3.org/WAI/ARIA/apg/",
  license: "W3C Document License (2023)",
  adapted: false,
  change: "cited, not adapted",
};
const FTC_ENDORSEMENTS = {
  title: "FTC Guides Concerning the Use of Endorsements and Testimonials in Advertising (16 CFR Part 255)",
  url: "https://www.ftc.gov/business-guidance/resources/guides-concerning-use-endorsements-testimonials-advertising",
  license: "US federal government work (public domain under 17 U.S.C. 105)",
  adapted: false,
  change: "cited, not adapted; used only to note that invented testimonials and metrics carry a real cost",
};

export const SLOP_TOPIC: Topic = {
  id: "slop",
  title: "Anti-slop checklist",
  summary:
    "The defaults that make work read as generated, each paired with the concrete better move, plus six entries on the underlying causes: borrowed typefaces, fake depth, placeholder material, template structure and dishonest copy. Work through this before adding anything new — subtraction is the larger part of the job.",
  entries: [
    {
      id: "defaults-inventory",
      name: "Defaults inventory",
      intent:
        "Audit a finished or half-finished page against the canonical list of generated-looking defaults, and replace each hit with the specific better move.",
      why:
        "A page that avoids the common defaults is already in the top slice of what gets shipped, because most work is assembled from these eleven parts without anyone deciding. Going through the list in order also stops the audit drifting into taste arguments.",
      do: [
        ...INVENTORY,
        "Audit in two passes: first mark every hit, then fix in order of how much page area the default occupies.",
        "This list is read from src/rules.ts at runtime, so it is also what the concept and builder prompts are told to avoid — one list, one fix per rule.",
      ],
      avoid: [
        "Treating the list as a ban on the individual parts: a shadow, a grid or a gradient is fine when it was chosen. The tell is repetition without a reason.",
        "Adding a distinctive effect to outvote the remaining defaults. Remove first; the page gets shorter, not busier.",
      ],
      verify:
        "Screenshot the page, then search the built output for each pattern in SLOP_CHECKS (antislop_check). A page can pass every regex and still feel generic — finish with the critique_rubric pass.",
      sources: [REPO_RULES, WEBDEV_PAINT],
    },
    {
      id: "banned-typefaces-and-why",
      name: "Typefaces that signal default output",
      intent:
        "Choose type deliberately: the handful of families that arrive by default are the loudest single signal that nobody decided anything.",
      why:
        "Inter, Roboto and friends are competent — the problem is that they are evidence of no choice, and readers have seen them on ten thousand generated pages. A face with a visible opinion costs nothing extra and immediately makes the page feel authored.",
      do: [
        `Treat these as banned for display and body roles: ${NAMED_BANNED.join(", ")} — plus any stack that leads with a generic (${[...GENERIC_FONT_WORDS, "system-ui"].join(", ")}) instead of a real family.`,
        "Reach for contrast instead: a variable grotesque with width or optical axes, a serif with genuine thick-thin modulation, or a condensed face for loud moments.",
        "Pair across structural classes — grotesque with serif, wide with condensed — rather than two similar grotesques, which reads as a mistake rather than a pairing.",
        "Confirm the family exists and note its licence before recommending it; Google Fonts families are mostly SIL OFL 1.1, and the fallback decides what happens when the font fails — so end the stack with a generic, never start it.",
        "Keep generic and system families at the end of the stack as fallbacks; that is the one place they belong.",
      ],
      avoid: [
        "`font-family: system-ui` for anything large: the page renders differently on every operating system, so the design is uncontrolled at exactly the size where it is most visible.",
        "Choosing a face because it is fashionable this year. Look for the axis the concept needs — width for tension, weight range for swelling headlines, optical size for long text.",
      ],
      pattern:
        "/* the shape to aim for: a real family first, generics only as the safety net */\n--font-display: \"Bricolage Grotesque\", ui-sans-serif, system-ui, sans-serif;\n--font-body:    \"Literata\", Georgia, serif;\n\n/* variable axes do the work that a second font would otherwise have to */\nh1 { font-variation-settings: \"wght\" 300, \"wdth\" 78; }",
      verify:
        "Set the page offline and screenshot it: the fallback stack must still look intentional. Disable webfonts in DevTools if the layout falls apart without them.",
      sources: [REPO_RULES, GOOGLE_FONTS],
    },
    {
      id: "fake-depth",
      name: "Fake depth",
      intent:
        "Replace shadows, glass and gradient blobs with real layering when a page reads flat, since those three are usually the symptom rather than the cure.",
      why:
        "Depth in a photograph comes from overlapping planes, scale difference and blur that increases with distance. A drop shadow is a cheap imitation of that, and when every surface carries one, the eye stops reading depth entirely.",
      do: [
        "Build a three-plane stack first: a field behind everything, the subjects sitting in it, and the voice (text) in front. Overlap the planes and vary their scale.",
        "Spend on one shadow token at most, reserved for elements that genuinely float — a popover, a dragged card. Never on cards resting on the page.",
        "Blur is depth, so use it as a distance cue: near things sharp, far things softer. It is a paint cost, so animate it only when the layer is not scrolling.",
        "Keep gradient fills meaningful and low-chroma: a wash of the page's own hue reads as light or water, while a purple-to-blue field reads as decoration.",
        "Give every plane a different drift or offset amplitude, so overlapping layers can never move as one flat sheet.",
      ],
      avoid: [
        "`backdrop-filter` as the default surface treatment — it costs a compositor pass per scrolled frame and is the single most recognisable generated-navbar look.",
        "A blurred, saturated shape sitting in a corner with no relationship to the content: it is decoration pretending to be depth.",
      ],
      pattern:
        "/* one plane stack, three cues for distance */\n.field  { filter: blur(0px);   opacity: 1;   }  /* ambient, behind everything */\n.subject{ filter: blur(1.5px); opacity: .9;  }  /* mid, drifts most */\n.voice  { filter: none;        opacity: 1;   }  /* text, never blurred */\n\n@media (prefers-reduced-motion: reduce) { .subject { filter: blur(1px); } }",
      params: {
        "shadow tokens": "1 (popovers only); 0 for resting surfaces",
        "plane count": "3 — field, subject, voice",
        "blur range": "0 / 1-2px / 6px+, increasing with distance",
      },
      verify:
        "DevTools → Rendering → Paint flashing, then scroll: a plane that repaints every frame is being blurred on the main thread. Also count `box-shadow` declarations in the source — a number close to the number of sections is the tell.",
      sources: [WEBDEV_PAINT, MDN_SHADOW, REPO_RULES],
    },
    {
      id: "placeholder-materials",
      name: "Placeholder material",
      intent:
        "Remove or replace every piece of filler that stands in for content — lorem text, cast testimonials, invented numbers, emoji icons and empty alt text.",
      why:
        "Filler is the fastest way for a page to look unfinished, and readers spot it in the first seconds. Real material is also what makes a design distinctive: the copy, numbers and names are the only content no other site can copy.",
      do: [
        "Delete the section rather than fake it: if there is no real quote, metric or testimonial, the page is stronger without the empty slot.",
        "Draw icons as SVG in the page's own palette, or use exactly one icon set consistently. Emoji render differently on every platform, cannot take your colour, and cannot be sized optically.",
        "Write alt text for purpose, not appearance: describe what the image is doing in that context, and give genuinely decorative images an empty `alt=\"\"` so assistive tech skips them.",
        "Replace invented percentages and counts with numbers you can defend and date, or remove the claim.",
        "Keep the fallback visible: if a post, image or feed fails to load, show honest empty copy with a next action rather than a blank frame.",
      ],
      avoid: [
        "`alt=\"image\"`, `alt=\"placeholder\"` and file-name alt text — worse than an empty alt, because it is announced and useless.",
        "Stock-style portraits beside a quote: readers read them as invented, which quietly devalues every other claim on the page.",
      ],
      pattern:
        '<figure>\n  <img src="frame-04.webp" width="1200" height="800" loading="lazy"\n       alt="The frame after the third weld, still hot.">\n  <figcaption>Frame 04, TIG-welded 4130 chromoly.</figcaption>\n</figure>\n\n<!-- decorative: no alt text, no role, no title -->\n<svg aria-hidden="true" focusable="false"> … </svg>',
      params: {
        "icon set": "1, drawn in-house (SVG) — emoji: 0",
        "invented metrics": "0 — every number dated and attributable",
      },
      verify:
        "Search the built output for `lorem`, `ipsum`, `alt=\"image\"`, and the trust-signal phrases in SLOP_CHECKS. Size images in DevTools: a missing width/height shows up as layout shift on load.",
      sources: [WHATWG_ALT, UNICODE_EMOJI, REPO_RULES],
    },
    {
      id: "template-structure",
      name: "Template structure",
      intent:
        "Rebuild the section order and the spacing rhythm from the content, so the page cannot be mistaken for the standard hero-to-footer stack.",
      why:
        "The familiar skeleton — header, hero, three features, testimonials, pricing, CTA, footer — is what makes a page forgettable regardless of how it is styled, because the reader already knows what is coming and stops looking.",
      do: [
        "Derive the section list from the material: what must be shown, in what order does a reader need it, and which section can only exist here.",
        "Give consecutive sections different shapes. Never place two identical three-column layouts next to each other, and usually not on the same page at all.",
        "Vary the gap between sections deliberately — a tight pair reads as one thought, a large gap reads as a chapter break. Identical spacing on every seam is the template tell.",
        "Make one section structurally surprising (a full-bleed plane, a single sentence on its own, a piece of content that breaks the column). That one is the memorable thing, so keep the rest quiet.",
        "Keep the quiet parts genuinely quiet — the page earns its loud moment by what it withholds elsewhere.",
      ],
      avoid: [
        "A uniform grid with the same gap on every section: it reads as an unstyled container rather than a composition.",
        "Spending the loud moment on decoration (a gradient, an animated blob) instead of on structure or content — decoration is what everyone else is doing too.",
      ],
      params: {
        "section gap ladder": "e.g. 4rem within a pair, 10-16rem at a chapter break",
        "consecutive identical layouts": "0",
        "loud sections": "1 per page",
      },
      verify:
        "Squint or blur the screenshot until text is unreadable: if the remaining blocks all have the same silhouette and rhythm, the page is still a template. Count distinct layout signatures per page.",
      sources: [REPO_RULES],
    },
    {
      id: "honest-copy-and-states",
      name: "Honest copy and real states",
      intent:
        "Treat any claim the interface cannot back, and any state the interface never designed, as a defect to fix rather than a placeholder to leave.",
      why:
        "An unverified claim in UI copy is not a rough edge, it is the interface lying: \"trusted by thousands\", a subscribe form that thanks the reader while sending nothing, a counter that shows 0 results with no next step. These are the failures users remember, and they undo the trust the rest of the page is trying to earn.",
      do: [
        "Delete or make true every claim: testimonials, ratings, uptime figures and customer counts must be real and attributable, since invented endorsements carry a legal cost as well as a trust cost.",
        "Never show a success state without a backend behind it. Either wire the form, or mark it clearly as a demonstration and disable the control — silence is better than a false confirmation.",
        "Design the states before the happy path: zero items, exactly one item, many items, loading, error, offline, and very long content (a 120-character title, a 6,000-word post).",
        "Give every empty state a next action, not just a message: \"Nothing here yet — here is the archive\" beats \"No results\".",
        "Keep error copy honest about what happened and what the reader can do, and never leave a spinner as the permanent state of a failed request.",
      ],
      avoid: [
        "A form that reports success client-side with no transport, no validation and no error path — the most common version of this defect.",
        "States written as afterthoughts: \"Something went wrong\" with no retry, or a loading skeleton that never resolves.",
      ],
      pattern:
        "/* the silent-success anti-pattern, in the smallest possible form */\nform.onsubmit = (e) => {\n  e.preventDefault();\n  msg.hidden = false;\n  msg.textContent = \"Thanks, you are subscribed.\"; // no request was made\n};\n\n/* honest version: say what is real, and keep the control usable */\n// <button type=\"submit\" disabled aria-describedby=\"demo-note\">Subscribe</button>\n// <p id=\"demo-note\">Demo only — no address is stored yet.</p>",
      params: {
        "designed states per interactive component": "at least 5 (empty, one, many, loading, error)",
        "unverified claims": "0",
      },
      verify:
        "Throttle the network to Offline and submit every form: the page must not claim success. Then render each list with 0, 1 and many items and check the layout holds.",
      sources: [FTC_ENDORSEMENTS, WCAG_22, ARIA_APG],
    },
  ],
};

/**
 * Machine-detectable defaults. `pattern` is a JavaScript regular-expression source applied
 * line by line to source files (CSS, HTML, JS/TS/JSX), compiled as new RegExp(pattern, flags ?? "i").
 * These are scent, not proof: a match means "look at this and be able to justify it".
 */
export const SLOP_CHECKS: SlopCheck[] = [
  {
    id: "font-named-default",
    what: "banned default typeface named in a font stack",
    pattern: `font-family\\s*:[^;\\n]*(?:${BANNED_ALT})\\b`,
    instead:
      "Pick a family with a visible opinion (a variable grotesque with width/optic axes, a modulated serif, or a condensed display) and end the stack with a generic fallback.",
    severity: "high",
  },
  {
    id: "font-generic-first",
    what: "font stack leads with a generic or system family",
    pattern: `font-family\\s*:\\s*["']?(?:${GENERIC_FIRST_ALT})\\b`,
    instead:
      "Lead with the real family and let generics sit at the end of the stack. A generic lead means the page renders differently on every platform.",
    severity: "low",
  },
  {
    id: "lorem-ipsum",
    what: "lorem ipsum filler text",
    pattern: "lorem ipsum|dolor sit amet|consectetur (?:adipiscing|elit)",
    instead: "Write the real sentence, or delete the block. If the content does not exist yet, that is a content problem, not a design one.",
    severity: "high",
  },
  {
    id: "marketing-cliches",
    what: "generated-sounding marketing copy",
    pattern:
      "welcome to |unlock the (?:power|potential)|elevate your|revolutioniz|supercharge|empower your|game[- ]chang|cutting[- ]edge|next[- ]level|unleash (?:your|the)|\\bseamlessly\\b",
    instead:
      "Say the specific thing. Replace the claim with the fact behind it (a number, a name, a date), or cut the line — this vocabulary appears on every generated page.",
    severity: "high",
  },
  {
    id: "gradient-purple-indigo",
    what: "purple-to-blue gradient fill",
    pattern:
      "(?:linear|radial|conic)-gradient\\([^)]*(?:#(?:6366f1|4f46e5|4338ca|7c3aed|8b5cf6|a855f7|6d28d9|818cf8|a78bfa)\\b|indigo|purple|violet|fuchsia)",
    instead:
      "Use a gradient only where it stands for light, water or atmosphere, keep it low-chroma, and derive it from the page's own dominant hue rather than a second colour family.",
    severity: "high",
  },
  {
    id: "tw-purple-utility",
    what: "default Tailwind purple/indigo palette or gradient utilities",
    pattern:
      "(?:\\bbg-gradient-to-\\w+\\b|\\b(?:bg|from|via|to|text|border|ring)-(?:indigo|purple|violet|fuchsia)-(?:400|500|600|700)\\b)",
    instead:
      "Define the palette as tokens with a reason (a dominant hue, an accent, tints of the dominant) and stop importing the framework's default ramp.",
    severity: "medium",
  },
  {
    id: "gradient-blob",
    what: "floating blurred gradient blob",
    pattern: "(?:blur-(?:2xl|3xl)\\b[^\\n]*rounded-full|rounded-full[^\\n]*blur-(?:2xl|3xl)\\b)",
    instead:
      "Give the shape a real silhouette and a relationship to the content, or build depth with overlapping planes, scale and blur instead of an abstract blob.",
    severity: "high",
  },
  {
    id: "large-css-blur",
    what: "very large blur radius",
    pattern: "filter\\s*:\\s*blur\\(\\s*(?:[5-9]\\d|\\d{3,})px",
    instead:
      "Keep large radii for genuinely distant planes and make sure the blurred layer does not repaint while scrolling. If it is decoration, a soft low-opacity shape costs far less.",
    severity: "medium",
  },
  {
    id: "three-identical-columns",
    what: "three equal columns, the classic feature-card row",
    pattern: "(?:\\bgrid-cols-3\\b|md:grid-cols-3|lg:grid-cols-3|repeat\\(3,\\s*(?:minmax\\([^)]*\\)|1fr))",
    instead:
      "Make one item the subject (larger, specific) and present the rest as a quiet list beside it. If three columns are genuinely right, make their sizes unequal so the row has a centre of gravity.",
    severity: "medium",
  },
  {
    id: "centered-hero-stack",
    what: "centered hero block",
    pattern: "(?:hero|masthead)[^\\n]{0,40}text-center|text-center[^\\n]{0,40}(?:hero|masthead)",
    instead:
      "Give the masthead an edge to align to — the same edge as the content below it. Centring everything removes the asymmetry that makes a page feel composed.",
    severity: "medium",
  },
  {
    id: "primary-secondary-cta",
    what: "the paired primary/secondary call to action",
    pattern: "\\b(?:primary|secondary)\\s*(?:Button|Btn|Cta|CTA)\\b",
    instead:
      "One action, given real weight. A second button beside it splits attention; demote it to a text link or delete it.",
    severity: "low",
  },
  {
    id: "radius-magic-number",
    what: "one magic border radius reused as the only rounding",
    pattern: "border-radius\\s*:\\s*(?:8px|10px|12px|16px|20px|24px)\\b",
    instead:
      "Define a small radius scale (for example 2 / 6 / 14 / 999) and use it deliberately so rounding carries meaning rather than decorating everything equally.",
    severity: "low",
  },
  {
    id: "shadow-default-soft",
    what: "the ubiquitous soft drop shadow",
    pattern: "box-shadow\\s*:\\s*0\\s+\\d+px\\s+(?:1[0-9]|[2-9]\\d)px\\s+rgba?\\(",
    instead:
      "Reserve one shadow token for elements that actually float. For resting surfaces use overlap, scale or a subtle edge instead of a large soft shadow.",
    severity: "medium",
  },
  {
    id: "tw-shadow-utility",
    what: "framework shadow utilities used as a surface treatment",
    pattern: "\\bshadow-(?:md|lg|xl|2xl)\\b",
    instead:
      "Count how many elements carry a shadow. If it is most of them, remove them all and rebuild depth from layering.",
    severity: "low",
  },
  {
    id: "glass-backdrop",
    what: "backdrop blur used as a surface treatment",
    pattern: "backdrop-filter\\s*:\\s*[^;\\n]*blur|\\bbackdrop-blur(?:-\\w+)?\\b",
    instead:
      "Let surfaces be solid and quiet. Glass blur costs a compositor pass every scrolled frame and is the most recognisable generated-navbar look in existence.",
    severity: "high",
  },
  {
    id: "sticky-topbar",
    what: "sticky or fixed top bar",
    pattern: "position\\s*:\\s*sticky|\\bsticky\\s+top-0\\b|\\bfixed\\s+(?:top|inset)-0\\b",
    instead:
      "Let the header scroll away with the content. A permanently pinned bar spends the reader's most valuable screen space on navigation they rarely need.",
    severity: "medium",
  },
  {
    id: "neon-glow",
    what: "neon glow standing in for an idea",
    pattern: "(?:text-shadow|drop-shadow)\\s*:\\s*0\\s+0\\s+\\d+px|drop-shadow-\\[0_0_\\d+px",
    instead:
      "Drop the glow and solve the hierarchy with lightness and scale. Glow is a substitute for having nothing else to say about the surface.",
    severity: "high",
  },
  {
    id: "pure-black-white",
    what: "pure black or pure white as ink or paper",
    pattern:
      "(?:#000(?:000)?\\b|#fff(?:fff)?\\b|rgba?\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*[,)]|rgba?\\(\\s*255\\s*,\\s*255\\s*,\\s*255\\s*[,)])",
    instead:
      "Bias both with a hue: a tinted paper and a dark ink with the same hue family. Pure values flatten the page and clash with every tinted surface.",
    severity: "medium",
  },
  {
    id: "emoji-as-icon",
    what: "emoji used as icon content in markup",
    pattern: ">\\s*[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}]",
    flags: "iu",
    instead:
      "Draw the icon as SVG in your own palette, or use a single icon set consistently. Emoji cannot hold your colour size or weight and render differently per platform.",
    severity: "high",
  },
  {
    id: "emoji-in-source",
    what: "emoji in source or copy",
    pattern: "[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]",
    flags: "iu",
    instead:
      "Confirm it is not standing in for an icon or a claim. Decorative novelty is fine; a rocket where a custom mark should be is filler.",
    severity: "low",
  },
  {
    id: "circular-avatars",
    what: "uniform circular avatars beside quotes",
    pattern: "rounded-full[^\\n]{0,40}(?:avatar|w-(?:8|10|12|14)\\b)|(?:avatar|testimonial)[^\\n]{0,40}rounded-full",
    instead:
      "Quote one real person in their own words with a link, or show no portrait at all. A row of evenly sized circular avatars reads as cast, not real.",
    severity: "medium",
  },
  {
    id: "testimonial-section",
    what: "a testimonials section",
    pattern: "\\btestimonials?\\b",
    instead:
      "Keep the one quote that is real and specific, attribute it, and remove the carousel. If nothing is real, cut the section.",
    severity: "low",
  },
  {
    id: "invented-trust-signals",
    what: "unverifiable social proof or metrics",
    pattern:
      "trusted by|as seen (?:in|on)|\\b\\d{1,3}(?:,\\d{3})?\\+? (?:happy )?(?:customers|users|clients|teams)\\b|99\\.9%|#1 ",
    instead:
      "Replace with a number you can date and attribute, or delete the line. Landlord-and-invented-endorsement claims carry a real legal and trust cost, not just a taste one.",
    severity: "medium",
  },
  {
    id: "placeholder-alt",
    what: "placeholder or file-name alt text",
    pattern: "alt\\s*=\\s*[\"'](?:image|img|photo|picture|placeholder|screenshot|icon|logo)[\"']",
    instead:
      "Describe the image's purpose in this context, or use alt=\"\" for genuinely decorative images so assistive tech skips them entirely.",
    severity: "high",
  },
  {
    id: "fake-form-success",
    what: "form reports success that is not backed by a request",
    pattern: "(?:thanks|thank you)[^\"'`]{0,60}(?:subscribed|signed up|we'?ll be in touch|on the list)",
    instead:
      "Wire the submission, or label the control as a demonstration and disable it. A false confirmation is a defect, not a placeholder — check for an actual fetch in the same handler.",
    severity: "high",
  },
  {
    id: "outline-none-without-focus",
    what: "focus outline removed with no replacement on that line",
    pattern: "(?!.*focus)(?:outline\\s*:\\s*(?:none|0\\b)|\\boutline-none\\b)",
    instead:
      "Never remove the focus ring without supplying a visible replacement (:focus-visible with an outline, ring or underline). If you already provide one, keep it and verify by tabbing.",
    severity: "medium",
  },
  {
    id: "transition-all",
    what: "transition on every property",
    pattern: "transition\\s*:\\s*all|\\btransition-all\\b",
    instead:
      "Name the properties: transform, opacity, background-color, color. Transitioning everything animates layout properties and causes jank on the frames that matter.",
    severity: "medium",
  },
  {
    id: "infinite-animation",
    what: "endless animation with no reduced-motion escape",
    pattern: "(?:animation[^;\\n]*infinite)|\\banimate-(?:spin|ping|bounce|pulse)\\b",
    instead:
      "Give the loop a stopping condition, and disable or freeze it under prefers-reduced-motion. A spinner is fine; an ambient loop that never ends is not.",
    severity: "medium",
  },
  {
    id: "uniform-section-padding",
    what: "identical vertical padding on every section",
    pattern: "(?:padding\\s*:\\s*(?:4|5|6|7|8)rem\\s+0|\\bpy-(?:16|20|24|28|32)\\b)",
    instead:
      "Vary the gap between sections: a tight pair reads as one thought, a large gap as a chapter break. Uniform spacing is why a page reads as a stack of blocks.",
    severity: "medium",
  },
  {
    id: "todo-in-shipped-source",
    what: "TODO/FIXME left in shipped source",
    pattern: "\\b(?:TODO|FIXME|XXX)\\b[:\\s]",
    instead:
      "Resolve it or move it into the issue tracker. A TODO in production code marks work that is knowingly unfinished, and in user-facing copy it is a visible defect.",
    severity: "low",
  },
];
