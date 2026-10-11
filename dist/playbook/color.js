/**
 * Colour for calm, expensive-looking interfaces.
 *
 * The through-line: hierarchy comes from lightness, emphasis comes from one accent,
 * and every surface is derived from a single paper colour so the page keeps one
 * temperature. Saturation is not the dial to turn — chroma at mid lightness is what
 * reads as loud.
 */
export const COLOR_TOPIC = {
    id: "color",
    title: "Colour systems",
    summary: "How to build a soft, coherent palette: one hue-biased dominant, exactly one accent, surfaces derived from a single paper colour, and the contrast floor that keeps it readable. Reach for this before choosing any hex.",
    entries: [
        {
            id: "soft-palette-recipe",
            name: "Soft palette recipe",
            intent: "When the palette has to feel calm and considered rather than bright — build the whole thing from lightness steps instead of saturation.",
            why: "A soft palette is not simply low-saturation colour: it is a wide lightness range with a narrow chroma range. Because the eye reads lightness long before it reads hue, hierarchy can be strong while no single colour is loud.",
            do: [
                "Pick one dominant near-neutral with a deliberate hue bias and keep its saturation between 5% and 15% — it supplies the temperature, not the colour.",
                "Commit to exactly one accent at mid chroma (35-55% saturation, 45-65% lightness). It carries every piece of emphasis on the page.",
                "Derive surfaces as lightness steps of the dominant, not as new hues: paper #F7F5FB, field #E9E6F3, edge #D8D3E8, ink #2B2742 all sit in one family (hue 250-260, saturation 24-45% at the dark end).",
                "Separate any two adjacent surfaces by at least 8 percentage points of lightness. Below that the boundary looks accidental rather than decided.",
                "Check the palette survives deleting the accent: if the page collapses without it, the accent was doing structural work and will read loud.",
                "Cap the whole palette at four hues including the ink, and give each one a role name (paper, field, edge, ink, accent) rather than a colour name.",
            ],
            avoid: [
                "Pure #FFFFFF paper and pure #000000 ink: untinted extremes make every tinted colour beside them look dirty.",
                "Two mid-tone colours of similar lightness competing — that is two accents, and the page has no single focus.",
                "Saturation above about 60% at mid lightness on anything larger than an icon; that combination is what people mean by neon.",
            ],
            params: {
                "dominant saturation": "5-15%",
                "accent saturation": "35-55%",
                "accent lightness": "45-65%",
                "minimum lightness step between surfaces": "8 percentage points",
                "total hues": "<= 4",
            },
            pattern: `:root{
  /* one family, wide lightness, narrow chroma */
  --paper:#F7F5FB; --field:#E9E6F3; --edge:#D8D3E8;
  --ink:#2B2742;   --muted:#5E5A78;   /* still >= 4.5:1 on --paper */
  --accent:#5B58C9;                    /* s52% l57%: emphasis only, never a field */
}
.card{
  background:var(--paper);
  border:1px solid var(--edge);
  color:var(--ink);
  box-shadow:0 1.5rem 3rem -1.5rem var(--edge); /* depth from the family, not from black */
}`,
            verify: "Run palette_check on the list and confirm every ink-on-surface pair is at least 4.5:1, that no colour comes back HARSH, and that the saturated hues span less than 150deg.",
            sources: [
                {
                    title: "WCAG 2.2 — Contrast Minimum (1.4.3) and Non-text Contrast (1.4.11)",
                    url: "https://www.w3.org/TR/WCAG22/#contrast-minimum",
                    license: "W3C Document License, 2023 version",
                    adapted: false,
                    change: "cited, not adapted — the 4.5:1 and 3:1 thresholds are spec facts quoted here in my own words; no W3C text or diagram is reproduced.",
                },
                {
                    title: "Material Components for Web (tonal palettes and colour roles)",
                    url: "https://github.com/material-components/material-web",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — the idea of roles over colour names and of a tonal ramp is re-expressed here; the worked palette and all numbers are mine.",
                },
                {
                    title: "IBM Carbon Design System (theme tokens built from lightness steps)",
                    url: "https://github.com/carbon-design-system/carbon",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — CSS in this entry is written from scratch for this playbook.",
                },
            ],
        },
        {
            id: "tint-and-shade-derivation",
            name: "Derive every surface from one paper",
            intent: "When a page has several near-white surfaces — cards, wells, sticky bars, washes — derive them all from one paper colour instead of picking greys by hand.",
            why: "Hand-picked greys drift in temperature and the page starts to look assembled from parts. Mixing every surface from one paper keeps a single temperature while still giving you as many steps as you need.",
            do: [
                "Define --paper once and never write another near-white literal anywhere in the stylesheet.",
                "Create lighter and darker surfaces with color-mix() against --ink, not with rgba(0,0,0,.05): a black overlay desaturates and cools the surface you are tinting.",
                "Mix in oklab (color-mix(in oklab, ...)) so intermediate steps stay perceptually even and do not dip through grey.",
                "Keep translucency for layers that genuinely overlap or float; for a static surface, mix the colour and use it opaque so contrast is measurable.",
                "If you do use alpha, always mix from the paper rather than transparent black, so the result stays on the palette's hue line.",
            ],
            avoid: [
                "rgba(0,0,0,.04) for a card on a tinted page — the card cools and greys away from the family.",
                "A shadow colour taken from black; use a darker mix of the family so the shadow shares the page temperature.",
                "More than four surface steps: past that the differences stop being legible as hierarchy.",
            ],
            params: {
                "light surface step": "color-mix(in oklab, var(--paper) 92%, var(--ink))",
                "dark surface step": "color-mix(in oklab, var(--paper) 88%, var(--ink))",
                "shadow colour": "a darkened mix of the family, not black",
            },
            pattern: `:root{
  --paper:#F7F5FB;
  --surface-1:color-mix(in oklab, var(--paper) 94%, var(--ink));
  --surface-2:color-mix(in oklab, var(--paper) 88%, var(--ink));
  --hairline: color-mix(in oklab, var(--paper) 78%, var(--ink));
  --shadow:   color-mix(in oklab, var(--paper) 45%, var(--ink));
}
/* a floating layer that must show through: mix from the paper, never from transparent black */
.glass{ background:color-mix(in oklab, var(--paper) 72%, transparent); }`,
            verify: "Sample each surface in devtools and check its hue sits within about 10deg of --paper's hue, and that each step differs by >= 8 percentage points of lightness.",
            sources: [
                {
                    title: "MDN — color-mix() and colour interpolation methods",
                    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "cited, not adapted — MDN is share-alike, so no wording is reused; the mixing approach and all CSS here are written from scratch.",
                },
                {
                    title: "CSS Color Module Level 4 (color-mix, oklab)",
                    url: "https://www.w3.org/TR/css-color-4/",
                    license: "W3C Document License, 2023 version",
                    adapted: false,
                    change: "cited, not adapted — used only to confirm syntax and that oklab is the perceptual interpolation space.",
                },
            ],
        },
        {
            id: "contrast-floor",
            name: "Contrast floor and the translucent trap",
            intent: "When text sits on anything other than plain paper — images, washes, gradients, tinted cards, sticky bars — decide what has to pass before you style it.",
            why: "Contrast is the one part of a soft palette that cannot be traded away for calm. Meeting it deliberately also makes quiet text possible: you can lower size, weight and position, but never the ratio.",
            do: [
                "Hold 4.5:1 for body text, 3:1 for large text (24px regular, or 18.66px bold — the WCAG thresholds in CSS pixels), and 3:1 for non-text UI edges: input borders, meaningful icons, chart strokes, and the focus ring.",
                "Keep muted text at or above 4.5:1 as well; aim for about 5:1. If you want 'quiet', move down in size, weight and hue instead of down in contrast.",
                "Measure translucent layers against their worst-case composite, not their average: a 12% black overlay on a light photo can still land near 2:1 under the brightest pixel.",
                "Check gradients at both extremes. If either end fails, stop the gradient short of that end rather than adding a text shadow.",
                "Require the focus ring to clear 3:1 against both the control it sits on and the surface behind it — a ring that matches the accent on an accent button is invisible.",
                "When a pair fails, change the ink or the surface. Do not shrink or embolden type to reach the 'large text' threshold instead.",
            ],
            avoid: [
                "Light grey placeholder or caption text at 2-3:1 because 'it is not real content'. Placeholders and captions are text.",
                "A tinted card that passes on paper but fails when it sits on the darker field behind it.",
                "Hairline borders at 1.5:1 doing the job of grouping or marking state — that edge is non-text content.",
            ],
            params: {
                "body text": ">= 4.5:1",
                "large text": ">= 3:1 (24px regular or 18.66px bold)",
                "non-text UI and focus ring": ">= 3:1 against adjacent colours",
                "muted body text target": ">= 5:1",
                "headroom for AAA body": "7:1",
            },
            verify: "Use palette_check for the static pairs, then in devtools audit any text over translucent or photographic layers by sampling the lightest and darkest pixel behind it and checking both.",
            sources: [
                {
                    title: "WCAG 2.2 — Contrast Minimum (1.4.3)",
                    url: "https://www.w3.org/TR/WCAG22/#contrast-minimum",
                    license: "W3C Document License, 2023 version",
                    adapted: false,
                    change: "cited, not adapted — threshold values only, restated in CSS-pixel terms.",
                },
                {
                    title: "WCAG 2.2 — Non-text Contrast (1.4.11)",
                    url: "https://www.w3.org/TR/WCAG22/#non-text-contrast",
                    license: "W3C Document License, 2023 version",
                    adapted: false,
                    change: "cited, not adapted — used to confirm which UI edges the 3:1 requirement covers.",
                },
                {
                    title: "web.dev — Accessible color and contrast",
                    url: "https://web.dev/articles/color-and-contrast",
                    license: "CC BY 4.0",
                    adapted: false,
                    change: "cited, not adapted — consulted for the practical framing of contrast on layered surfaces; no sentence is reused.",
                },
            ],
        },
        {
            id: "warm-versus-cool-neutral",
            name: "Warm versus cool neutral",
            intent: "When choosing the paper colour — the single decision that sets the temperature of everything on the page.",
            why: "A consistent hue bias in the neutrals is one of the strongest signals of a designed page, because it makes surfaces, shadows and ink all look like they were chosen together. Mixing families across surfaces is the fastest way to look assembled from parts.",
            do: [
                "Choose one family for paper, fields and edges and keep it everywhere; a warm neutral (hue about 30-60) reads like stock and editorial, a cool neutral (hue about 220-260) reads like software and glass.",
                "Vary temperature inside the family only: shift lightness, and let hue drift by no more than about 10deg between the lightest and darkest surface.",
                "Give the ink the same bias as the paper — a warm paper with a blue-black ink looks like two palettes stacked. Warm paper pairs with warm ink: #FAF7F2 with #241F1A, cool paper with cool ink: #F7F8FB with #21242E.",
                "Let exactly one element jump families. A single warm accent on a cool page reads intentional; two jumps read unresolved.",
                "Match the accent's lightness to the surface it replaces so the temperature change does not also change the lighting.",
            ],
            avoid: [
                "A grey card on a warm page — it reads as a hole, because its bias fights the paper.",
                "A cool wash gradient over warm paper, which looks like a second brand.",
                "Untinted #EEE next to #F6EFE8: adjacent neutrals with different hue direction read as a mistake, not a step.",
            ],
            pattern: `/* warm editorial */
:root{ --paper:#FAF7F2; --field:#F1EBE3; --edge:#E2D9CD; --ink:#241F1A; }
/* cool technical */
:root[data-temperature=cool]{ --paper:#F7F8FB; --field:#EDEEF4; --edge:#DCDEE9; --ink:#21242E; }`,
            verify: "Screenshot the page at three scroll positions and compare the paper behind each: hue should stay within 10deg and only lightness should change.",
            sources: [
                {
                    title: "IBM Carbon Design System (neutral themes and surface tokens)",
                    url: "https://github.com/carbon-design-system/carbon",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — the hue-family argument and both palettes are original to this playbook.",
                },
                {
                    title: "Material Components for Web — colour system structure",
                    url: "https://github.com/material-components/material-web",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — consulted for how surfaces are grouped, not for wording.",
                },
            ],
        },
        {
            id: "dark-mode-rebuild",
            name: "Dark mode is a rebuild, not an inversion",
            intent: "When adding a dark theme to a light design — decide surfaces and accent again rather than flipping values.",
            why: "Inverting lightness makes a dark page that looks like a photographic negative: hue relationships are backwards and bright accents glare. Rebuilding the roles from the same idea keeps the design recognisable.",
            do: [
                "Get elevation from surface lightness, not from shadow: in dark, a raised surface is lighter than what is under it. A workable ladder is base #14131A, raised #1D1C25, overlay #262532.",
                "Desaturate fields by roughly 30-50% relative to their light-mode chroma; the same hue at the same saturation looks twice as loud on a dark surface.",
                "Re-tune the accent upward in lightness (about +10 percentage points) and check it again: it has to clear 4.5:1 against the dark surface, and it must not glare. Midnight indigo is not the same accent as mid-day indigo.",
                "Ban #000000 and #FFFFFF. Paper becomes about 92-96% lightness with a hue bias, so large areas of text do not vibrate against the background.",
                "Replace light-mode shadows with 1px hairlines at low alpha: shadows barely register on dark surfaces and only muddy them.",
                "Re-run the whole contrast matrix in dark mode — pairs do not transfer in either direction, and a bright accent that passed on paper often fails on a dark surface.",
            ],
            avoid: [
                "filter: invert() over the light theme as a first attempt.",
                "Keeping a pure-white component on a dark page; it becomes the brightest object and steals the hierarchy.",
                "Global luminance reduction via a filter on images, which flattens everything and destroys the palette.",
            ],
            params: {
                "surface ladder": "base / raised / overlay, each about 4-8 percentage points lighter",
                "field desaturation": "30-50% less saturation than light mode",
                "accent lightness shift": "about +10 percentage points",
                "text lightness": "92-96%, never 100%",
            },
            pattern: `:root{ --paper:#14131A; --surface-1:#1D1C25; --surface-2:#262532;
        --ink:#EDEAF5; --muted:#A9A5BE; --hairline:#332F42; --accent:#9C99F2; }
/* elevation replaces shadow */
.card{ background:var(--surface-1); box-shadow:none; border:1px solid var(--hairline); }
.sheet{ background:var(--surface-2); border:1px solid var(--hairline); }`,
            verify: "Toggle each theme and run palette_check on both sets of hexes; also open both in devtools and confirm no text falls below 4.5:1 and that the accent ring still clears 3:1 on its control.",
            sources: [
                {
                    title: "Material Components for Web (dark theme surface elevation)",
                    url: "https://github.com/material-components/material-web",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — the surface ladder and all hex values here are mine.",
                },
                {
                    title: "web.dev — dark mode guidance",
                    url: "https://web.dev/articles/prefers-color-scheme",
                    license: "CC BY 4.0",
                    adapted: false,
                    change: "cited, not adapted — consulted for prefers-color-scheme handling; no wording reused.",
                },
            ],
        },
        {
            id: "per-item-colour-hash",
            name: "Colour per item, without collisions",
            intent: "When every item in a set — post, tag, chart series, avatar, lane — needs its own colour, and the set size can change.",
            why: "Hashing straight into a palette looks arbitrary the moment two neighbours land on near-identical tints. Choosing the farthest available slot keeps the set looking deliberate at any count, and freezing the result in the data stops the page reshuffling colour when order changes.",
            do: [
                "Curate a palette of 6-8 tints that share one lightness and one chroma band and differ only in hue, so no item is visually privileged (for a soft palette: lightness about 86-88%, hue steps of 30-45deg).",
                "Assign farthest-first: hash the item's id to a starting index, then walk forward and take the free slot with the largest minimum hue distance to the slots already used in that view.",
                "Enforce a floor on that distance — at least 25deg of hue, or roughly 12 in OKLab perceptual distance — and step to the next slot when a candidate is closer than the floor.",
                "Freeze the result: store the chosen tint on the item rather than recomputing it per render, so filtering, sorting and pagination never change an item's colour.",
                "When the item count exceeds the palette, reuse slots but keep any two items that appear in the same view at least one slot apart.",
                "Give low-contrast tints a darker companion for the text or mark drawn on them; check the pair at 4.5:1 and the tint against the page at 3:1 if it carries meaning.",
            ],
            avoid: [
                "TINTS[hash(id) % TINTS.length] — modulo over a small palette collides and near-collides routinely.",
                "Recolouring on filter or search: the same item changing colour between views destroys the reader's memory of it.",
                "A palette whose members differ in lightness as well as hue, which makes two items look different sizes or weights.",
            ],
            params: {
                "palette size": "6-8 slots",
                "hue step between slots": "30-45deg",
                "minimum usable hue distance": ">= 25deg (about 12 OKLab)",
                "soft tint band": "lightness 86-88%",
            },
            pattern: `const PAL = ['#F4C7D4','#C5E0D0','#F6D9B8','#DCCDF0','#C9D3F7','#F3E7B0'];

const hueOf = (hex: string) => { // sRGB -> hue in degrees
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

/** hash -> first free slot -> the free slot farthest from everything already used */
function tintFor(id: string, used: string[], minGap = 25) {
  let seed = 7; for (const c of id) seed = ((seed * 31 + c.charCodeAt(0)) >>> 0);
  const free = PAL.filter((c) => !used.includes(c));
  if (!free.length) return PAL[seed % PAL.length];
  const distance = (c: string) => Math.min(...used.map((u) => {
    const d = Math.abs(hueOf(c) - hueOf(u)); return Math.min(d, 360 - d);
  }), 360);
  const best = free.map((c) => ({ c, d: distance(c) })).sort((a, b) => b.d - a.d)[0];
  return best.d >= minGap ? best.c : free[seed % free.length];
}`,
            verify: "With a real set (say 6 items), print the assigned tints and every pairwise hue distance: each pair in one view should be at least 25deg apart and every item should keep its colour after re-sorting.",
            sources: [
                {
                    title: "WCAG 2.2 — Non-text Contrast (1.4.11), for tints that carry meaning",
                    url: "https://www.w3.org/TR/WCAG22/#non-text-contrast",
                    license: "W3C Document License, 2023 version",
                    adapted: false,
                    change: "cited, not adapted — the algorithm, palette and thresholds in this entry are original.",
                },
            ],
        },
        {
            id: "accent-in-small-doses",
            name: "Accent in small doses",
            intent: "When an accent colour keeps making a calm interface feel cheap or harsh, and you need to decide where it is allowed to appear.",
            why: "A single saturated colour is powerful in inverse proportion to how much of it you use. Reserved for small marks, it reads as intent; spread over a section background it reads as a template.",
            do: [
                "Budget the accent to a small share of the pixels — roughly a few percent of a screen. Treat anything larger as a deliberate, one-per-page exception.",
                "Give it specific jobs and let those be the only places it appears: one word in a headline, a 2px rule under a heading, the link underline, the focus ring, one chip or badge, the progress arc, and the active state of a control.",
                "When it must become a surface, desaturate to 35% or less and lift lightness to about 85% so it turns into a wash rather than a slab, then check the ink on it at 4.5:1.",
                "Use the accent to mark the single next action on the screen; if two things are accented, the page has two primary actions and neither wins.",
                "Keep body text out of the accent. It is a mark, not a voice — the ink colour does the reading.",
            ],
            avoid: [
                "Full-bleed accent section backgrounds on a soft palette: they reintroduce exactly the hard colour field the palette was built to avoid.",
                "Accent-coloured body copy or captions, which turns emphasis into noise.",
                "Accent-coloured large buttons plus accent icons plus accent links on one screen, which leaves no hierarchy at all.",
            ],
            params: {
                "accent share of pixels": "roughly a few percent",
                "accent-as-surface saturation": "<= 35%",
                "accent-as-surface lightness": "about 85%",
                "accents per screen": "1",
            },
            pattern: `.hd-accent{ color:var(--ink) }
.hd-accent em{ font-style:normal; box-shadow:inset 0 -.5em 0 var(--accent-wash) } /* one word */
.rule{ height:2px; width:3.5rem; background:var(--accent) }
:focus-visible{ outline:2px solid var(--accent); outline-offset:3px }
.chip[aria-pressed=true]{ background:var(--accent-wash); color:var(--ink) }`,
            verify: "Screenshot the page, blur it, and look for the saturated colour: it should appear in a handful of small marks. If it forms any large block, that is the accent doing structural work.",
            sources: [
                {
                    title: "IBM Carbon Design System (accent usage and surface roles)",
                    url: "https://github.com/carbon-design-system/carbon",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — consulted on how accents are scoped; the pixel budget and rules are mine.",
                },
                {
                    title: "web.dev — Color and contrast",
                    url: "https://web.dev/articles/color-and-contrast",
                    license: "CC BY 4.0",
                    adapted: false,
                    change: "cited, not adapted — no wording reused.",
                },
            ],
        },
    ],
};
