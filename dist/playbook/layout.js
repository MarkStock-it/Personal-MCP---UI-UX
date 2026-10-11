export const LAYOUT_TOPIC = {
    id: "layout",
    title: "Layout, rhythm and density",
    summary: "Structure beyond the card grid: choosing an archetype from what the content actually is, building rhythm, depth and reading measure, giving a page a top and a bottom, and designing the states a collection really has — empty, one, many, loading, error and absurdly long.",
    entries: [
        {
            id: "beyond-card-grids",
            name: "Archetypes beyond the card grid",
            intent: "Reach for this when a page holds more than a handful of items (posts, projects, products, people) and your hand is already moving toward a uniform grid of equal cards.",
            why: "Equal cards declare that every item is interchangeable, which is almost never true and never memorable. A structure that mirrors the items' real relationship — sequence, rank, place, accumulation — makes the page feel built for this material rather than filled with it.",
            do: [
                "Choose the archetype from the content's relationship, not from habit. Ledger/list: text-first items read in order. Rail plus detail: one chosen item beside a browsing column. Stepped or asymmetric sequence: a reading order you want to control. Scattered field: items with no inherent order that should feel like a place. Pinned plus flowing: a persistent object (cover, chart, map) beside changing detail. Masthead plus column: one loud statement, then a calm column. Timeline or stack: items whose order or accumulation IS the point.",
                "Give items different scale, shape or weight according to real rank — one featured item at two to three times the area of the rest. Uniform scale across all items is the tell.",
                "Keep one alignment spine even when the items are irregular: a shared left edge, a baseline grid, or a common column count. Irregularity against a spine reads as composed; irregularity without one reads as an accident.",
                "Change the pattern with the count: one item at full measure, two or three at generous scale, four and up denser. Never let the structure require exactly N items to look right (see designed-edge-cases).",
                "Let every item carry a different amount of information, and make the difference visible: a featured item with a real excerpt and a small item with only a title is more alive than three identical cards.",
            ],
            avoid: [
                "A three-column auto-fit grid where every cell is a title, a two-line description and an image placeholder — the most recognisable generated layout there is.",
                "Rotated or diagonally offset items with no shared spine: it reads as jitter, not composition.",
            ],
            pattern: `/* a 12-column spine with deliberate rank, not an auto-fit of equal cells */
.pond{display:grid;grid-template-columns:repeat(12,1fr);gap:clamp(1rem,2vw,2rem)}
.item{grid-column:span 4}
.item[data-rank="1"]{grid-column:span 7;grid-row:span 2}
.item[data-rank="2"]{grid-column:span 5}
@media (max-width:48rem){.item,.item[data-rank]{grid-column:1/-1}}`,
            params: {
                spine: "12 columns for flexible asymmetry; 6 is enough if you never need thirds",
                "size steps": "three distinct item sizes is plenty; more looks arbitrary",
                gap: "clamp(1rem,2vw,2rem)",
            },
            verify: "Screenshot three widths and count the distinct item sizes. Then reorder the data: if the result looks equally good with the items shuffled, the structure is not expressing rank.",
            sources: [
                {
                    title: "U.S. Web Design System — component and template patterns",
                    url: "https://designsystem.digital.gov/",
                    license: "Public domain (CC0 1.0) with some third-party exceptions",
                    adapted: false,
                    change: "cited, not adapted — consulted for how content-first layout patterns are documented",
                },
                {
                    title: "CSS Grid Layout Module Level 2",
                    url: "https://www.w3.org/TR/css-grid-2/",
                    license: "W3C Document License (no derivatives permitted)",
                    adapted: false,
                    change: "cited, not adapted — grid-template-columns and span syntax is a spec fact",
                },
            ],
        },
        {
            id: "rhythm-and-density",
            name: "Rhythm: loud, quiet, and a spacing scale",
            intent: "Use when a page is tidy and correct but feels monotonous — every section the same height, the same gap, the same weight, so nothing stands out.",
            why: "Rhythm is what a reader experiences as 'this page knows what it is doing'. Uniform gaps and uniform section sizes remove all emphasis at once, and a page with no emphasis leaves no memory.",
            do: [
                "Alternate loud and quiet. A loud section earns one outlier scale (full-bleed, oversized type, a single object at 2-3x); the section after it is mostly empty space. Never two loud sections in a row.",
                "Use one spacing scale and jump steps on purpose: 4, 8, 12, 16, 24, 40, 64, 104 (px, or 0.25/0.5/0.75/1/1.5/2.5/4/6.5rem). Nothing crosses the scale.",
                "Make section gaps at least two steps larger than the biggest gap inside a section, so grouping is unambiguous: 24px inside, 64-104px between.",
                "Vary section padding by importance rather than repeating one value. If every section has 80px top and bottom, the page is one continuous band.",
                "Account for the largest empty area on the page and say what it is for. If you cannot justify it in one sentence, it is leftover space: add content or remove it.",
            ],
            avoid: [
                "The same `padding: 80px 0` on every section — the clearest single tell of a generated layout.",
                "Adding more type sizes instead of more space: density comes from spacing, and a page with six font sizes is not denser, just noisier.",
            ],
            pattern: `:root{
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:40px; --s7:64px; --s8:104px;
}
.section{padding-block:var(--s7)}
.section.quiet{padding-block:var(--s8)}
.section.loud{padding-block:var(--s8);}      /* + a scale outlier, not just more padding */
.stack>*+*{margin-top:var(--s5)}              /* inside a section: tight */
@media (max-width:40rem){:root{--s7:40px;--s8:64px}}`,
            params: {
                scale: "4 / 8 / 12 / 16 / 24 / 40 / 64 / 104",
                "section gap": "2-3 steps above the largest inner gap",
                "loud sections per page": "1-2 maximum",
            },
            verify: "Screenshot the full page, zoom out to 25% and squint: a repeating band pattern means the spacing is uniform. Then read section paddings in devtools and confirm they are not all the same number.",
            sources: [
                {
                    title: "IBM Carbon Design System — spacing tokens (repository)",
                    url: "https://github.com/carbon-design-system/carbon",
                    license: "Apache License 2.0",
                    adapted: false,
                    change: "cited, not adapted — the published scale confirmed that stepped spacing is the norm; the eight values here are my own",
                },
                {
                    title: "U.S. Web Design System — spacing units",
                    url: "https://designsystem.digital.gov/design-tokens/spacing-units/",
                    license: "Public domain (CC0 1.0) with some third-party exceptions",
                    adapted: false,
                    change: "cited, not adapted — consulted on a shared unit scale rather than per-component margins",
                },
                {
                    title: "Refactoring UI (Adam Wathan and Steve Schoger)",
                    url: "https://refactoringui.com/",
                    license: "Proprietary / all rights reserved",
                    adapted: false,
                    change: "cited, not adapted — the general principle that emphasis comes from scale contrast is widely published; no text taken",
                },
            ],
        },
        {
            id: "masthead-and-colophon",
            name: "Masthead and colophon",
            intent: "Use when a page has no top mark and no bottom, so it reads as a fragment loose in a window rather than a publication someone is responsible for.",
            why: "A masthead says who is speaking and where you are; a colophon says you have reached the end and what this thing is. Both are cheap, and together they are most of the difference between an authored page and a generated one.",
            do: [
                "Put a real top mark in the first screen — the publication or owner name, at most one navigational decision beside it, and no auto-hiding behaviour. If it sticks, it must stay out of the way of the content.",
                "End with a genuine footer: what this is in one sentence, how to follow or contact, the most recent entries, and the date of last update. Real content, not a copyright strip.",
                "Mark them semantically with a top-level `<header>` and `<footer>`: they map to the banner and contentinfo landmarks, which lets assistive technology jump straight to them.",
                "Make the footer a material echo of the page — same paper tone, same field colour, quieter type — so it reads as the page's floor rather than a bolted-on strip in a different palette.",
                "Let the colophon carry the quiet typographic scale (small tracked labels, tabular numerals for dates): it is the natural home for metadata and the place where a page's craft is most visible at rest.",
            ],
            avoid: [
                "A footer containing only a copyright line and social icons.",
                "A sticky blurred-glass bar as the top mark: it costs contrast on whatever scrolls under it and is on every generated site (see the anti-slop checklist).",
            ],
            pattern: `<header class="masthead">mark + at most one nav decision</header>
<main>…</main>
<footer class="colophon">
  <p class="what">What this is, in one sentence.</p>
  <nav aria-label="Recent entries">…most recent items…</nav>
  <p class="meta">Last updated 2026-10-11 · how to follow</p>
</footer>`,
            params: {
                "footer height": "roughly one sixth of the page height; shorter reads as an afterthought",
                "footer text": "0.8-0.9rem, tracked labels for the metadata rows",
                "top mark": "the owner or publication name, plus one decision — never a full menu in the first screen",
            },
            verify: "Tab from the top of the page: the mark and every footer action must be reachable and show a visible focus style. Inspect the accessibility tree for banner and contentinfo landmarks.",
            sources: [
                {
                    title: "WAI-ARIA Authoring Practices — landmark regions",
                    url: "https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/",
                    license: "W3C Document License (no derivatives permitted)",
                    adapted: false,
                    change: "cited, not adapted — the header/main/footer to landmark mapping is a spec fact",
                },
                {
                    title: "MDN — the footer element",
                    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/footer",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "cited, not adapted — consulted for element usage; no text reused",
                },
            ],
        },
        {
            id: "depth-layers",
            name: "Depth in three layers",
            intent: "Use when a page looks flat and cheap even though it is tidy — everything sitting on one plane with no sense of space in front of or behind it.",
            why: "Depth is what makes a page feel like a place rather than a document. Three layers separated by overlap, scale and softness cost nearly nothing to render and fix flatness that no amount of drop shadow will.",
            do: [
                "Compose in three named layers and decide which one owns each element before you style anything: field (the background surface or tone), subject (the objects the page is about), voice (the text being read).",
                "Separate the layers with the cheap tools first — overlap, scale contrast, softness — and add a shadow only when an element genuinely sits above another one.",
                "Give each layer its own motion budget: the field moves least or not at all, the subject drifts a few pixels, the voice stays still. Nested parallax layers moving at similar speeds make a page feel seasick.",
                "Keep the text layer at full contrast on top of whatever the field is doing: anything placed behind text must be quiet enough that the contrast check still passes against the worst-case composite.",
                "Animate only transform and opacity on anything that moves so it stays on the compositor; never animate blur radius or box-shadow per frame.",
            ],
            avoid: [
                "A soft drop shadow under every element — it flattens rather than deepens, because everything ends up equally elevated.",
                "A field animation running at full strength behind text: it competes with the one layer that must stay legible.",
            ],
            pattern: `/* depth by overlap, scale and softness — not by shadow */
.field{position:fixed;inset:0;z-index:0}                 /* no motion, or one slow drift */
.subject{position:relative;z-index:1}                   /* crosses the field's edge by 8-15% */
.voice{position:relative;z-index:2;max-width:66ch}      /* full contrast, never blurred */
@media (prefers-reduced-motion:reduce){
  .field,.subject{transform:none!important;animation:none!important}
}`,
            params: {
                "layer motion": "field 0px / subject 4-26px of pointer or scroll drift / voice 0px",
                "subject overlap": "8-15% of the object's size past the field edge",
                "background softness": "one blur pass is enough; more reads as fog, not water",
            },
            verify: "Blur a screenshot by 8px: the three layers should still read as distinct depths. In the browser's paint panel, elements that move should show compositing rather than repaint or layout.",
            sources: [
                {
                    title: "web.dev — Animations guide (compositor-friendly properties)",
                    url: "https://web.dev/articles/animations-guide",
                    license: "Creative Commons Attribution 4.0 (CC BY 4.0)",
                    adapted: false,
                    change: "cited, not adapted — expressed in my own words that transform and opacity avoid repaint and layout",
                },
                {
                    title: "Material Design 3 — elevation and layering",
                    url: "https://m3.material.io/foundations/layout/understanding-layout/overview",
                    license: "Proprietary terms; page-level licence not verified",
                    adapted: false,
                    change: "cited, not adapted — consulted only for the idea that depth is a system-wide property, not a per-element effect",
                },
            ],
        },
        {
            id: "measure-and-margin-column",
            name: "Reading measure and a margin column",
            intent: "Use when body text runs the full width of a desktop window, or when annotations, captions and metadata belong beside one specific paragraph instead of interrupting the argument.",
            why: "A controlled measure is the most reliable single upgrade to a text page, and a margin column adds a second informational voice without breaking the argument. A note that answers to one paragraph reads as commentary; a note floating in space reads as decoration.",
            do: [
                "Set the body measure to 60-75 characters, using `ch` on the paragraph rather than a guessed pixel width — WCAG's visual-presentation criterion caps a line at 80 characters, so treat 80 as the hard limit.",
                "On wide screens use two asymmetric columns: the text column at its measure, plus a margin column roughly a third to a quarter of that width. Stack them on narrow screens.",
                "Attach every note to one element: top-align it with its paragraph, or draw a short leader rule toward it. If a note cannot name the sentence it belongs to, it is body text in the wrong place.",
                "Keep the note voice visibly quieter than the body — smaller, tighter leading, a tinted surface, two or three lines — so it never competes with the reading column.",
                "Never put the margin column where it squeezes the measure below about 45 characters, or where it sits beside the page's primary action.",
            ],
            avoid: [
                "Notes vertically centred or evenly distributed in their column, detached from the paragraph they annotate.",
                "A pixel max-width on the prose: it breaks at other zoom levels and text-size settings, where a character-based measure holds.",
            ],
            pattern: `/* measure first, then an attached margin note that stacks on small screens */
.reading{display:grid;grid-template-columns:minmax(0,66ch) minmax(12rem,18rem);
  gap:clamp(1.5rem,4vw,3.5rem)}
.reading p{max-width:66ch}
.note{align-self:start;font-size:.875rem;line-height:1.45}   /* top-aligned with its paragraph */
@media (max-width:52rem){
  .reading{grid-template-columns:1fr}
  .note{order:1}                       /* moves below its paragraph, with a marker */
}`,
            params: {
                measure: "60-75ch, hard cap 80ch",
                "margin column": "12-18rem at 1024px and up; 30-40% of the text column",
                "note type": "0.8-0.9rem with 1.4-1.5 leading, maximum three lines",
                "stack breakpoint": "52rem",
            },
            verify: "Count characters in the longest rendered line (or measure it and divide by the average character width): it must stay under 80. At 360px, confirm notes move below their own paragraph instead of compressing the prose.",
            sources: [
                {
                    title: "WCAG 2.2 — Visual Presentation (1.4.8), 80-character line limit",
                    url: "https://www.w3.org/TR/WCAG22/#visual-presentation",
                    license: "W3C Document License (no derivatives permitted)",
                    adapted: false,
                    change: "cited, not adapted — the 80-character cap is a requirement stated in the specification",
                },
                {
                    title: "Butterick's Practical Typography — line length",
                    url: "https://practicaltypography.com/line-length.html",
                    license: "Proprietary / all rights reserved",
                    adapted: false,
                    change: "cited, not adapted — consulted on the readable range; the numbers here come from the WCAG criterion",
                },
                {
                    title: "MDN — the aside element",
                    url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/aside",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "cited, not adapted — consulted for when a note is tangential rather than essential",
                },
            ],
        },
        {
            id: "designed-edge-cases",
            name: "Design the edge cases",
            intent: "Use before shipping any list, feed or collection view: decide what it does with zero, one and many items, while loading, on error, and with absurdly long content.",
            why: "Edge cases are where generated layouts fall apart, and real readers meet them far more often than the designer does. A layout that only looks right with exactly three items is unfinished, however good the screenshot.",
            do: [
                "Design six states explicitly and give each its own type, spacing and next action: empty (0 items), single item, many items, loading, error, and long content.",
                "Empty state: say what will appear here, why it is empty right now, and the one action that fills it. Never illustrate an empty box.",
                "Single item: do not strand it in a cell sized for a crowd. Widen it, or add the context that makes one item meaningful (its date, what else exists).",
                "Many items: set a limit. Twenty items in the treatment designed for three is a wall — add a grouping, a rhythm break, pagination, or progressive disclosure.",
                "Loading: reserve the exact space the content will occupy before it arrives so nothing jumps, and use a quiet skeleton at the real size and shape instead of a spinner in a void.",
                "Long content: test a 120-character title and a 60-character unbroken word, with `overflow-wrap:anywhere` on the container, and confirm nothing overlaps or overflows.",
            ],
            avoid: [
                "A grid that collapses to a single lonely cell with no explanation.",
                "A centred spinner with nothing reserved underneath, followed by a large layout shift when the data lands.",
            ],
            pattern: `/* reserve the space, then fill it — no jump when the data arrives */
.item{min-height:var(--item-h);overflow-wrap:anywhere}
.item.cell{width:var(--item-w);aspect-ratio:4/3}   /* skeleton uses the real box */
.state{display:grid;gap:var(--s3);justify-items:start}
.state.empty p{max-width:34ch}`,
            params: {
                "counts to test": "0, 1, 3, 40",
                "title length to test": "120 characters",
                "unbroken word": "60 characters",
                "loading": "skeleton at the final box size, not a spinner",
            },
            verify: "Feed the template 0, 1, 3 and 40 items, plus a 120-character title and an unbroken 60-character word, at 360px and 1440px. Confirm no horizontal scrolling, no overlap, and that the empty state offers an action.",
            sources: [
                {
                    title: "web.dev — Cumulative Layout Shift",
                    url: "https://web.dev/articles/cls",
                    license: "Creative Commons Attribution 4.0 (CC BY 4.0)",
                    adapted: false,
                    change: "cited, not adapted — cited for reserving space to avoid a shift when content arrives",
                },
                {
                    title: "WCAG 2.2 — Reflow (1.4.10), content usable at 320px without sideways scrolling",
                    url: "https://www.w3.org/TR/WCAG22/#reflow",
                    license: "W3C Document License (no derivatives permitted)",
                    adapted: false,
                    change: "cited, not adapted — the 320px reflow requirement is stated in the specification",
                },
            ],
        },
    ],
};
