const MDN = (title, url) => ({
    title,
    url,
    license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
    adapted: false,
    change: "cited, not adapted",
});
const GOOGLE_FONTS = (family, slug) => ({
    title: `${family} (Google Fonts specimen)`,
    url: `https://fonts.google.com/specimen/${slug}`,
    license: "SIL Open Font License 1.1",
    adapted: false,
    change: "cited, not adapted — the family is recommended and the licence is the font file's, not the site copy's",
});
const WCAG = (fragment, title) => ({
    title,
    url: `https://www.w3.org/TR/WCAG22/#${fragment}`,
    license: "W3C Document License (no derivatives permitted)",
    adapted: false,
    change: "cited, not adapted",
});
const GATES = {
    title: "This server's mobile and performance gates",
    url: "https://github.com/MarkStock-it/Personal-MCP---UI-UX/blob/main/src/test/gates.ts",
    license: "private repository (internal, all rights reserved)",
    adapted: false,
    change: "cited, not adapted — the floors quoted here are the ones these gates enforce",
};
export const TYPE_TOPIC = {
    id: "typography",
    title: "Typography systems",
    summary: "How to build a type system that reads as art-directed rather than assembled: variable-font axes, a fluid ladder, measure and leading, structural voice contrast, the quiet label scale premium layouts live on, and the small details that make text look typeset. Reach for this whenever a page has more than one size of text.",
    entries: [
        {
            id: "variable-font-axes",
            name: "Variable font axes",
            intent: "Decide which variable axes carry the design and when animating one is worth its layout cost.",
            why: "One variable file can hold an entire typographic range, so hierarchy comes from the face itself instead of from extra families. That is the difference between a type system and a pile of fonts.",
            do: [
                "Pick one axis for character (usually optical size or width) and one for emphasis (weight), and leave every other axis at its default. Four moving axes at once is noise, not range.",
                "Let CSS do the work before you reach for font-variation-settings: font-weight sets wght, font-stretch sets wdth, font-style: oblique <angle> sets slnt, and font-optical-sizing: auto handles opsz. Use font-variation-settings only for axes with no property, or when you must set several at once.",
                "When you do use font-variation-settings, restate every axis you care about in the same declaration, including the ones you are not changing. It is a low-level override that replaces the defaults rather than inheriting them.",
                "Animate an axis only on short strings — one word, a headline of a few words — inside a requestAnimationFrame loop. Re-shaping text re-runs shaping and layout for that string on every frame.",
                "Always leave a resting value and a static fallback in the cascade, so the text is correctly styled before the webfont arrives and if it never does.",
                "Keep requested values inside the axis ranges declared in @font-face; outside that range the value is clamped or synthesized, and synthesized weights look cheap.",
            ],
            avoid: [
                "Animating an axis across an article's body copy: every animated frame can reflow every line in the block.",
                "Using font-variation-settings to set weight while the rest of the stylesheet uses font-weight — inherited and cascade behaviour then disagree.",
                "Treating a variable font as free: a wide axis range means a bigger file, so subset to the weights and ranges you actually ship.",
            ],
            pattern: `@font-face {
  font-family: "Display";
  src: url("/fonts/display.woff2") format("woff2-variations");
  font-weight: 200 800;          /* the ranges you actually ship */
  font-stretch: 75% 100%;
  font-optical-sizing: auto;
  font-display: swap;
}
.hero .c { font-weight: 250; font-stretch: 78%; }
/* JS: throttle axis animation to one write per frame, and cap the work */
const resting = 250;
function swell(letters, k) {          // k = 0..1 pointer proximity
  for (const l of letters)            // keep the list short
    l.style.fontVariationSettings = \`"wght" \${resting + 500 * k}, "wdth" \${78 + 22 * k}\`;
}`,
            params: {
                "display range": "wght 200-500, wdth 75-100% for a headline face",
                "axis animation budget": "assume ~1ms of layout per 20 animated glyphs per frame",
                "glyph cap": "under ~60 animated glyphs; above that animate transform instead",
            },
            verify: "Open DevTools' performance panel, record a pointer sweep, and watch the Recalculate Style / Layout rows while you move. Then enable prefers-reduced-motion: the axis must sit at one resting value with no per-frame work.",
            sources: [
                MDN("font-variation-settings", "https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings"),
                {
                    title: "Introducing variable fonts",
                    url: "https://web.dev/articles/variable-fonts",
                    license: "CC BY 4.0",
                    adapted: false,
                    change: "cited, not adapted",
                },
            ],
        },
        {
            id: "fluid-type-scale",
            name: "Fluid type ladder",
            intent: "Define one ladder of fluid sizes so every text element is visibly a step in a system rather than a number chosen by feel.",
            why: "Hand-picked sizes end up nearly identical to each other, which reads as accidental. A ladder produces deliberate ratio jumps, and that ratio contrast is most of what people read as designed.",
            do: [
                "Define six to eight steps and stop: label, caption, body, subhead, headline, display. Every size on the page must be one of them; a one-off 13.5px for a caption is how a system starts leaking.",
                "Use a reading ratio of 1.2 to 1.333 for the steps people read and 1.4 to 1.6 for display steps. Do not mix two ratios inside one ladder.",
                "Give every clamp() the same viewport range so the whole ladder scales in lockstep — minimum at 360px, maximum reached around 1200-1300px.",
                "Express the middle term as vw plus a rem offset (calc(1rem + 1.2vw)) rather than vw alone, so the type still grows for a reader who raises the root font size.",
                "Cap display steps with a hard rem maximum. Past roughly 130-140px on desktop a headline stops reading as text and starts reading as a poster.",
                "Set line-height per step, tightening as the size grows: about 1.7 at body, 1.25 at subhead, 1.0-1.1 at display.",
            ],
            avoid: [
                "A ladder whose smallest step lands under 11px — that fails this server's mobile gate for tiny text.",
                "Clamping with vw only (font-size: 4vw), which ignores user font-size preferences and shrinks text in a narrow window.",
                "Two display steps that are 10% apart: they read as a mistake, so either separate them properly or collapse them into one.",
            ],
            pattern: `:root {
  /* min at 360px  ->  max reached near 1100-1300px */
  --step--1: clamp(0.6875rem, 0.66rem + 0.12vw, 0.75rem);   /* 11 -> 12px  label   */
  --step-0:  clamp(1.0625rem, 1rem    + 0.28vw, 1.1875rem); /* 17 -> 19px  body    */
  --step-1:  clamp(1.25rem,   1.13rem + 0.53vw, 1.5rem);    /* 20 -> 24px  subhead */
  --step-2:  clamp(1.5rem,    1.28rem + 0.98vw, 2rem);      /* 24 -> 32px  title   */
  --step-3:  clamp(1.9rem,    1.45rem + 2vw,    3rem);      /* 30 -> 48px  head    */
  --step-4:  clamp(2.4rem,    1.5rem  + 4vw,    4.5rem);    /* 38 -> 72px  headline*/
  --step-5:  clamp(3rem,      1.2rem  + 8vw,    7.5rem);    /* 48 -> 120px display */
}`,
            params: {
                "reading ratio": "1.2-1.333 between label, body and subhead steps",
                "display ratio": "1.4-1.6 between subhead, title, head and display steps",
                "viewport range": "min 360px, max 1200-1300px, identical for every step",
                "display ceiling": "~120-140px; beyond that it reads as a poster, not type",
            },
            verify: "Measure each text element's computed font-size at 360px and at 1440px in a real browser. Every value should equal the min or the max in the ladder; anything in between that is not a ladder step is an off-system size.",
            sources: [
                WCAG("resize-text", "WCAG 2.2 SC 1.4.4 Resize Text (200% without loss)"),
                GATES,
            ],
        },
        {
            id: "readable-measure",
            name: "Readable measure",
            intent: "Keep the reading column inside the readable band and adjust leading and tracking as size changes.",
            why: "Too wide and the eye loses the line return; too narrow and prose feels like a form. Neither costs anything to fix, and both read instantly as unconsidered.",
            do: [
                "Set the measure in ch on the text container (max-width: 68ch), not in rem or px, so it stays stable when the webfont swaps or the weight changes.",
                "Target 60-75ch for prose, 45-60ch for a text column inside a two-column layout, and 30-45ch for a lede or pull quote.",
                "Never use one line-height for the whole system: about 1.6-1.75 for body, 1.25-1.35 for subheads, 1.0-1.15 for display.",
                "Track by size: roughly -0.02em to -0.04em above 32px, 0 at body size, and +0.02em to +0.06em below 14px or when text is set in uppercase.",
                "Let the measure collapse naturally on phones instead of with media queries. Full width minus padding at 390px is already close to 55ch at a modern body size.",
                "Put the empty space outside the text column, in the margin. Widening the paper is not the same as widening the measure, and only the second one ruins reading.",
            ],
            avoid: [
                "max-width in px on a paragraph: it drifts the moment the font or the root size changes.",
                "A heading allowed to run the full container width on a wide screen — a three-word headline stretched over 1400px is unreadable and looks unmade.",
                "Letter-spacing applied globally: it should change sign as the size changes, not have one value everywhere.",
            ],
            pattern: `.prose       { max-width: min(68ch, 100%); }
.prose p     { font-size: var(--step-0); line-height: 1.7; }
.lede        { max-width: 45ch; font-size: var(--step-2); line-height: 1.25; letter-spacing: -0.01em; }
h1           { max-width: 20ch; letter-spacing: -0.03em; line-height: 1.05; }
.label       { font-size: var(--step--1); letter-spacing: 0.06em; text-transform: uppercase; }
/* two-column reading: text column + margin column, empty space stays outside both */
.reading     { display: grid; grid-template-columns: minmax(0, 62ch) 16rem; gap: 3rem; }
@media (max-width: 52rem) { .reading { grid-template-columns: 1fr; gap: 1rem; } }`,
            params: {
                "prose measure": "60-75ch",
                "margin-column measure": "45-60ch",
                leading: "1.7 body / 1.35 subhead / 1.05 display",
                tracking: "-0.03em at 32px+, 0 at body, +0.05em at 11-14px",
            },
            verify: "In DevTools, count characters on the longest line of a paragraph (or measure the container's width in ch). Then force the fallback font and confirm the column width in pixels barely moves.",
            sources: [
                MDN("ch (unit)", "https://developer.mozilla.org/en-US/docs/Web/CSS/length#ch"),
                MDN("line-height", "https://developer.mozilla.org/en-US/docs/Web/CSS/line-height"),
            ],
        },
        {
            id: "voice-contrast",
            name: "Structural voice contrast",
            intent: "Pair a display face with a text face of a genuinely different structural class so hierarchy survives without extra weight or colour.",
            why: "Two similar grotesques at different sizes read as one font set wrong. A real class difference — serif against grotesque, wide against condensed — makes a page look art-directed before anyone reads a word.",
            do: [
                "Name the class difference out loud before you pair: serif against grotesque, wide against condensed, high contrast against low, geometric against humanist. If you cannot name it, it is not a pairing.",
                "Give the display face real jobs only: headlines, large numerals, pull quotes, and at most one label style. The text face handles everything read in sentences.",
                "Keep the display face to one or two sizes and let it be extreme there; keep the text face quiet and essentially one size.",
                "Make the contrast structural rather than a change of weight. Bold and regular inside one family is an emphasis change, not a second voice.",
                "Load the display face at the weights it actually looks good at — often 200-400 — instead of defaulting both faces to 700.",
            ],
            avoid: [
                "Two neo-grotesques with different names, which reads as an accident rather than a decision.",
                "Two members of the same superfamily presented as contrast: it is one voice with two widths of the same skeleton.",
                "Four families in one page. Voice contrast stops working after two, and three or four just look unresolved.",
            ],
            params: {
                "families": "two, maximum",
                "display sizes": "one or two steps only",
                "display weights": "often 200-400 at large sizes; heavy display at 120px reads as shouting",
            },
            verify: "Blur the page (screenshot and apply a strong blur, or squint) and check the hierarchy still reads. If the levels collapse into one texture, the pairing is not structurally different enough.",
            sources: [
                WCAG("visual-presentation", "WCAG 2.2 SC 1.4.12 Text Spacing (user spacing must not break layout)"),
                {
                    title: "Google Fonts catalogue (family licences)",
                    url: "https://fonts.google.com/",
                    license: "SIL Open Font License 1.1 for most families; check the individual family page",
                    adapted: false,
                    change: "cited, not adapted",
                },
            ],
        },
        {
            id: "quiet-label-scale",
            name: "The quiet label scale",
            intent: "Build the metadata scale — dates, topics, counts, section numbers — that premium layouts actually live on.",
            why: "Loud type is easy to copy, so it rarely differentiates anything. The small, evenly tracked, consistently numbered label is where a page proves the whole system was considered, all the way down to its numbering.",
            do: [
                "One size for all metadata, below body size and no smaller than 11px, which is the floor this server's mobile gate enforces.",
                "Positive tracking of +0.04em to +0.08em, with uppercase or small caps. Uppercase labels must never run long enough to become sentences.",
                "Pick a muted colour that still passes 4.5:1 against its background. A label too faint to read is not subtle, it is a contrast failure.",
                "Choose one separator and keep it everywhere: a middle dot between date and topic, an em dash before an attribution. Mixing separators in one list is the most common small inconsistency.",
                "Use tabular numerals for any count, date or index so digits sit on a stable column and nothing jitters when a number changes.",
                "Allow the label scale exactly one accent colour. Everything else in it stays ink or muted.",
            ],
            avoid: [
                "Grey-on-grey around 2.5:1, which disappears in daylight and fails contrast even though it looked fine on your display.",
                "A whole sentence in uppercase with wide tracking — that is a label style, not paragraph styling.",
                "A label wider than the content it annotates, which pulls the eye to the caption instead of the thing.",
                "Reserving one colour per row of metadata 'for variety' — a metadata column reads as a system only when it looks identical every time.",
            ],
            pattern: `.label {
  font-size: var(--step--1);
  line-height: 1.2;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-muted);            /* still >= 4.5:1 on the paper */
  font-variant-numeric: tabular-nums;
}
.meta { display: flex; gap: 0.5rem; align-items: baseline; font-weight: 500; }
.meta > * + *::before { content: "·"; margin-right: 0.5rem; color: var(--ink-faint); }`,
            params: {
                size: "11-13px, one value for all metadata",
                tracking: "+0.04em to +0.08em",
                "minimum contrast": "4.5:1 against the surface it sits on",
                "size floor": "11px (mobile gate); below that text is flagged",
            },
            verify: "Zoom to 200%, read every label aloud, and check that none of them breaks the line into three. Then run the mobile gate: no metadata may be flagged as under 11px.",
            sources: [WCAG("contrast-minimum", "WCAG 2.2 SC 1.4.3 Contrast (Minimum)"), GATES],
        },
        {
            id: "typographic-detail",
            name: "Typographic detail",
            intent: "Fix the small typographic details that separate typeset text from typed text.",
            why: "Each of these is invisible on its own, and together they are unmistakable: text with real punctuation, stable numerals and a straight optical margin reads as edited, and editing is what expensive-looking pages have in common.",
            do: [
                "Use tabular numerals for columns of numbers (dates, counts, prices, indices) and oldstyle numerals inside running prose, where lining figures sit too tall against the x-height.",
                "Type real punctuation: curly quotation marks, a true apostrophe, em dashes for breaks and en dashes for ranges. Search the source for a straight apostrophe and for a double hyphen before shipping.",
                "Hang punctuation on headings and pull quotes so the optical margin is straight. hanging-punctuation: first last where supported, with a small negative text-indent and matching padding as the fallback.",
                "Let the browser break headings evenly with text-wrap: balance on short blocks (two to four lines) and text-wrap: pretty on prose. Both remove a one-word last line for free and degrade harmlessly where unsupported.",
                "Keep font-kerning on and treat text-rendering: optimizeLegibility as a display-only tool; on a long page it can cost measurable paint time for a difference nobody can see.",
                "Write numbers the way the convention expects and keep them consistent across the page: a spaced unit in durations, no space before a percent sign.",
            ],
            avoid: [
                "text-wrap: balance on an entire article, where it is both unnecessary and relatively expensive to recompute.",
                "Smart-quote conversion inside a code block or an address, where the straight marks are the content.",
                "Decorative punctuation standing in for structure — a raised dot bullet list is not a substitute for a heading.",
            ],
            pattern: `.nums    { font-variant-numeric: tabular-nums; }
.prose   { font-variant-numeric: oldstyle-nums; text-wrap: pretty; }
h1, h2,
.quote   { text-wrap: balance; hanging-punctuation: first last;
           padding-left: 0.42em; text-indent: -0.42em; }  /* manual optical margin */
.quote::before { content: "\\201C"; margin-left: -0.42em; } /* hanging open quote */
code, .addr { font-variant-ligatures: none; }              /* keep straight marks */`,
            params: {
                "balance limit": "headings of 2-4 lines",
                "hang size": "~0.42em, matching the type size",
                dashes: "em dash for a break, en dash for a range",
            },
            verify: "Search the rendered text for a straight apostrophe, a straight quote and a double hyphen. Then toggle tabular numerals on a column of dates and watch whether the digits shift horizontally when a value changes.",
            sources: [
                MDN("text-wrap", "https://developer.mozilla.org/en-US/docs/Web/CSS/text-wrap"),
                MDN("hanging-punctuation", "https://developer.mozilla.org/en-US/docs/Web/CSS/hanging-punctuation"),
                MDN("font-variant-numeric", "https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric"),
            ],
        },
        {
            id: "font-pairing-recipes",
            name: "Four pairing recipes",
            intent: "Start from a reasoned pairing when the page needs a distinctive voice, instead of picking whichever face you saw last.",
            why: "Working from a structural reason avoids both failure modes at once: the trending face of the month, and the pairing everyone else has already shipped. Each recipe below states its contrast so you can adapt it rather than copy it.",
            do: [
                "Choose by the contrast and the mood you named first, then pick the recipe that matches. The pairings here are starting points, not sets to install verbatim.",
                "Skip Inter, Roboto, Arial, Helvetica, Open Sans, Lato, Poppins and Montserrat. They are widely available, and that is exactly the problem: this server's linter rejects them as display or body choices because a page set in them cannot signal any particular voice, and a spec of \"sans-serif\" says nothing about character either.",
                "Load only the weights you use, from one variable file per family where the family offers one, and name the axes in the @font-face ranges.",
                "Treat the fallback stack as part of the system: a serif display falls back to ui-serif plus a real serif, a grotesque text face to ui-sans-serif plus one broadly available grotesque. Never let a banned default be the primary choice.",
                "Preconnect or self-host so the webfont does not flash a fallback for a second, and choose fallbacks of similar width so the layout does not jump when the real face arrives.",
            ],
            avoid: [
                "Installing a recipe's four families at once — each recipe is two faces, and more than two voices in a page look unresolved.",
                "Judging a pairing from the specimen page only: render your own real headline and a paragraph before committing.",
            ],
            pattern: `/* A - soft editorial warmth: high-contrast serif display over a neutral grotesque */
/* Fraunces 300/600 (opsz, plus SOFT/WONK for a hand-set feel) + Instrument Sans 400/500 */
/* B - variable-width headline: the width axis does hierarchy that size alone cannot */
/* Bricolage Grotesque 250-700 (wdth 78-100) + Literata 400/600 (opsz) for the reading voice */
/* C - masthead contrast: one elegant high-contrast serif, everything else quiet */
/* Instrument Serif 400 (display only) + Schibsted Grotesk 400/600 for UI and prose */
/* D - airy and calm: a light serif at huge sizes over a rounded geometric text face */
/* Spectral 200/400 (opsz) + Manrope 400/600 */

:root {
  --font-display: "Fraunces", ui-serif, Georgia, serif;
  --font-text:    "Instrument Sans", ui-sans-serif, "Segoe UI", sans-serif;
  --font-label:   "Instrument Sans", ui-sans-serif, "Segoe UI", sans-serif;
}`,
            params: {
                "families": "2 (display + text); labels reuse the text face",
                "weights loaded": "2-3 per family maximum",
            },
            verify: "Render a real headline plus a paragraph in each candidate pairing at 390px and 1440px, then block the webfont (DevTools request blocking) and confirm the fallback keeps the layout from jumping.",
            sources: [
                GOOGLE_FONTS("Fraunces", "Fraunces"),
                GOOGLE_FONTS("Instrument Sans", "Instrument%20Sans"),
                GOOGLE_FONTS("Bricolage Grotesque", "Bricolage%20Grotesque"),
                GOOGLE_FONTS("Literata", "Literata"),
                GOOGLE_FONTS("Instrument Serif", "Instrument%20Serif"),
                GOOGLE_FONTS("Schibsted Grotesk", "Schibsted%20Grotesk"),
                GOOGLE_FONTS("Spectral", "Spectral"),
                GOOGLE_FONTS("Manrope", "Manrope"),
                {
                    title: "This server's anti-slop font rules",
                    url: "https://github.com/MarkStock-it/Personal-MCP---UI-UX/blob/main/src/rules.ts",
                    license: "private repository (internal, all rights reserved)",
                    adapted: false,
                    change: "cited, not adapted — names the banned default-AI faces this entry explains",
                },
            ],
        },
    ],
};
