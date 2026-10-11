import type { Topic } from "./types.js";

/**
 * The floor: what a design must clear before its ideas count.
 *
 * Every number here is the same number this server's automated gates already enforce
 * (src/test/gates.ts) and that the test budgets already assume (src/config.ts), so advice
 * and verification cannot drift apart. Where a topic has more to say about the craft of a
 * thing (motion timing, colour recipes, type scales, canvas cost), the entry points at that
 * topic by id instead of repeating it.
 */
export const FLOOR_TOPIC: Topic = {
  id: "floor",
  title: "Accessibility and performance floor",
  summary:
    "The non-negotiables: keyboard reachability and visible focus, real semantics and the honest limits of automated screening, contrast and target-size minimums, the reduced-motion contract, the per-frame budget, and what genuinely breaks at 360px. These are gates, not suggestions — the server's own test step fails a variation on most of them.",
  entries: [
    {
      id: "keyboard-and-focus",
      name: "Keyboard and focus",
      intent:
        "Use this first, before judging anything visual: an interface that cannot be driven from the keyboard is unfinished no matter how it looks.",
      why:
        "Keyboard access is also the fastest structural test of a page, because it exposes missing actions, hidden-but-focusable nodes and decorative markup that only looked like a control. Visible, unclipped focus is what turns a focusable page into a usable one.",
      do: [
        "Make a skip link the first tab stop, keep it hidden until focused, and send it to the main content region rather than the top of the page.",
        "Keep tab order equal to visual order; remove anything from the tab sequence that is off-screen, inert, or inside a collapsed panel.",
        "Give every focused element a visible ring of at least 2-3px with 2-3px offset and roughly 3:1 contrast against what sits behind it — never remove the outline without an equal-or-better replacement.",
        "Make sure the ring is never covered: sticky headers, fixed bars, overflow clipping and rounded overflow containers are what hide it, and WCAG 2.2 added a success criterion specifically about this.",
        "Trap focus inside an open dialog, close it on Escape, and return focus to the control that opened it.",
        "Do not let a landmark or a programmatic focus target (a main region after a route change) paint a full-width ring — the ring belongs on the control the user is on.",
      ],
      avoid: [
        "outline:none with nothing in its place, which makes keyboard position unknowable.",
        "A generic :focus-visible rule that out-specifies a landmark's own outline:0 override, so the landmark paints a stray block-wide line on every route change.",
        "A ring that renders but is scrolled out of view behind a sticky header, so the page looks like it has no focus at all.",
      ],
      pattern: `/* Skip link: first tab stop, hidden until focused. */
.skip{position:absolute;left:.5rem;top:.5rem;transform:translateY(-150%);
  z-index:20;padding:.6rem 1rem;background:var(--ink);color:var(--paper);border-radius:99px}
.skip:focus-visible{transform:none}

/* Ring on controls only; landmarks stay quiet. */
:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
main:focus,main:focus-visible{outline:0} /* programmatic target, not a control */`,
      params: {
        "ring width": "2-3px",
        "ring offset": "2-3px",
        "ring contrast": ">=3:1 against adjacent colours",
      },
      verify:
        "Press Tab starting from the address bar: the skip link appears first, every stop shows a ring, no ring is clipped or covered, and Escape closes any open overlay with focus back on its trigger.",
      sources: [
        {
          title: "WCAG 2.2 — Success Criteria 2.4.1, 2.4.7, 2.4.11 (bypass blocks, focus visible, focus not obscured)",
          url: "https://www.w3.org/TR/WCAG22/",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: the requirement numbers and thresholds were read from the specification and expressed here in my own words",
        },
        {
          title: "WAI — Understanding Success Criterion 2.4.11 Focus Not Obscured (Minimum)",
          url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: used to confirm which overlays are treated as obscuring",
        },
        {
          title: "WAI — Understanding Success Criterion 2.4.1 Bypass Blocks",
          url: "https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks.html",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: used to confirm the skip-link expectation",
        },
      ],
    },

    {
      id: "semantics-and-screening",
      name: "Semantics and the limits of screening",
      intent:
        "Use this to get the document structure right and to be honest with yourself about what an automated audit proved.",
      why:
        "Assistive technology, keyboard users and search engines all consume the same structure, so correct semantics pay off three times. Automated screening catches mechanical faults cheaply, and pretending it caught more than that is how accessibility debt hides.",
      do: [
        "Use exactly one h1 per page, one landmark per purpose (nav, main), and strictly nested heading levels — never pick a heading level for its visual size.",
        "Use a real <a href> for navigation and a real <button> for actions; a clickable div has no role, no keyboard behaviour, and no browser context menu.",
        "Mark purely decorative artwork aria-hidden=\"true\" and give meaningful images alt text that states what they convey, not the file name.",
        "Set lang on <html> and a unique, descriptive <title> per view — these are the first things announced when a page loads.",
        "Run the automated screen (this server runs axe-core against the wcag2a, wcag2aa, wcag21a, wcag21aa and best-practice rule sets) and treat serious and critical violations as blocking and minor ones as a to-do list.",
        "Then read the page with a screen reader and navigate by headings and landmarks only, because no rule set can decide whether an action's name is meaningful or whether the reading order makes sense.",
      ],
      avoid: [
        "Treating a clean automated run as proof of accessibility — it proves the mechanical rules passed and nothing more.",
        "A heading chosen for size, which produces a document outline that lies about the page.",
        "Icon-only buttons whose accessible name is absent or is an icon-font ligature.",
        "Fake controls built from divs, which look right to a sighted pointer user and are invisible to everyone else.",
      ],
      verify:
        "Confirm zero serious/critical violations in the automated audit, then unplug the pointer: reach every action with Tab and Enter, and list the page's headings and landmarks to check the outline describes the visible page.",
      sources: [
        {
          title: "axe-core accessibility rule engine (the rule sets this server runs)",
          url: "https://github.com/dequelabs/axe-core",
          license: "Mozilla Public License 2.0",
          adapted: false,
          change: "cited, not adapted: used to describe what the automated rule sets cover",
        },
        {
          title: "WCAG 2.2 — Success Criteria 1.3.1, 2.4.2, 3.1.1, 4.1.2 (info and relationships, page titled, language, name/role/value)",
          url: "https://www.w3.org/TR/WCAG22/",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: requirement numbers read from the specification and restated in my own words",
        },
      ],
    },

    {
      id: "colour-and-target-floors",
      name: "Contrast and target sizes",
      intent:
        "Use this before approving any ink, tint or control size: these are measurable thresholds, not taste.",
      why:
        "Contrast and hit size are the two accessibility failures most likely to be introduced by a purely visual redesign, because both fail quietly — the design looks fine to the person who chose it and unreadable or untappable to everyone whose eyes or hands differ.",
      do: [
        "Hold body text at 4.5:1 or better against its actual background, and large text (at least 24px, or at least 19px bold) at 3:1 or better.",
        "Hold non-text UI to 3:1 where the boundary or state carries meaning: input borders, focus rings, icon-only controls, chart strokes, and the shape of a toggled state.",
        "Give interactive targets at least 24x24 CSS px, or leave enough spacing that a 24px circle centred on each target does not overlap its neighbours; inline links inside a sentence are exempt by rule, but keep them visibly links.",
        "Judge translucent and overlapping surfaces against the worst case they composite over, never against the nominal colour value.",
        "Never let colour alone carry meaning or state: pair it with text, an icon, a shape or a position.",
        "Check every ink/surface pair in the palette, including text that lands on an accent chip, and prefer an existing pair that already passes at 7:1 to inventing a new mid-tone.",
      ],
      avoid: [
        "A pale accent used as body text because it matched the palette.",
        "A 16px icon button with no padding, which is a 16x16 hit area.",
        "A hover-only underline as the only signal that a word is a link.",
        "Muted secondary text below 4.5:1 — muted still has to be readable.",
      ],
      params: {
        "body text": ">=4.5:1",
        "large text (>=24px, or >=19px bold)": ">=3:1",
        "non-text UI edges and states": ">=3:1",
        "target size": ">=24x24 CSS px (or >=24px spacing)",
        "comfortable primary action": ">=44x44 CSS px",
      },
      verify:
        "Run every ink/surface pair through an offline contrast calculation (the palette_check tool does this maths without a network call), then measure the smallest interactive element in the inspector against the 24x24 minimum.",
      sources: [
        {
          title: "WCAG 2.2 — Success Criterion 1.4.3 Contrast (Minimum) and 1.4.11 Non-text Contrast",
          url: "https://www.w3.org/TR/WCAG22/",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: the ratio thresholds are specification values, restated here in my own words",
        },
        {
          title: "WAI — Understanding Success Criterion 2.5.8 Target Size (Minimum)",
          url: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: used to confirm the inline-link exemption and the spacing alternative",
        },
      ],
    },

    {
      id: "reduced-motion-implementation",
      name: "The reduced-motion contract",
      intent:
        "Use this whenever a design animation is approved, so the calm version is designed at the same time as the animated one.",
      why:
        "Motion is the only part of a design that can make a visitor physically unwell, so it is the one part that must ship with a guaranteed alternate state rather than a best-effort one. Getting this right is also what lets you be bolder with motion everywhere else.",
      do: [
        "Read the preference at load and subscribe to changes, so a mid-session switch takes effect immediately without a reload.",
        "Guarantee the complete final state: with animation off, all content is present, visible and in its resting position — never mid-transition and never invisible.",
        "Turn off smooth scrolling, stop infinite CSS animations, and do not auto-play loops, parallax or ambient drift when the preference is set.",
        "Degrade movement to a short opacity crossfade (keep it under about 100ms) or to an instant swap.",
        "Reduce a canvas or particle layer to a single static composition drawn once, instead of a running animation loop (see the organic topic for the static-frame pattern).",
        "Avoid animating anything that moves large areas of the viewport — big scale changes and full-screen translates are the worst offenders.",
      ],
      avoid: [
        "A blanket * { animation: none !important } rule: it also discards scripted reveal states, and if a start state was set in CSS the content can be left stranded invisible.",
        "Hiding a decorative layer without checking that the remaining background still contrasts with the text on top of it (see the color topic).",
        "Assuming reduced motion means no feedback at all: state changes still need to be legible, just not travelling.",
      ],
      pattern: `const mq = matchMedia("(prefers-reduced-motion: reduce)");
let still = mq.matches;
mq.addEventListener("change", (e) => { still = e.matches; apply(still); });
apply(still); // call once at load, before any animation starts

function apply(reduce) {
  document.documentElement.classList.toggle("no-motion", reduce);
  if (reduce) { loop.stop(); drawStaticFrame(); } else { loop.start(); }
}`,
      verify:
        "Emulate the preference in DevTools and reload: nothing moves, nothing is missing, and all text is still visible after scrolling to the bottom. Then flip the preference live and confirm the page reacts without a reload.",
      sources: [
        {
          title: "web.dev — prefers-reduced-motion media query",
          url: "https://web.dev/articles/prefers-reduced-motion",
          license: "Creative Commons Attribution 4.0 (CC BY 4.0) via Google developer documentation",
          adapted: false,
          change: "cited, not adapted: used to confirm the preference's scope and the guidance to respect runtime changes",
        },
        {
          title: "MDN — @media (prefers-reduced-motion)",
          url: "https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion",
          license: "CC BY-SA 2.5 or later (share-alike)",
          adapted: false,
          change: "cited, not adapted: used to confirm the media query value and listener API",
        },
      ],
    },

    {
      id: "frame-budget",
      name: "Frame budget",
      intent:
        "Use this when adding any background effect, loop or scroll response: it decides whether the page still feels light on a mid-range phone.",
      why:
        "Smoothness is a design property: a beautiful effect that drops frames reads as cheap and broken. A budget forces the honest question — what does this cost per frame, and what degrades first when the frame slips?",
      do: [
        "Animate only transform and opacity; anything that changes layout (width, height, top, left, margin) forces layout every frame, and animating filters or blur forces a recomposite.",
        "Batch all geometry reads before any style writes; reading layout after writing styles forces a synchronous reflow and is the classic cause of jank.",
        "Keep one requestAnimationFrame loop for the whole page, drive it from elapsed time rather than a frame counter, and stop it when the tab is hidden or its layer is off screen.",
        "Cache element geometry and recompute on resize, orientation change or scroll-end — not on every pointermove.",
        "Spend a small slice of the frame on background layers: aim for no more than about 4ms of script per frame, and hold the 95th-percentile frame time at or under 34ms in the scroll test this server runs.",
        "Degrade adaptively before dropping an effect: lower device-pixel-ratio, particle count or blur radius, and keep the frame's guarantee.",
        "Respect the load budgets as well: JS <= 250KB gzipped, CSS <= 60KB gzipped, images <= 2500KB, total <= 4000KB, LCP <= 2500ms, CLS <= 0.1.",
      ],
      avoid: [
        "Animating a blur, backdrop-filter or filter value, which re-rasterises the layer every frame.",
        "Animating font-variation-settings across many glyphs or long strings: it relayouts text (see the typography topic for where it is affordable).",
        "An animation loop that keeps running while the tab is in the background or its canvas is scrolled out of view.",
        "\"It looks fine on my laptop\" as a performance argument.",
      ],
      pattern: `let raf = 0, last = 0;
const BUDGET = 1000 / 60 * 0.9; // ~15ms; keep a slice for the browser

function tick(now) {
  raf = requestAnimationFrame(tick);
  const dt = Math.min(64, now - last); last = now;   // clamp after a stall
  const t0 = performance.now();
  update(dt);                                        // transform/opacity only
  const cost = performance.now() - t0;
  if (cost > 4) quality = Math.max(0.5, quality - 0.1);  // adaptive degrade
  else if (cost < 2) quality = Math.min(1, quality + 0.02);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
  else if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
});`,
      params: {
        "background layer script per frame": "<=4ms",
        "p95 frame time (server scroll test)": "<=34ms",
        "long frames during scroll": "<=3 frames over 100ms",
        "LCP / CLS": "<=2500ms / <=0.1",
      },
      verify:
        "Record frame times while scrolling the whole page and report the 95th percentile plus the number of frames over 100ms; this server's test step runs exactly that measurement, so a claim of smoothness can be checked rather than asserted.",
      sources: [
        {
          title: "web.dev — Stick to compositor-only properties and manage layer count",
          url: "https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count",
          license: "Creative Commons Attribution 4.0 (CC BY 4.0) via Google developer documentation",
          adapted: false,
          change: "cited, not adapted: used to confirm which properties stay on the compositor",
        },
        {
          title: "web.dev — Avoid large, complex layouts and layout thrashing",
          url: "https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing",
          license: "Creative Commons Attribution 4.0 (CC BY 4.0) via Google developer documentation",
          adapted: false,
          change: "cited, not adapted: used to confirm the forced-synchronous-layout pattern described in the rules",
        },
        {
          title: "web.dev — Core Web Vitals thresholds (LCP 2.5s, CLS 0.1)",
          url: "https://web.dev/articles/vitals",
          license: "Creative Commons Attribution 4.0 (CC BY 4.0) via Google developer documentation",
          adapted: false,
          change: "cited, not adapted: the LCP and CLS numbers come from the published metric thresholds and match this server's test budgets",
        },
        {
          title: "Android Developers — rendering performance and frame timing",
          url: "https://developer.android.com/topic/performance/rendering",
          license: "proprietary / all rights reserved (no open-content licence stated on the page)",
          adapted: false,
          change: "cited, not adapted: used to confirm that a frame has a fixed time slice and that missing it is what users read as jank",
        },
      ],
    },

    {
      id: "mobile-reality",
      name: "Mobile reality (360px)",
      intent:
        "Use this for the smallest target before you call a layout finished: 360px is where overflow, tiny targets and hover-only affordances appear.",
      why:
        "Most visitors arrive on a phone, and the phone is a harsher test than a narrow desktop window: no hover, less vertical room, notches and browser chrome that move. A design that survives 360px is usually a simpler, better design at every width.",
      do: [
        "Test at 360px and 390px and confirm there is no horizontal scrolling; when there is, find the cause rather than hiding it — fixed pixel widths, unbreakable long words and URLs, negative margins, and transforms that push content past the edge are the usual four.",
        "Give grid and flex children min-width:0 (or minmax(0,1fr)) so long content can shrink instead of forcing the row wider than the viewport.",
        "Use dynamic viewport units (100dvh, with a 100vh fallback) for anything sized to the screen, and pad against env(safe-area-inset-*) for elements pinned to the viewport edges.",
        "Give every hover reveal a touch fallback: show it by default, or open it on tap or focus, or remove it.",
        "Keep tap targets at 24x24 CSS px minimum and give primary actions around 44px of comfort; keep no text below 11px.",
        "Break long words in user or post content (overflow-wrap) rather than letting one title widen the page.",
      ],
      avoid: [
        "height:100vh on a full-screen hero, which jumps as mobile browser chrome shows and hides.",
        "white-space:nowrap on titles or excerpts, which turns one long word into a horizontal scrollbar.",
        "A card that reveals its excerpt only on hover, so touch users never see it.",
        "Decorative transforms applied on a phone, where there is no pointer to respond to and the layer budget is smallest.",
      ],
      pattern: `:root { --pad: max(1rem, env(safe-area-inset-left)); }
.hero { min-height: 100vh; min-height: 100dvh; }
.grid > * { min-width: 0; }             /* let children shrink */
.title, .excerpt { overflow-wrap: anywhere; }

@media (hover: none), (pointer: coarse) {
  .reveal-excerpt { opacity: 1; max-height: none; } /* no hover: show it */
}`,
      params: {
        "test widths": "360px and 390px",
        "minimum text size": ">=11px",
        "minimum target": ">=24x24 CSS px",
      },
      verify:
        "Resize to 360px, scroll the page and confirm no sideways movement; then switch to a touch emulation profile and confirm every hover-only reveal is reachable by tap, and check safe-area padding with a notch emulated.",
      sources: [
        {
          title: "MDN — env() (safe-area insets)",
          url: "https://developer.mozilla.org/en-US/docs/Web/CSS/env",
          license: "CC BY-SA 2.5 or later (share-alike)",
          adapted: false,
          change: "cited, not adapted: used to confirm the env() function name and its inset variables",
        },
        {
          title: "MDN — <length> (viewport units, including dvh/lvh/svh)",
          url: "https://developer.mozilla.org/en-US/docs/Web/CSS/length",
          license: "CC BY-SA 2.5 or later (share-alike)",
          adapted: false,
          change: "cited, not adapted: used to confirm which dynamic viewport units exist",
        },
        {
          title: "WCAG 2.2 — Success Criterion 1.4.10 Reflow and 2.5.8 Target Size (Minimum)",
          url: "https://www.w3.org/TR/WCAG22/",
          license: "W3C Document License (2023) — prohibits derivatives",
          adapted: false,
          change: "cited, not adapted: requirement numbers read from the specification, restated in my own words",
        },
      ],
    },
  ],
};
