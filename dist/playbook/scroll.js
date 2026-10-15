/**
 * Scroll-linked motion. The websites people point at as "premium" almost always have one
 * moment where scroll position drives a scene instead of merely triggering a reveal — the
 * object turns, the camera pushes in, the product comes apart. This topic covers how that
 * is actually built, what each technique costs, and how it degrades.
 *
 * The rule behind every entry: scroll is an input, not a permission slip. Something bound
 * to scroll must be equally readable when the user stops moving, must never fight the
 * scroll itself, and must resolve to a still frame under prefers-reduced-motion.
 */
export const SCROLL_TOPIC = {
    id: "scroll",
    title: "Scroll-linked motion (scrollytelling)",
    summary: "Scroll position as the animation clock: canvas image sequences, scrubbed video, CSS scroll timelines, and how each one degrades. Use it when one moment in the page should be driven by the scroll itself rather than revealed by it.",
    entries: [
        {
            id: "scroll-linked-vs-triggered",
            name: "Scroll-linked, not scroll-triggered",
            intent: "Decide whether a section should be *driven* by scroll position or merely *revealed* by it, then pick the cheapest technique that carries the idea.",
            why: "A reveal (fade up when it enters) is cheap and forgettable; a scene whose state is a function of scroll reads as authored and is what reviewers mean by cinematic. The distinction also decides the cost: linked motion animates every frame the user scrolls, triggered motion animates once.",
            do: [
                "Write the dependency down first: 'at 0% the device is closed and front-on, at 100% it is open and turned 40°' — a scene that cannot be described as a start state, an end state and a quantity that interpolates between them is not a scroll scene yet.",
                "Prefer scroll-triggered for anything that is only a state change: entering copy, cards, a nav bar shrinking. One linked scene per page is the budget; two compete for attention and for frame time.",
                "Give the linked scene a travel of roughly one extra viewport (100-160vh) so a normal flick covers it, and pin it with a sticky container instead of GSAP `pin` — sticky cannot double-count scroll while Lenis is smoothing it.",
                "Choose the technique by asset, not by taste: canvas image sequence when the frames must match exactly (product, camera move, timeline scrub); scrubbed video when the file must stay small and motion is soft; transform/`clip-path`/`filter` against scroll progress when the subject is DOM, not photography; WebGL when the scene is genuinely three-dimensional.",
                "Keep the interpolated quantity continuous and cheap: one progress value 0-1, converted at the point of use. Never read scroll position in several places and reconcile them.",
                "Motion still communicates the same thing as before — direction of change, relationships, feedback (duration-by-distance, easing-by-role). Scroll only replaces the clock, not the choreography.",
                "Under prefers-reduced-motion the scene resolves to a single frame plus its copy (scroll-scene-floor); the scene must also be fully readable with JavaScript disabled, because the frames are photography and the copy is text.",
            ],
            avoid: [
                "Scroll-jacking: hijacking wheel/touch so the page moves at your speed. Lenis smooths; it must not trap — always keep the native scrollbar and keyboard paging working.",
                "A scrub so fast that nothing is legible, or so slow that the user scrolls two screens for one degree of rotation. Test at a flick, not at a trackpad creep.",
                "Decorative scroll parallax on text the user is reading — it costs frame time and buys nothing.",
            ],
            params: {
                "travel": "100-160vh of scroll for the scene",
                "linked scenes per page": "1",
                "progress": "a single 0-1 value per scene",
                "scrub smoothness": "0.3-1.0s of catch-up; 0 = rigidly attached, above ~1.2s it feels laggy under Lenis",
            },
            verify: "Scroll through the scene with the mouse wheel, then stop mid-travel: the frame must hold still and legible (no running animation), and the section must still read as one idea in a screenshot. Then check the scene works when you land on it with a keyboard Page Down.",
            sources: [
                {
                    title: "Chrome for Developers — case study: image sequence scrubbing on a news site (NRK)",
                    url: "https://developer.chrome.com/blog/nrk-casestudy",
                    license: "CC BY 4.0 (Google developer documentation)",
                    adapted: false,
                    change: "cited, not adapted — used as evidence that a canvas image sequence is the production technique behind scroll-scrubbed footage; the composition rules here are this playbook's own",
                },
                {
                    title: "GSAP — ScrollTrigger documentation",
                    url: "https://gsap.com/docs/v3/Plugins/ScrollTrigger/",
                    license: "proprietary (GSAP standard no-charge licence)",
                    adapted: false,
                    change: "cited, not adapted — consulted for the scrub/pinning behaviour that this entry recommends against using where a sticky container does the job",
                },
            ],
        },
        {
            id: "scrub-sequence-canvas",
            name: "Scrubbed frame sequence on a canvas",
            intent: "Drive a scene frame by frame from scroll position, at a quality no encoder will give you, with a decode window instead of a preloaded pile.",
            why: "The printed frame is chosen by you, so the motion is exactly as sharp and slow as intended and the scrub rate is independent of file structure. The cost moves from bandwidth to decoded memory, which is the part that must be bounded deliberately.",
            do: [
                "Ship an image per step, not a strip: encode frames as WebP (fallback JPEG) at the measured long edge, quality ~80. Budget 10-30 KB per frame, so 90 frames is roughly 0.9-2.7 MB total.",
                "Pick frame count from travel and scrub speed, not from the source clip's frame rate: 60-150 frames for a one-viewport scene, where consecutive frames differ by 1.5-3% of total travel. Fewer than ~48 frames of a fast camera move reads as a flicker book.",
                "Sizing: draw the frames at 1-1.5× the largest CSS box they appear in, and cap canvas backing-store DPR at 2. A 2×-DPR canvas costs 4× the pixels for no visible gain on a moving image.",
                "Keep decoded frames in a bounded sliding window (the drawn frame plus a handful ahead), and drop images behind the window by clearing their `src` and reference. Memory per decoded frame is width × height × 4 bytes: 960×540 is 1.98 MiB and 1280×720 is 3.52 MiB, so a hundred 720p frames held at once is 352 MiB and will be killed on a phone.",
                "Draw with cover maths by hand (scale = max(boxW/frameW, boxH/frameH), centred) so the canvas never letterboxes or inherits the frame's aspect.",
                "Show a poster image (a real still, compressed as one) in the same box before the sequence loads, and never let the canvas be the largest contentful paint: mark it `aria-hidden` and let the heading or the poster carry LCP.",
                "Use `img.decode()` (or an `ImageBitmap`) when warming a frame so decoding happens off the critical path, and hold the last drawn frame if the wanted one is not ready — never draw blank.",
                "Label the scene for assistive technology with real text: an adjacent heading and description, plus `alt` text on the poster. The canvas itself is decoration and should be hidden from the accessibility tree.",
            ],
            avoid: [
                "Preloading all frames on mount: it delays everything else and raises peak memory for frames most sessions never reach.",
                "One giant sprite sheet — it defeats the browser's ability to decode only the window you need.",
                "Driving the frame index from a rAF loop that recomputes scroll position; latch it to the scroll progress the scroll library already publishes.",
                "Forgetting the resize path: draw again on resize and on orientation change, or the canvas keeps a stale backing-store size and the image skews.",
            ],
            pattern: `// one progress value -> one frame, with a bounded decode window
const img = new Array(manifest.frames);           // slots, filled lazily
const load = (i) => { if (i < 0 || i >= manifest.frames || img[i]) return;
  const el = new Image(); el.decoding = "async"; el.src = url(i);
  img[i] = el; el.decode?.().catch(() => {}); };
const trim = (keep) => img.forEach((el, i) => {
  if (el && !keep.has(i)) { el.src = ""; img[i] = undefined; } });   // free decoded data

function draw(index, progress) {
  const WINDOW = 6;
  for (let i = index; i <= index + WINDOW; i++) load(i);            // ahead only
  trim(new Set(Array.from({ length: WINDOW + 4 }, (_, k) => index - 3 + k)));
  let pick = index; while (pick > 0 && !img[pick]?.complete) pick--; // nearest ready frame
  const el = img[pick];
  if (!el?.complete) return;
  const { width: cw, height: ch } = canvas;
  const s = Math.max(cw / el.naturalWidth, ch / el.naturalHeight);
  const w = el.naturalWidth * s, h = el.naturalHeight * s;
  ctx.drawImage(el, (cw - w) / 2, (ch - h) / 2, w, h);
  canvas.style.setProperty("--seq-progress", String(progress));
}`,
            params: {
                "frames": "60-150 per scene",
                "frame bytes": "10-30 KB WebP at quality ~80",
                "long edge": "1-1.5× the largest CSS box, capped at 1600 px",
                "decode window": "drawn frame + 6 ahead, ~4 kept behind",
                "canvas DPR": "capped at 2",
            },
            verify: "In DevTools watch Memory while scrubbing the whole scene: the decoded-image footprint should plateau rather than climb, then drop when the scene leaves the viewport. On a real phone, scroll the scene twice and confirm it does not reload/jank the second time.",
            sources: [
                {
                    title: "MDN — Canvas API, drawImage and image decoding",
                    url: "https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage",
                    license: "CC BY-SA 2.5 (share-alike — cite only, do not adapt)",
                    adapted: false,
                    change: "cited, not adapted — used to confirm the drawing and decoding primitives; the windowing logic here is this playbook's own",
                },
                {
                    title: "Chrome for Developers — case study: image sequence scrubbing on a news site (NRK)",
                    url: "https://developer.chrome.com/blog/nrk-casestudy",
                    license: "CC BY 4.0 (Google developer documentation)",
                    adapted: false,
                    change: "cited, not adapted — the frame-count and payload targets are derived from the numbers reported there plus this playbook's own budget",
                },
            ],
        },
        {
            id: "scrub-video-keyframes",
            name: "Scrubbed video, and why seeking is not frame-accurate",
            intent: "Use a video file as the scroll-driven source only when the download size matters more than exact frames, and encode it so seeking does not stutter.",
            why: "A video is far smaller than the same motion as an image sequence, but setting `currentTime` is a seek, not a frame step: the decoder jumps to the nearest keyframe and decodes forward, so the visible frame depends on encoding, hardware and load. Understanding that is the difference between 'video scrubbing is broken' and 'video scrubbing is fine for soft motion'.",
            do: [
                "Reach for video when the motion is slow and continuous (a camera push, smoke, a gradient) and the exact frame does not matter. Use a canvas sequence when the subject must be crisp on every step (scrub-sequence-canvas).",
                "Encode for seeking, not for streaming: a keyframe every 0.25-0.5s (at 24-30 fps that is `-g 12` to `-g 15` with `-keyint_min` matching), no B-frame reordering tricks, and a modest file: 2-6 MB of AV1/WebM or H.264 MP4 for a 5-10s clip.",
                "Trim the clip to the scene length and use `preload=\"auto\"` on a silent, `muted` + `playsinline` element so the decoder has the data before the user arrives.",
                "Round the target frame before assigning: `video.currentTime = Math.round(p * steps) / steps * duration`, and never chase every scroll event — one assign per rendered frame.",
                "Expect and absorb imperfection: keep the last painted frame on screen, ease the visible value towards the target tolerance instead of snapping, and treat a slow seek as a held frame rather than a glitch.",
                "If the frame must be exact and the browser allows it, decode with WebCodecs (`VideoDecoder` + `VideoFrame`) instead of a `<video>` element — it gives you real frames, at the cost of writing the whole pipeline yourself.",
                "Autoplay rules still apply even though you are not playing: `muted`, `playsinline`, and no sound on a scroll-driven clip.",
            ],
            avoid: [
                "Treating a scrub as a playhead: `play()`/`pause()` churn on scroll will fight the user and burn battery.",
                "A long, dark, low-bitrate clip for a full-size hero — banding in a moving image reads as cheap.",
                "Gating the scene on `canplaythrough` and leaving a blank box until then; show the poster.",
                "Assuming the same clip seeks equally well on iOS Safari, Android Chrome and a laptop: verify on the phone you can borrow, because keyframe and decoder behaviour differ.",
            ],
            params: {
                "keyframe interval": "0.25-0.5 s (`-g 12` to `-g 15` at 24-30 fps)",
                "clip length": "5-10 s, trimmed to the scene",
                "file size": "2-6 MB",
                "seeks per second": "at most one per rendered frame (60 or fewer)",
            },
            verify: "Record the scrub on a real phone at normal speed, then step through the recording frame by frame: the held/stale frames should read as a slight softening, not as snapping backwards. Compare against the same scene encoded at the default 2s keyframe interval to see the difference the encoding makes.",
            sources: [
                {
                    title: "MDN — HTMLMediaElement.currentTime (seeking behaviour)",
                    url: "https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime",
                    license: "CC BY-SA 2.5 (share-alike — cite only, do not adapt)",
                    adapted: false,
                    change: "cited, not adapted — consulted for the specification of seeking and seekable ranges",
                },
                {
                    title: "MDN — WebCodecs API (VideoDecoder, VideoFrame)",
                    url: "https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API",
                    license: "CC BY-SA 2.5 (share-alike — cite only, do not adapt)",
                    adapted: false,
                    change: "cited, not adapted — the frame-accurate alternative to element seeking",
                },
            ],
        },
        {
            id: "css-scroll-timelines",
            name: "CSS scroll timelines as the cheap half",
            intent: "Bind keyframes to scroll progress in CSS with no JavaScript listener, and treat it as progressive enhancement over a JavaScript fallback.",
            why: "A scroll timeline runs on the compositor, so transform and opacity driven this way keep animating smoothly even when the main thread is busy — the cheapest scroll-linked motion available in a browser. It is also the youngest feature here, which is exactly why it needs a fallback plan rather than a rewrite.",
            do: [
                "Bind with `animation-timeline: scroll()` for the whole scroller or `view()` for one element's passage through the viewport, and scope the range with `animation-range` rather than hand-computing percentages.",
                "Give the element a named timeline (`scroll-timeline-name: --scene`) when more than one element shares the timeline, and read it back with `animation-timeline: --scene`.",
                "Keep to transform, opacity, `clip-path` and `filter`: those are the properties the compositor can run. Animating layout properties on a scroll timeline is the one way to make this technique as expensive as the JavaScript version.",
                "Feature-detect, don't version-sniff: wrap the CSS in `@supports (animation-timeline: scroll())` and keep the non-animated state as the base rule, so a browser without support gets a complete, static page.",
                "When the scene must exist for everyone, keep the JavaScript path (GSAP + ScrollTrigger, or a progress value from your scroll library) as the real implementation and let the CSS timeline be the nicety — two implementations of one scene is a maintenance cost worth paying only for the hero moment.",
                "Same contract as every other technique in this topic: no timeline under prefers-reduced-motion (scroll-scene-floor).",
            ],
            avoid: [
                "Assuming support because it worked in the browser you develop in; the feature arrived in different years in different engines.",
                "Using a scroll timeline for a scene that also needs JavaScript state (a pinned canvas, a video seek) — mixing clocks on one element is how timelines and listeners drift apart.",
                "`animation-timeline` on an element inside a scroll container that is not the scroller you meant; name the timeline explicitly when in doubt.",
            ],
            pattern: `/* base state first: correct with no scroll timeline at all */
.reveal { opacity: 1; translate: none; }

@supports (animation-timeline: scroll()) {
  @media (prefers-reduced-motion: no-preference) {
    .reveal {
      animation: rise linear both;
      animation-timeline: view();               /* this element's passage */
      animation-range: entry 15% cover 55%;
    }
  }
}
@keyframes rise { from { opacity: 0; translate: 0 4rem; } }`,
            params: {
                "animation-range": "entry 10-25% -> cover 45-60% for a reveal",
                "properties": "transform, opacity, clip-path, filter only",
                "fallback": "the unanimated base state, always written first",
            },
            verify: "Count the support you have: `CSS.supports('animation-timeline: scroll()')` in each browser you care about, plus one real session on the oldest Safari you support. Then confirm with the JavaScript disabled that the base state is the finished layout, not a blank box.",
            sources: [
                {
                    title: "W3C CSS Scroll-driven Animations (scroll-animations-1)",
                    url: "https://drafts.csswg.org/scroll-animations-1/",
                    license: "W3C Document License (no derivative works — cite only)",
                    adapted: false,
                    change: "cited, not adapted — the property names (animation-timeline, animation-range, view()) are the specification's",
                },
                {
                    title: "Chrome for Developers — scroll-driven animations",
                    url: "https://developer.chrome.com/docs/css-ui/scroll-driven-animations",
                    license: "CC BY 4.0 (Google developer documentation)",
                    adapted: false,
                    change: "cited, not adapted — consulted for the compositor-thread behaviour and the range syntax; support dates must be re-checked against current browser release notes, not this entry",
                },
            ],
        },
        {
            id: "scroll-scene-floor",
            name: "The scroll scene's floor: still, cheap, and quiet",
            intent: "Make the scroll scene survive reduced motion, phones, slow connections and the accessibility tree before it is allowed on the page.",
            why: "A scene that only exists while motion is allowed, or only on a fast machine, is a decoration with a failure mode. Designing the still first — and measuring frame time during the scrub rather than after it — is what separates a scene that ships from one that gets pulled.",
            do: [
                "Under prefers-reduced-motion, do not slow the scene down: show the poster still at the scene's most informative frame, keep the copy, and remove the scrub entirely. Scroll-linked camera motion is precisely the motion preference that exists to prevent.",
                "Treat the poster as the real fallback art: it is what loads on a slow connection, what the reduced-motion user sees, and what prints if the scene fails. Choose it deliberately (the 30-50% frame of the travel) and compress it as a normal image.",
                "Budget the scene as one asset group and keep it out of the first-screen critical path: `loading=\"lazy\"` on the poster, frames fetched only once the section is within about a viewport, and no more than roughly 3 MB of frames for a scene (page-weight and the sequence check in this server enforce it).",
                "Measure the scrub, not the page: record frame times while a scripted wheel passes through the scene and require p95 under 34 ms there, which is where a heavy sequence shows up and a static screenshot never will.",
                "Degrade in stages rather than failing whole: reduced motion -> still; save-data or 2G (`navigator.connection.saveData`, `effectiveType`) -> still; smaller viewport -> fewer pixels drawn (not fewer frames); no JavaScript -> the still plus copy.",
                "Keep the scene's text out of the canvas: heading, description and any call to action are real DOM elements in the flow, so the section is meaningful and searchable even if nothing ever draws.",
                "Leave the scrollbar and keyboard navigation untouched, and make the scene's own affordances real buttons and links — a scene you can only operate with a trackpad is not finished.",
            ],
            avoid: [
                "A silently looping version of the same motion as the reduced-motion fallback.",
                "Making the scene a full-screen fixed layer that swallows clicks, or a canvas without `aria-hidden` and an adjacent description.",
                "Loading the frames on page load 'so the scene is ready' — that is the fastest way to lose the metric the scene is supposed to earn.",
                "Testing only on the machine you built it on: a phone in low-power mode throttles animation frames, and the scene is the first thing to look broken.",
            ],
            params: {
                "p95 frame time during scrub": "<= 34 ms",
                "frames fetched": "when the section is within ~1 viewport",
                "scene asset budget": "~3 MB (see the server's page-weight gate)",
                "still frame choice": "the 30-50% frame of the travel",
            },
            verify: "Run the test pass with reduced motion on and confirm the section is complete and still; run it with the network throttled and confirm the still appears immediately; scroll the scene while recording Performance and check that long tasks do not coincide with the scrub.",
            sources: [
                {
                    title: "W3C/WAI — Understanding Success Criterion 2.3.3 Animation from Interactions (and the prefers-reduced-motion media query)",
                    url: "https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html",
                    license: "W3C Document License (no derivative works — cite only)",
                    adapted: false,
                    change: "cited, not adapted — the requirement that motion triggered by interaction can be disabled",
                },
                {
                    title: "web.dev — prefers-reduced-motion and honoring user motion preferences",
                    url: "https://web.dev/articles/prefers-reduced-motion",
                    license: "CC BY 4.0 (Google developer documentation)",
                    adapted: false,
                    change: "cited, not adapted — the practice list here is this playbook's own; the media query and its intent come from the sources",
                },
            ],
        },
    ],
};
