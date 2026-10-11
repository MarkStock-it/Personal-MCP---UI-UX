import type { Topic } from "./types.js";

/**
 * Motion and interaction. The rule of thumb behind every entry here: motion earns its place
 * by saying something (where a thing came from, what it belongs to, what is happening), and
 * anything that only decorates gets cut. Each entry states what it does under
 * prefers-reduced-motion and what it costs per frame, because a motion system that ignores
 * those two is not finished.
 */
export const MOTION_TOPIC: Topic = {
  id: "motion",
  title: "Motion and interaction",
  summary:
    "Easing, timing, choreography, pointer and scroll response, and the reduced-motion contract. Use it when choosing how a state change should feel, not for picking 'a nice animation'.",
  entries: [
    {
      id: "easing-by-role",
      name: "One easing per role",
      intent: "Choose an easing curve from what the change means — entering, leaving, moving on screen, or emphasis — instead of one global ease.",
      why: "The curve is the cheapest signal of physical intent; matching it to the role is most of what makes an interface feel authored. Curves are declared once as tokens, so the runtime cost is zero.",
      do: [
        "Entering elements: use a decelerating curve — fast departure from the start, long settle at the end.",
        "Leaving elements: use an accelerating curve — a quiet start and a quick exit, which clears the way for whatever arrives next.",
        "Elements moving within the screen: use a symmetric standard curve so origin and destination read as equally weighted.",
        "Keep linear only where the rate is genuinely constant — progress bars, marquees, an animation clock. Linear on a UI state change reads mechanical.",
        "Reserve overshoot for one deliberate emphasis per page; overshoot on position, size or layout reads cheap.",
        "Declare the curves as named tokens (--ease-enter, --ease-exit, --ease-move, --ease-emph) so the decision is made once and reviewed once.",
        "The curve only exists while something is moving: under prefers-reduced-motion set the final value directly instead of animating to it (reduced-motion-contract).",
      ],
      avoid: [
        "Every transition sharing one 0.3s ease-in-out — the fingerprint of an unstyled default.",
        "Bounce or elastic curves on text, which moves the thing the user is trying to read.",
        "Overshoot that carries an element past its container edge.",
      ],
      pattern: `:root{
  --ease-enter: cubic-bezier(.16,.84,.28,1);  /* arriving: late, long settle */
  --ease-exit:  cubic-bezier(.7,0,.84,.2);    /* leaving: quick departure */
  --ease-move:  cubic-bezier(.4,0,.2,1);      /* on-screen move: symmetric */
  --ease-emph:  cubic-bezier(.34,1.4,.64,1);  /* one emphasis, small overshoot */
}
.panel{
  transition: opacity 340ms var(--ease-move), translate 340ms var(--ease-enter);
}
.panel[data-leaving=true]{ transition-timing-function: var(--ease-exit); }`,
      params: {
        "settle behaviour": "a decelerating curve should be ~95% of the way there in the first 60% of its duration",
        "overshoot": "2-6% of travel; never above 8%",
        "curves per page": "3 or 4 tokens total",
      },
      verify:
        "In DevTools > Animations set playback to 10% and confirm the entering element is already near its final position in the first third, and that no two roles share the same curve.",
      sources: [
        {
          title: "Robert Penner's easing functions (origin of the standard ease-in/out vocabulary)",
          url: "https://robertpenner.com/easing/",
          license: "BSD-3-Clause and MIT (per the author's page)",
          adapted: false,
          change: "cited, not adapted — used only as the reference for which curve family belongs to which behaviour; the bezier values here were chosen for this playbook",
        },
        {
          title: "Material Design 3 — easing and duration tokens",
          url: "https://m3.material.io/styles/motion/easing-and-duration/tokens-specs",
          license: "unverified for this page (Google states Material content is Apache-2.0 or CC BY 4.0; not confirmed for this URL)",
          adapted: false,
          change: "cited, not adapted — consulted only to sanity-check that the role-based easing categories are the conventional ones",
        },
      ],
    },
    {
      id: "duration-by-distance",
      name: "Duration from distance and size",
      intent: "Derive how long a change takes from how far it travels and how large the element is, instead of using one duration everywhere.",
      why: "A fixed duration makes long moves feel like teleporting and small ones feel sticky, and it is the first thing a reviewer notices without being able to name it. A distance-derived rule is consistent across a whole product and easy to defend.",
      do: [
        "Keep input feedback — hover, press, focus — in the 80-140ms band. Past about 150ms the interface stops feeling attached to the pointer.",
        "Scale travel at roughly half a millisecond per pixel, clamped between about 140ms and about 700ms: 40px reads at ~160ms, 600px at ~410ms, a full-viewport change at ~650ms.",
        "Let large moving objects start and settle more slowly than small ones — perceived mass — but never exceed about 1.2s even for a full-screen scene change.",
        "Pick the lead element's duration first, then derive children from it (see choreography-stagger), and cap the whole sequence near 600ms.",
        "Shorten by about 30% when the same change is replayed within a couple of seconds; a second open should feel snappier than the first.",
        "Let the duration shorten as an element approaches its final position only in the curve, not by stacking extra timers.",
        "Duration is a motion decision, so it disappears with motion: under prefers-reduced-motion the change is instant (reduced-motion-contract).",
      ],
      avoid: [
        "300ms on every transition because it was in a snippet.",
        "Transitions of a second or more on any control the user can click again.",
        "Slow opacity fades on body text the user is already reading.",
      ],
      pattern: `/* distance -> duration, clamped; ~0.45ms per px */
const duration = (px) => Math.round(Math.min(700, Math.max(140, 140 + px * 0.45)));
el.style.transitionDuration = duration(travelDistance) + "ms";
// replay: same change again within 2s -> 30% shorter
const shortened = replaying ? Math.round(duration(px) * 0.7) : duration(px);`,
      params: {
        "travel rate": "≈0.45ms per px (≈2px per ms)",
        "feedback floor": "80-140ms",
        "ceiling": "700ms, or 1200ms for a deliberate full-screen scene change",
        "sequence cap": "600ms for a whole entrance",
      },
      verify:
        "Record the open of the largest moving element in a Performance profile: its total animation time should sit in the band its distance implies, and a second open should be measurably shorter.",
      sources: [
        {
          title: "Material Design 3 — easing and duration tokens",
          url: "https://m3.material.io/styles/motion/easing-and-duration/tokens-specs",
          license: "unverified for this page (Material code is Apache-2.0)",
          adapted: false,
          change: "cited, not adapted — used only to confirm that duration is conventionally banded by change size",
        },
        {
          title: "IBM Carbon — motion foundations",
          url: "https://www.carbondesignsystem.com/building-blocks/foundations/motion/overview",
          license: "repository is Apache-2.0; documentation site licence not confirmed",
          adapted: false,
          change: "cited, not adapted — consulted on productively-perceived duration ranges",
        },
      ],
    },
    {
      id: "choreography-stagger",
      name: "Choreographed stagger",
      intent: "Make a group of elements arrive as one gesture with a single leader, rather than as N independent animations.",
      why: "Sequencing is what separates a composed page from a pile of fades: the eye follows the leader and then reads the group as a whole. The same amount of movement therefore carries more meaning.",
      do: [
        "Choose one leader — the element the user's attention should land on — and give it both the earliest start and the largest movement.",
        "Stagger 30-70ms inside a tight cluster and 80-120ms in a spacious editorial layout; past about 120ms the group stops reading as one gesture.",
        "Overlap children by 30-50% of each child's duration so the sequence flows; zero overlap turns a gesture into a queue.",
        "Stagger in reading order, or in the direction of travel, never in DOM accident order.",
        "Cap the whole sequence near 600ms: when N elements would exceed it, shrink the stagger rather than each element's duration.",
        "For a page-level entrance, animate one parent opacity and keep transform per child, so the compositor sees one layer instead of N.",
        "With prefers-reduced-motion, drop the stagger and render the whole group at once - a chained reveal is exactly what the preference exists to stop (reduced-motion-contract).",
      ],
      avoid: [
        "Staggering every item of a long list, so the user watches a wave travel down the page.",
        "Stagger on hover or focus — those must respond within a frame, not on a delay.",
        "Staggering both axes at once in a grid, which reads as noise.",
      ],
      pattern: `/* one leader, then the group, in reading order, total capped */
const lead = 340, step = 55, overlap = 0.4;
items.forEach((el, i) => {
  const delay = i === 0 ? 0 : Math.min(lead * overlap + (i - 1) * step, 260);
  el.animate(
    [{ opacity: 0, transform: "translateY(14px)" },
     { opacity: 1, transform: "none" }],
    { duration: lead, delay, easing: "cubic-bezier(.16,.84,.28,1)", fill: "both" },
  );
});`,
      params: {
        "stagger tight": "30-70ms",
        "stagger spacious": "80-120ms",
        "overlap": "30-50% of the child duration",
        "sequence cap": "600ms",
      },
      verify:
        "Record the entrance at 25% playback: the leader should be visibly ahead of the last child, and nothing should still be moving after 0.6s.",
      sources: [
        {
          title: "Microsoft Fluent 2 — motion",
          url: "https://fluent2.microsoft.design/motion",
          license: "proprietary / all rights reserved",
          adapted: false,
          change: "cited, not adapted — consulted only for the vocabulary of coordinated, chained motion",
        },
        {
          title: "Motion (Framer Motion) — transitions",
          url: "https://motion.dev/docs/react-transitions",
          license: "MIT (project licence; documentation consulted)",
          adapted: false,
          change: "cited, not adapted — used for the standard parent/child stagger and delay vocabulary",
        },
      ],
    },
    {
      id: "interruptible-state",
      name: "Interruptible state changes",
      intent: "Animate a current value toward a target every frame so a change can be reversed mid-flight without waiting for anything to finish.",
      why: "Interruptibility is the difference between an interface that feels alive and one that feels like it is playing back a video. It also removes the class of bug where a stale tween completes late and snaps the UI back to a state the user already left.",
      do: [
        "Model state as current, target and velocity; each frame move current toward target with exponential smoothing, and re-read the target whenever state changes.",
        "Never block input on an animation: the control that started a change must accept the opposite change immediately.",
        "Preserve velocity on reversal when the physics allows it — keep the velocity variable instead of resetting it to zero.",
        "Prefer a spring or a smoothed tween for anything driven by pointer, scroll or gestures, and reserve a fixed timeline for one-shot entrances.",
        "Group every visual property of one state change under a single controls handle (a GSAP timeline or one Animation object) so canceling the change cancels all of it.",
        "Always write the final value when the loop stops, so a canceled animation can never leave a half-applied state on screen.",
        "When prefers-reduced-motion is set, keep the interruptible model but remove the travel: set current to target and render one frame (reduced-motion-contract).",
      ],
      avoid: [
        "Queueing animations and refusing input until they finish.",
        "Two tweens writing the same property at once and fighting (GSAP: overwrite: 'auto').",
        "Calling getBoundingClientRect inside the per-frame loop, which forces layout on every frame.",
        "Reading the clock with Date.now() instead of the rAF timestamp, which drifts under load.",
      ],
      pattern: `/* smoothed, interruptible, frame-rate independent */
let cur = 0, target = 0, raf = 0, last = 0;
const TAU = 0.12; // seconds; smaller sticks to the target faster
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; // clamp so a stalled tab cannot teleport
  cur += (target - cur) * (1 - Math.exp(-dt / TAU));
  el.style.transform = "translateY(" + cur.toFixed(2) + "px)";
  if (Math.abs(target - cur) > 0.05) raf = requestAnimationFrame(frame);
  else { cur = target; el.style.transform = "translateY(" + cur + "px)"; raf = 0; }
}
function setState(next) {
  target = next;                        // re-read every time, even mid-flight
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
}`,
      params: {
        "time constant": "0.10-0.18s for pointer-following UI, ~0.25s for a heavy panel",
        "dt clamp": "50ms, so a backgrounded tab cannot teleport the animation",
        "settle threshold": "0.05px",
      },
      verify:
        "Start an opening, then click the control again mid-flight: the motion must reverse from where it is with no jump, and once settled the loop stops (no further rAF callbacks).",
      sources: [
        {
          title: "Motion (Framer Motion) — transitions and springs",
          url: "https://motion.dev/docs/react-transitions",
          license: "MIT (project licence; documentation consulted)",
          adapted: false,
          change: "cited, not adapted — used for the current/target/velocity model of interruptible transitions",
        },
        {
          title: "GSAP documentation — tween overwrite behaviour",
          url: "https://gsap.com/docs/v3/GSAP/",
          license: "proprietary / all rights reserved (the product licence covers the library, not its documentation text)",
          adapted: false,
          change: "cited, not adapted — consulted only to name the overwrite behaviour when two tweens touch one property",
        },
      ],
    },
    {
      id: "pointer-falloff",
      name: "Smooth pointer falloff",
      intent: "React to pointer proximity with a gradual distance falloff, measured once per frame, applied on transform only.",
      why: "A gradual falloff reads as attention rather than the binary on/off of a hover hit-test, and nothing moves unless the pointer is meaningfully near. Keeping it on transform keeps it off the layout path, so a whole-page effect costs almost nothing.",
      do: [
        "Use smoothstep rather than a linear ramp: normalise the distance by the influence radius, then apply t*t*(3-2t). That removes the visible corner where a linear falloff starts and stops.",
        "Sample the pointer once per frame in the rAF callback, not in the pointermove handler, and make the handler itself as cheap as writing two numbers.",
        "Measure element rectangles at resize and after layout changes (ResizeObserver), never inside the per-frame loop.",
        "Write only transform, opacity, filter and custom properties; never top, left, width, font-size or colour stops.",
        "Enable only when the input is a fine pointer that can hover — media (hover:hover) and (pointer:fine) — which excludes touch and most TV remotes.",
        "Go quiet: after roughly 1.5-2s without pointer movement, decay the effect to rest and cancel the rAF loop, restarting on the next pointermove.",
        "Track few elements: 3-6 that carry meaning beat a page where everything reacts at once.",
        "Under prefers-reduced-motion, resolve every tracked element to rest and stop sampling the pointer: proximity response is pointer-linked motion (reduced-motion-contract).",
      ],
      avoid: [
        "Per-letter DOM writes across a whole paragraph when a few tracked elements would read the same.",
        "An influence radius so wide that every element on the page moves together — then nothing reads as focus.",
        "Non-passive pointer or wheel listeners that block scrolling.",
        "Animating custom properties that are consumed by layout values such as width or font-size.",
      ],
      pattern: `const fine = matchMedia("(hover:hover) and (pointer:fine)").matches;
if (fine) {
  const smooth = (t) => t * t * (3 - 2 * t);
  let mx = 0, my = 0, queued = false, idleSince = performance.now();
  addEventListener("pointermove", (e) => {
    mx = e.clientX; my = e.clientY; idleSince = e.timeStamp;
    if (!queued) { queued = true; requestAnimationFrame(apply); }
  }, { passive: true });
  function apply() {
    queued = false;
    for (const t of tracks) {          // {el, rect, radius, move} — rect cached elsewhere
      const d = Math.hypot(mx - t.rect.x, my - t.rect.y);
      const k = smooth(Math.max(0, 1 - d / t.radius));
      t.el.style.setProperty("--near", k.toFixed(3));
      t.el.style.transform = "translate3d(" + (t.move * k).toFixed(2) + "px,0,0)";
    }
    if (performance.now() - idleSince < 1800) requestAnimationFrame(apply);
    else for (const t of tracks) t.el.style.transform = "";   // fully at rest
  }
}`,
      params: {
        "influence radius": "180-280px for a large display headline, 60-120px for a small control",
        "max displacement": "1-4px of drift, or 8-16% of a variable-font weight axis",
        "idle stop": "1500-2000ms",
      },
      verify:
        "With Paint flashing and Layout Count visible in the Rendering panel, sweep the pointer: layout count must not increase while the effect runs, and the page must look identical on a touch device because the media query gates it.",
      sources: [
        {
          title: "MDN — pointermove event and passive listener option",
          url: "https://developer.mozilla.org/en-US/docs/Web/API/Element/pointermove_event",
          license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
          adapted: false,
          change: "cited, not adapted — used for event semantics and the passive-listener behaviour",
        },
        {
          title: "MDN — ResizeObserver",
          url: "https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver",
          license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
          adapted: false,
          change: "cited, not adapted — used for when to re-measure cached rectangles",
        },
      ],
    },
    {
      id: "ambient-idle-loop",
      name: "Ambient loop that idles to still",
      intent: "Give a background layer a slow life of its own that decays to a still state and stops the loop entirely when nobody is looking at it.",
      why: "Ambient motion that never stops is the main reason a decorative effect turns expensive and irritating. A loop that idles down and shuts off is what makes a living background affordable on battery.",
      do: [
        "Drive everything from the timestamp passed to the rAF callback, with a dt clamp, never from a frame counter, so the motion runs at the same speed on 60Hz and 120Hz displays.",
        "Design a resting state: when no input has arrived for a while, blend activity down to zero and cancel the animation frame; wake it from the state itself on the next event.",
        "Stop on document visibilitychange to hidden, and use IntersectionObserver to stop when the layer is scrolled out of view.",
        "Keep this layer's own per-frame JS under about 2ms, and measure it; degrade quality (halve the device pixel ratio, cut particle count) rather than dropping frames.",
        "Size the backing store to devicePixelRatio at resize only, and cap DPR at 2 — a 3x full-viewport canvas can cost more than it shows.",
        "Mutate accumulated state (fields, particles, ripples) instead of rebuilding geometry each frame; per-frame allocation shows up as GC stutter.",
        "Under prefers-reduced-motion, draw one frame of the resting state and never start the loop.",
      ],
      avoid: [
        "An infinite CSS animation as a decorative background: it cannot decay, and it keeps compositing work scheduled.",
        "Allocating objects or arrays inside the frame callback, which turns into periodic GC hitches.",
        "A canvas sized far larger than its display area 'just in case'.",
        "Restarting the loop on every pointermove, so it never actually rests.",
      ],
      pattern: `let raf = 0, energy = 1, last = 0, lastInput = 0, quality = 1, onScreen = true;
const BUDGET = 2; // ms of JS per frame for this layer
function frame(now) {
  const dt = Math.min(50, now - last) || 16; last = now;
  const t0 = performance.now();
  const active = now - lastInput < 1800;
  energy = active ? Math.min(1, energy + dt / 900) : Math.max(0, energy - dt / 2600);
  update(dt, energy, quality);               // mutate existing state only
  const cost = performance.now() - t0;
  if (cost > BUDGET) quality = Math.max(0.4, quality * 0.85);
  else if (cost < BUDGET * 0.5) quality = Math.min(1, quality * 1.02);
  if (energy > 0.002 && onScreen && !document.hidden) raf = requestAnimationFrame(frame);
  else { cancelAnimationFrame(raf); raf = 0; }   // fully at rest, zero scheduled work
}
addEventListener("visibilitychange", () => {
  if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
  else if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
});`,
      params: {
        "js budget per frame": "2ms for a full-viewport background layer, 4ms across the whole page",
        "decay to rest": "2-4s without input",
        "wake ramp": "0.6-1s back up to full energy",
        "max device pixel ratio": "2",
      },
      verify:
        "Record a 10s Performance profile with the pointer still: after the decay window the frame count should fall to zero rAF callbacks, and no frame should show more than the budget in this layer's script time.",
      sources: [
        {
          title: "MDN — Document: visibilityState and visibilitychange",
          url: "https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilityState",
          license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
          adapted: false,
          change: "cited, not adapted — used for the hide/show semantics of pausing a loop",
        },
        {
          title: "MDN — Intersection Observer API",
          url: "https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API",
          license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
          adapted: false,
          change: "cited, not adapted — used for stopping work when the layer leaves the viewport",
        },
        {
          title: "MDN — performance.now()",
          url: "https://developer.mozilla.org/en-US/docs/Web/API/Performance/now",
          license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
          adapted: false,
          change: "cited, not adapted — used for the per-frame cost measurement",
        },
      ],
    },
    {
      id: "reduced-motion-contract",
      name: "Reduced-motion contract",
      intent: "Define exactly what changes when prefers-reduced-motion is set, so the fallback is a designed state rather than a discovered one.",
      why: "For a motion-led design the reduced-motion state is a second design, not a switch that turns the work off. Doing it well keeps the meaning and removes the movement that makes people ill.",
      do: [
        "Remove all infinite, automatic, parallax and scroll-linked animation, including scroll hijacking: the page must not move on its own.",
        "Keep colour and opacity crossfades, but at or under about 120ms, and strip translation, scale, rotation and blur out of them.",
        "Render the complete final state immediately — nothing may start at opacity 0, clipped to zero or transformed away, because a skipped animation must never skip the content.",
        "Replace motion that carried meaning with a static cue such as an instant switch plus a border, label or icon, rather than dropping the signal.",
        "Read the preference at load AND subscribe to its change event, because a user can flip it while the page is open.",
        "Apply the contract in all three places: the CSS media query, the JS matchMedia check, and any animation library that defaults to motion.",
        "Leave non-motion feedback alone: focus rings, hover colour and pressed states are not motion and must still change.",
      ],
      avoid: [
        "transition: none on everything, which also kills focus and hover feedback and can hide content whose reveal was a transition.",
        "Checking the preference once at boot and never again.",
        "Reduced motion as a separate, thinner page: same content, same layout, less movement.",
      ],
      pattern: `@media (prefers-reduced-motion: reduce){
  *, *::before, *::after{
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 120ms !important;
  }
  [data-motion="parallax"], [data-motion="float"]{ transform: none !important; }
}
/* ...and in JS, so libraries obey the same contract */
const mq = matchMedia("(prefers-reduced-motion: reduce)");
let reduced = mq.matches;
mq.addEventListener("change", (e) => { reduced = e.matches; reduced ? stopAllMotion() : startAllMotion(); });`,
      params: {
        "crossfade ceiling": "100-120ms",
        "infinite animations allowed": "0",
        "elements starting at opacity 0 before an animation": "0",
      },
      verify:
        "Force the media feature in DevTools > Rendering, reload, and confirm: document.getAnimations() reports no running infinite animation, no smooth-scroll class is set, every heading and paragraph is visible without scrolling, and tabbing still shows a focus ring.",
      sources: [
        {
          title: "WCAG 2.2 — SC 2.3.3 Animation from Interactions",
          url: "https://www.w3.org/TR/WCAG22/#animation-from-interactions",
          license: "W3C Document License (2023) — no derivatives permitted",
          adapted: false,
          change: "cited, not adapted — used for the requirement itself; all wording here is original",
        },
        {
          title: "WCAG 2.2 — SC 2.2.2 Pause, Stop, Hide",
          url: "https://www.w3.org/TR/WCAG22/#pause-stop-hide",
          license: "W3C Document License (2023) — no derivatives permitted",
          adapted: false,
          change: "cited, not adapted — used for the rule that automatic moving content must be stoppable",
        },
        {
          title: "MDN — prefers-reduced-motion media query",
          url: "https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion",
          license: "CC BY-SA 2.5 or later (Mozilla Contributors)",
          adapted: false,
          change: "cited, not adapted — used for the media query syntax and change-event behaviour",
        },
        {
          title: "Apple Human Interface Guidelines — Motion",
          url: "https://developer.apple.com/design/human-interface-guidelines/motion",
          license: "proprietary / all rights reserved",
          adapted: false,
          change: "cited, not adapted — consulted only for the user-facing idea that reduced motion should preserve meaning",
        },
      ],
    },
  ],
};
