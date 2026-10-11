/**
 * Organic and generative visuals: fields, noise, displacement and material.
 *
 * Everything here is dependency-free 2D canvas / CSS, because the effect has to stay behind
 * the content and inside the frame budget. Each entry states its per-frame cost and what it
 * does when the user asks for reduced motion.
 */
export const ORGANIC_TOPIC = {
    id: "organic",
    title: "Organic and generative visuals",
    summary: "Making a page feel alive and physical — flowing fields, lingering ripples, depth and texture — with plain 2D canvas and CSS, no libraries.",
    entries: [
        {
            id: "single-canvas-layer",
            name: "One canvas, behind everything",
            intent: "Giving a whole page a living background without a per-element effect or a WebGL dependency.",
            why: "A single full-viewport canvas is the cheapest way to make a page feel alive: one loop, one clear, one compositor layer. Keeping it behind the content also means the text never pays for the decoration.",
            do: [
                "Use exactly one canvas: position fixed, inset 0, pointer-events none, sitting below a content wrapper that has position relative — never one canvas per element.",
                "Size the backing store in device pixels and scale the context once per resize (cv.width = innerWidth * dpr, dpr capped at 2, then setTransform). After that all your drawing maths stays in CSS pixels.",
                "Own the frame: clear once per frame, then draw, then schedule the next frame in the same requestAnimationFrame callback. Two loops writing to one canvas will flicker in ways that look like a browser bug.",
                "Stop the loop when it cannot be seen — cancel on visibilitychange when the tab is hidden — and restart when it returns. A background animation that keeps running in a hidden tab is battery theft, not craft.",
                "Cost: one clear plus your draw calls per frame. Budget 2-4ms of JS per frame on a mid-range phone and measure the rAF delta distribution, not the average.",
                "Reduced motion: keep the canvas and freeze time — draw a single static frame instead of removing the layer, because a still field still carries the concept.",
            ],
            avoid: [
                "A canvas whose CSS size changes without a resize handler: it silently stretches and blurs, which readers experience as a rendering bug.",
                "A fixed 1x backing store on a 3x phone: everything looks soft and nobody can say why.",
            ],
            params: { dpr: "min(devicePixelRatio, 2)", clearPerFrame: "exactly 1", budgetMs: "2-4" },
            verify: "Hide the tab and confirm the frame counter stops; resize the window and confirm the drawing stays sharp rather than blurring.",
            pattern: `const cv = document.querySelector("#field");
const g = cv.getContext("2d");
let raf = 0;

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.floor(innerWidth * dpr);
  cv.height = Math.floor(innerHeight * dpr);
  cv.style.width = innerWidth + "px";
  cv.style.height = innerHeight + "px";
  g.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in CSS pixels from here on
}

function frame(t) {
  g.clearRect(0, 0, innerWidth, innerHeight);   // exactly one clear per frame
  drawField(t);                                 // yours: drawing in CSS pixels
  raf = requestAnimationFrame(frame);
}

const start = () => { if (!raf) raf = requestAnimationFrame(frame); };
const stop = () => { cancelAnimationFrame(raf); raf = 0; };

addEventListener("resize", resize);
document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
resize();
start();`,
            sources: [
                {
                    title: "MDN: Canvas API — optimizing canvas",
                    url: "https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted (share-alike licence; no text or code reused).",
                },
                {
                    title: "W3C: Page Visibility Level 2 (visibilitychange)",
                    url: "https://www.w3.org/TR/page-visibility-2/",
                    license: "W3C Document License",
                    adapted: false,
                    change: "Cited, not adapted — the W3C licence forbids derivative works, so the pause/resume rule is expressed in original words.",
                },
            ],
        },
        {
            id: "seeded-value-noise",
            name: "Seeded noise, not random",
            intent: "Drift, variation and organic texture that differs per item but is identical on every reload.",
            why: "Math.random() makes a page look different on every visit and impossible to art-direct, because you cannot tune a layout you cannot see twice. A hash-based value noise gives you a stable field that still looks unplanned.",
            do: [
                "Seed from a stable string — an item id, a slug, a section name — never from the clock, and never from Math.random(). Determinism is what makes the field tunable.",
                "Mix the integer hash with Math.imul: plain multiplication silently loses precision past 2^53 and the field develops visible repetition as the coordinates grow.",
                "Interpolate with smoothstep (t*t*(3-2*t)), not linearly: linear interpolation leaves diagonal lattice lines that the eye reads as a grid.",
                "Sample noise on a coarse lattice — 40 to 60 cells across the viewport — and interpolate into the drawing. Per-pixel fbm in JavaScript is the fastest way to miss the frame budget, and nobody can see the detail it buys.",
                "Cost: 8-16 Math.imul calls per sample. A 48x30 lattice is about 1,400 samples, roughly 0.2-0.6ms, and two octaves is usually enough; each extra octave doubles it.",
                "Reduced motion: freeze noise-driven position (evaluate once, draw once). Noise used as static texture can stay, because it was never moving.",
            ],
            avoid: [
                "Re-seeding on resize: the field should look like the same water when the window changes size.",
                "Three or more octaves 'for richness' on a full-viewport field — you pay 4x for detail below the pixel grid.",
            ],
            params: { latticeCells: "40-60 across", octaves: "2 (3 maximum)", seed: "hash of a stable id" },
            pattern: `const hash = (x, y, seed) => {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;   // deterministic [0,1)
};

const smooth = (t) => t * t * (3 - 2 * t);

function noise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

// Two octaves: the large swell plus fine detail. One extra noise call.
const fbm = (x, y, seed) => noise2(x, y, seed) * 0.65 + noise2(x * 3, y * 3, seed + 101) * 0.35;`,
            sources: [
                {
                    title: "simplex-noise.js (Jonas Wagner)",
                    url: "https://github.com/jwagner/simplex-noise.js",
                    license: "MIT License",
                    adapted: false,
                    change: "Cited, not adapted: the value-noise and Math.imul hash above are written from scratch; this library is named only as the drop-in alternative when you need higher-quality gradients.",
                },
                {
                    title: "MDN: Math.imul",
                    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted — used to confirm the 32-bit behaviour the hash relies on.",
                },
            ],
        },
        {
            id: "displacement-ripples",
            name: "Ripples written into a surface",
            intent: "Pointer or event feedback that lingers and interferes instead of a one-shot ring animation.",
            why: "A ring that plays once and disappears leaves no memory: the interaction is over before the eye registers it. Modelling a displacement field makes every input change the surface, so ripples add up, cross each other and calm down slowly.",
            do: [
                "Keep a fixed-size pool of impulses in a ring buffer (16 to 32). Never push to an unbounded array on pointermove — that grows without limit and allocates every frame.",
                "Decay the contribution of each impulse with an exponential envelope (exp(-DECAY * age)) so the surface always settles back to perfect calm instead of snapping to rest.",
                "Set the decay from the LIFETIME you want, and remember the lifetime is the product of two numbers: the envelope and the alpha you scale it by. A drop is only visible while envelope * alphaFactor is above roughly 8% opacity, so at DECAY 2.4 with a 0.5 factor a trail is gone in about half a second and reads as a cursor smear. About 1.5-1.8 per second with a 0.8 factor gives the 1.5s linger that reads as water; check the tail, not the peak.",
                "If you only need the visual and not the height field, skip the grid: pre-render one soft ring sprite per colour (transparent centre, a bright crest at about 55% radius, fading at the edge) and blit it once per live impulse at the radius the impulse implies. That is one draw per impulse instead of one sample per grid cell per impulse, and the result reads the same at a fraction of the cost. Use the sampled grid only when something else must react to the displacement, such as shapes bobbing on the surface.",
                "Sum the live impulses at each sample point. Interference is the entire reason to model a field; taking the maximum instead gives you rings that merely overlap.",
                "Choose the profile deliberately: cos(k * PI * 3) * (1-k)^2 gives three soft crests that fade at the edge, so a bigger drop spreads wider (calmer) rather than just brighter.",
                "Cost: samples x live impulses, not samples x pool size — skip dead impulses before calling hypot(). A 60x36 grid with six live impulses is roughly 13k cheap ops (~0.3ms); with all 24 live it is about 50k (~1.5ms).",
                "Reduced motion: draw the field at rest once, and answer input with a single static ring that fades in place over about 250ms — no expansion, no accumulation.",
            ],
            avoid: [
                "One expanding circle per pointer event: hairlines that vanish in under a second read as a cursor trail, not as water.",
                "An amplitude with no ceiling — a fast scroll or trackpad fling turns the surface into a strobe.",
            ],
            params: {
                pool: "24 impulses",
                decay: "1.5-1.8 per second for a ~1.5s linger; 2.4 fades in under a second",
                alphaFactor: ".8 of the envelope for a visible trail, and cap it (about .55) on a big drop",
                reach: "60px + amp * 260px",
                grid: "60x36 samples, only if something else reads the displacement",
            },
            verify: "Wiggle the pointer hard and confirm the surface settles back to calm within about two seconds; check the frame stays under budget with all impulses live.",
            pattern: `const POOL = 24;   // fixed: no growth, no per-frame allocation
const buf = Array.from({ length: POOL }, () => ({ x: 0, y: 0, born: -1e9, amp: 0 }));
let head = 0, now = 0;
const DECAY = 2.4;   // per second

function impulse(x, y, amp) {
  head = (head + 1) % POOL;
  buf[head].x = x; buf[head].y = y; buf[head].born = now; buf[head].amp = amp;
}

function displacementAt(px, py) {
  let d = 0;
  for (let i = 0; i < POOL; i++) {
    const r = buf[i];
    const env = Math.exp(-DECAY * (now - r.born)) * r.amp;
    if (env < 0.004) continue;                 // dead impulses skipped before hypot()
    const reach = 60 + r.amp * 260;            // a bigger drop spreads further
    const k = Math.hypot(px - r.x, py - r.y) / reach;
    if (k < 1) d += env * Math.cos(k * Math.PI * 3) * (1 - k) * (1 - k);
  }
  return d;                                    // sum, not max: live impulses interfere
}`,
            sources: [
                {
                    title: "GPU Gems, Chapter 1: Effective Water Simulation from Physical Models (NVIDIA)",
                    url: "https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models",
                    license: "Proprietary — NVIDIA, all rights reserved",
                    adapted: false,
                    change: "Cited, not adapted: this is the classic reference for treating a water surface as a height/displacement field. The impulse pool and the cosine profile above are a deliberately cheaper 2D-canvas version, not the shader approach described there.",
                },
                {
                    title: "MDN: CanvasRenderingContext2D.globalCompositeOperation",
                    url: "https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted — used for the additive ('lighter') stamping mode.",
                },
            ],
        },
        {
            id: "flow-drift",
            name: "Drift along a flow field",
            intent: "Shapes or particles that wander organically across the page with no scripted path.",
            why: "Scripted keyframes move everything on the same rails, and the eye spots the loop within seconds. Advecting items through a slowly rotating noise field produces paths that never visibly repeat while staying calm.",
            do: [
                "Make the motion frame-rate independent: derive a delta from the rAF timestamp and clamp it (dt = min(0.033, (t - last) / 1000)). Without it, the drift runs twice as fast on a 120Hz display as on a 60Hz one.",
                "Rotate the field slowly in time (add t * 0.02 to the field angle). A static field sends every item around the same few loops and the repetition becomes obvious.",
                "Scale the item count to the viewport area — roughly one per 5,500 px^2, capped — so a phone is not asked to run a desktop's worth of particles.",
                "Wrap items at the edges by a margin wider than their blur radius, then keep them drifting; nothing should pop in or out inside the frame.",
                "Cost: one noise sample plus two trig calls per item per frame — about 300 items is 0.25ms of maths, but every drawn shape is a separate paint, so cap the count before you cap quality.",
                "Reduced motion: evaluate the field once at a fixed time, place each item at its starting point and leave them still. Do not keep them drifting at a slower speed.",
            ],
            avoid: [
                "Drawing with fully opaque shapes: additive ('lighter') blending at low alpha with small shapes reads as air or water, whereas opaque dots read as confetti.",
                "Using wall-clock time (Date.now / performance.now) as motion phase: it survives tab switches and makes every item jump on return.",
            ],
            params: { density: "1 per ~5,500 px^2, cap 420", speed: "10-20 px/s", fieldScale: "~900px per noise unit", dtClamp: "0.033s" },
            verify: "Compare drift speed on a 60Hz and a 120Hz display with the devtools FPS meter; they should match. Confirm nothing pops at the viewport edges.",
            sources: [
                {
                    title: "Craig Reynolds: Steering Behaviors For Autonomous Characters (1999)",
                    url: "https://www.red3d.com/cwr/steer/",
                    license: "Proprietary — Craig Reynolds, all rights reserved",
                    adapted: false,
                    change: "Cited, not adapted: the source of the idea that agents follow a local field rather than a scripted path.",
                },
                {
                    title: "MDN: Window.requestAnimationFrame",
                    url: "https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted — used for the timestamp argument that makes motion frame-rate independent.",
                },
            ],
        },
        {
            id: "morphing-shape-geometry",
            name: "Morphing shapes: pick your budget",
            intent: "Giving accents and hero elements an organic form that keeps changing without an animation library.",
            why: "A shape that changes slowly stops a shape-based layout from ever looking static, and it can cost nothing per frame if you choose the right technique. The three techniques differ hugely in cost, and picking the wrong one is the usual reason a calm effect stutters.",
            do: [
                "For large, soft shapes, animate border-radius between two sets of eight percentage values with a long duration (9-18s), animation-direction alternate and an ease-in-out curve. That extra per-item variation is what stops three shapes looking like three copies.",
                "Only interpolate SVG path data in JS when the shape must change topology, and make the command sequences match exactly — same number and type of commands, same winding — or the shape jumps mid-morph.",
                "Loop seamlessly by construction: drive the shape parameters from integer harmonics of one shared phase (t * 2π / period), so the first and last frames are the same shape. Do not rely on easing to hide a discontinuity.",
                "Keep the per-item radius and morph values in your data, seeded from the item's id, rather than in CSS — then a new item gets its own shape without a new rule or a new keyframe.",
                "Cost: a CSS radius morph repaints the element's box, so a large box-shadow or blur on the same element makes it far more expensive; either drop the heavy shadow while it morphs or bake it into the surface behind. Percentage radii follow the box, which keeps small and large items proportionate for free.",
                "Reduced motion: set the final radius values and stop the animation. The shape must still be distinctive without motion, which is exactly why the variation belongs in data.",
            ],
            avoid: [
                "Morphing a shape that contains text: the curve and the type fight, and with a tight radius the text gets clipped. Put the shape behind the text with generous padding, and keep the radius in percentage terms.",
                "Morphing twenty elements at once: this is a paint per element, not a composite.",
            ],
            params: { morphDuration: "9-18s", radii: "8 percentage values", liveShapes: "3-6" },
            sources: [
                {
                    title: "W3C: CSS Backgrounds and Borders Module Level 3 (border-radius)",
                    url: "https://www.w3.org/TR/css-backgrounds-3/#the-border-radius",
                    license: "W3C Document License",
                    adapted: false,
                    change: "Cited, not adapted — checked the eight-value percentage syntax used above.",
                },
                {
                    title: "MDN: SVG path 'd' attribute",
                    url: "https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/d",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted — confirms that path interpolation depends on matching command structure.",
                },
            ],
        },
        {
            id: "submerged-depth-layering",
            name: "Depth, not decoration",
            intent: "Making a flat page read as a space with things behind and in front of each other.",
            why: "A single z-plane is the most common reason a competent layout still feels cheap: everything sits on the paper at the same distance, so the eye has nothing to move between. Depth comes from four cheap signals used together — blur, tint alpha, drift magnitude and scale — not from shadows.",
            do: [
                "Work in exactly three layers and stop: field (the surface, no motion), subject (mid, subtle motion), voice (text — never blurred, never translucent). More layers read as mush, and the text layer is not allowed to lose legibility for atmosphere.",
                "Express depth as one number per item (--depth, 0 at the surface, 1 far below) and derive all four signals from it, so changing the global feel stays coherent instead of being hand-tuned per element.",
                "Keep blur and saturation static per item — they are material properties, not animations. Animating filter: blur() forces a re-rasterisation every frame and is the usual cause of a janky 'premium' effect; animate transform and opacity instead.",
                "Tint mid-layer shapes toward the surface colour at low alpha (multiply) so they read as seen through the surface rather than stuck on the glass, and make drift magnitude and scale fall with depth so the eye reads distance.",
                "Cost: a static blur is composited once per layer, and transform/opacity can run on the compositor off the main thread. Each additional blurred layer still costs GPU memory, so cap them at about four.",
                "Reduced motion: freeze the drift and keep blur, tint and scale exactly as they are — the depth must survive without movement.",
            ],
            avoid: [
                "Using box-shadow as the depth signal: a drop shadow says 'card floating above the page', not 'object suspended in a medium'. Shadow flattens a layered page into a stack of cards.",
                "Blurring or dimming the text layer for atmosphere: contrast is the floor, not a variable.",
            ],
            params: { layers: "3 (cap blurred layers at 4)", blurAtDepth1: "~6px", scaleAtDepth1: "0.82", opacityAtDepth1: "0.58" },
            verify: "Set every --depth to 0 with one CSS variable override and confirm the page loses its sense of space; if it barely changes, the depth signals are too weak.",
            pattern: `/* material: static per layer, all derived from one number */
.subject {
  --depth: .35;
  transform: translate3d(var(--dx), var(--dy), 0) scale(calc(1 - .18 * var(--depth)));
  filter: blur(calc(var(--depth) * 6px)) saturate(calc(1 - .3 * var(--depth)));
  opacity: calc(1 - .42 * var(--depth));
}

/* motion: one shared pointer offset, magnitude falling with depth */
const items = [...document.querySelectorAll("[data-depth]")];
addEventListener("pointermove", (e) => {
  const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
  for (const el of items) {
    const d = +el.dataset.depth;
    el.style.setProperty("--dx", (nx * 26 * (1 - d)) + "px");
    el.style.setProperty("--dy", (ny * 26 * (1 - d)) + "px");
  }
});`,
            sources: [
                {
                    title: "W3C: Filter Effects Module Level 1 (blur())",
                    url: "https://www.w3.org/TR/filter-effects-1/",
                    license: "W3C Document License",
                    adapted: false,
                    change: "Cited, not adapted — used for the definition of the blur radius, not for wording.",
                },
                {
                    title: "MDN: mix-blend-mode",
                    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/mix-blend-mode",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted — used to confirm that blending promotes the element to its own layer.",
                },
                {
                    title: "Apple Human Interface Guidelines",
                    url: "https://developer.apple.com/design/human-interface-guidelines/",
                    license: "Proprietary — Apple Inc., all rights reserved",
                    adapted: false,
                    change: "Cited, not adapted: consulted as an example of depth and material conventions. No Apple text or imagery is reproduced, since the guidelines grant no reuse.",
                },
            ],
        },
        {
            id: "grain-and-texture",
            name: "Grain and material",
            intent: "Giving flat digital surfaces a physical quality so large pale areas stop looking unfinished.",
            why: "Very light, very calm palettes are the hardest to make look deliberate, because a big pale field with nothing in it reads as unfinished rather than minimal. A few percent of grain gives the eye something to resolve and makes everything else look printed instead of painted.",
            do: [
                "Prefer a small repeating tile — a 64px noise PNG under a kilobyte, or a 140px inline SVG feTurbulence data-URI — over a full-screen generated image.",
                "Desaturate the noise explicitly: feTurbulence generates independent noise per colour channel, so without a feColorMatrix saturate 0 in the same filter you get coloured speckle rather than grain, which reads as a rendering fault on a pale background.",
                "Keep the grain layer fixed, pointer-events none, above the content, at 2-5% opacity. Past about 8% it stops reading as material and starts reading as a compression artifact.",
                "Measure before you blend: mix-blend-mode: soft-light or overlay promotes the layer and can cost real time over a large area on a mid-range phone, while a plain low-opacity overlay is usually indistinguishable in a soft palette.",
                "Never put grain, blur or a blend mode over body text: it lowers effective contrast and makes long reading unpleasant. Texture belongs over fields and images, not over paragraphs.",
                "Cost: an SVG feTurbulence filter rasterises once and is then cached as a tiled background, so the per-frame cost is effectively zero — but that first rasterisation is expensive, which is why the tile stays small and never becomes the full viewport.",
                "Reduced motion: nothing to change. Static texture is not animation, and removing it would only make the design flatter for the people who asked for less motion.",
            ],
            avoid: [
                "feTurbulence at full-viewport size: you pay several milliseconds of rasterisation on first paint, exactly when the largest-paint budget is tightest.",
                "Treating grain as content. It buys material quality, not meaning, and it cannot rescue an empty layout.",
            ],
            params: { tile: "64-140px square", opacity: ".02-.05", maxOctaves: "2", blend: "default overlay, measure before soft-light" },
            pattern: `.grain::after {
  content: "";
  position: fixed; inset: 0; z-index: 2;
  pointer-events: none;
  opacity: .035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}`,
            sources: [
                {
                    title: "W3C: Filter Effects Module Level 1 (feTurbulence)",
                    url: "https://www.w3.org/TR/filter-effects-1/#feTurbulenceElement",
                    license: "W3C Document License",
                    adapted: false,
                    change: "Cited, not adapted — used for the primitive's parameters (baseFrequency, numOctaves).",
                },
                {
                    title: "MDN: SVG feTurbulence element",
                    url: "https://developer.mozilla.org/en-US/docs/Web/SVG/Element/feTurbulence",
                    license: "CC BY-SA 2.5 or later",
                    adapted: false,
                    change: "Cited, not adapted — used to confirm the noise types available.",
                },
            ],
        },
    ],
};
