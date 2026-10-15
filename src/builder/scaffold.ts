import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "../config.js";
import type { Concept } from "../concepts.js";
import type { ParsedFile } from "./files.js";

export interface StackInfo {
  kind: "empty" | "vite-react" | "next" | "astro" | "vue" | "svelte" | "other";
  summary: string;
}

export async function detectStack(): Promise<StackInfo> {
  let pkg: any;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(projectDir(), "package.json"), "utf8"));
  } catch {
    return { kind: "empty", summary: "No package.json found (empty project)." };
  }
  const d = { ...pkg.dependencies, ...pkg.devDependencies };
  if (d.next) return { kind: "next", summary: "Next.js" };
  if (d.astro) return { kind: "astro", summary: "Astro" };
  if (d.vue) return { kind: "vue", summary: "Vue" };
  if (d.svelte) return { kind: "svelte", summary: "Svelte" };
  if (d.react && d.vite) return { kind: "vite-react", summary: "Vite + React" };
  return { kind: "other", summary: "an unrecognised stack" };
}

/** Phase 3 has one adapter (Vite + React + TS + GSAP + Lenis). Be explicit about when and why it is used. */
export function decideStack(info: StackInfo): { stack: "vite-react"; reason: string } {
  if (info.kind === "empty") return { stack: "vite-react", reason: "Project is empty, so the default Vite + React + TypeScript + GSAP + Lenis stack is used." };
  if (info.kind === "vite-react") return { stack: "vite-react", reason: "Project already uses Vite + React, which fully supports these concepts. Each variation is a standalone Vite + React app." };
  return {
    stack: "vite-react",
    reason: `Project uses ${info.summary}, but only a Vite + React builder exists so far, so the default stack is used (standalone, your project is untouched). A ${info.summary} adapter is a possible later addition.`,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const quote = (f: string) => `"${f.replace(/"/g, "")}"`;
const fallback = (f: string) => (/mono/i.test(f) ? "ui-monospace, monospace" : "ui-sans-serif, sans-serif");

export const RESERVED = [
  "package.json", "tsconfig.json", "vite.config.ts", "index.html", "src/main.tsx", "src/vite-env.d.ts",
  "src/motion/smooth.ts", "src/motion/sequence.tsx", "src/motion/sequence.css", "src/styles/tokens.css",
];

/**
 * The scroll-driven frame sequence, shipped with every variation.
 *
 * It is deliberately self-contained: frames live in public/sequences/<name>/ with a
 * manifest.json beside them, scroll progress picks the frame, and only a small window
 * around the current frame is ever decoded (so memory stays flat however long the
 * sequence is). The poster stays under the canvas, so the scene reads before the frames
 * arrive, under prefers-reduced-motion, and if anything fails. A module that ignores it
 * costs nothing; the frame budget in the test pass only looks at pages that use it.
 */
const SEQUENCE_TSX = `import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ScrollTrigger, prefersReducedMotion } from "./smooth";
import "./sequence.css";

export interface SequenceManifest {
  /** Total number of frames on disk. */
  frames: number;
  /** File-name pattern relative to /sequences/<name>/, printf style, e.g. "frame-%03d.webp". */
  pattern: string;
  /** Intrinsic pixel size that every frame shares. */
  width: number;
  height: number;
  /** The still shown before the frames load, and the whole scene under reduced motion. */
  poster?: string;
}

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** URL of one frame. Exported so a scene can preload deliberately if it ever needs to. */
export function sequenceFrameUrl(name: string, manifest: SequenceManifest, index: number): string {
  const file = manifest.pattern.replace(/%0?(\\d*)d/, (_match: string, width: string) => pad(index + 1, Number(width) || 1));
  return "/sequences/" + name + "/" + file;
}

export function sequencePosterUrl(name: string, manifest?: SequenceManifest | null): string {
  return "/sequences/" + name + "/" + ((manifest && manifest.poster) || "poster.webp");
}

const isManifest = (v: unknown): v is SequenceManifest => {
  const m = v as SequenceManifest;
  return !!m && typeof m.frames === "number" && m.frames > 1 && typeof m.pattern === "string" && typeof m.width === "number" && typeof m.height === "number";
};

/**
 * A scroll-driven frame sequence. The section is one viewport tall plus scrollLength of
 * travel, the media is sticky inside it, and scroll progress picks the frame.
 *
 * Most of the honesty here is in the fallback: the poster is rendered first and never
 * removed, so the section is complete and still if the frames are slow, disabled by
 * reduced motion, or missing entirely. Only the drawn frame plus a handful of decoded
 * neighbours is ever held in memory.
 */
export function ScrollSequence(o: {
  name: string;
  alt: string;
  scrollLength?: number;
  className?: string;
  children?: ReactNode;
}) {
  const root = useRef<HTMLElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [manifest, setManifest] = useState<SequenceManifest | null>(null);
  const [failed, setFailed] = useState(false);
  const travel = o.scrollLength ?? 140;
  const name = o.name;

  useEffect(() => {
    let alive = true;
    setFailed(false);
    setManifest(null);
    fetch("/sequences/" + name + "/manifest.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("manifest responded " + r.status))))
      .then((json: unknown) => { if (!alive) return; if (isManifest(json)) setManifest(json); else setFailed(true); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [name]);

  useEffect(() => {
    const section = root.current;
    const cv = canvas.current;
    if (!section || !cv || !manifest || failed || prefersReducedMotion()) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const AHEAD = 6;   // frames decoded ahead of the drawn one
    const BEHIND = 3;  // frames kept behind it, so scrolling back is instant
    const frames: (HTMLImageElement | undefined)[] = new Array<HTMLImageElement | undefined>(manifest.frames);
    let wanted = 0;
    let drawn = -1;

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(section.clientWidth * dpr));
      const h = Math.max(1, Math.round(section.clientHeight * dpr));
      if (w !== cv.width || h !== cv.height) { cv.width = w; cv.height = h; }
    };

    const paint = () => {
      let i = Math.max(0, Math.min(wanted, manifest.frames - 1));
      while (i > 0 && !(frames[i] && frames[i]!.complete && frames[i]!.naturalWidth)) i--;
      const el = frames[i];
      if (!el || !el.complete || !el.naturalWidth) return; // hold whatever is already on screen
      const s = Math.max(cv.width / el.naturalWidth, cv.height / el.naturalHeight);
      const w = el.naturalWidth * s;
      const h = el.naturalHeight * s;
      ctx.drawImage(el, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
      if (i !== drawn) { drawn = i; cv.dataset.frame = String(i); }
    };

    const load = (i: number) => {
      if (i < 0 || i >= manifest.frames || frames[i]) return;
      const el = new Image();
      el.decoding = "async";
      el.onload = () => { if (i >= wanted - BEHIND && i <= wanted + AHEAD) paint(); };
      el.src = sequenceFrameUrl(name, manifest, i);
      frames[i] = el;
      if (el.decode) el.decode().catch(() => {});
    };

    const update = () => {
      size();
      for (let i = wanted; i <= wanted + AHEAD; i++) load(i);
      for (let i = 0; i < frames.length; i++) {
        if (frames[i] && (i < wanted - BEHIND || i > wanted + AHEAD)) { frames[i]!.src = ""; frames[i] = undefined; }
      }
      paint();
    };

    update();
    const trigger = ScrollTrigger.create({
      trigger: section,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self: { progress: number }) => { wanted = Math.round(self.progress * (manifest.frames - 1)); update(); },
      onRefresh: () => update(),
    });
    window.addEventListener("resize", update);
    ScrollTrigger.refresh();
    return () => {
      trigger.kill();
      window.removeEventListener("resize", update);
      frames.forEach((el, i) => { if (el) { el.onload = null; el.src = ""; frames[i] = undefined; } });
    };
  }, [manifest, failed, name]);

  return (
    <section ref={root} className={"seq" + (o.className ? " " + o.className : "")} style={{ "--seq-travel": travel + "vh" } as CSSProperties}>
      <div className="seq__view">
        {manifest ? (
          <img
            className="seq__still"
            src={sequencePosterUrl(name, manifest)}
            alt={o.alt}
            loading="lazy"
            onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
          />
        ) : null}
        <canvas className="seq__canvas" ref={canvas} aria-hidden="true" />
        {o.children ? <div className="seq__overlay">{o.children}</div> : null}
      </div>
    </section>
  );
}
`;

const SEQUENCE_CSS = `/* The scroll scene: one viewport of sticky media plus its travel. Owned by src/motion/sequence.tsx. */
.seq {
  position: relative;
  min-height: calc(100dvh + var(--seq-travel, 140vh));
}

.seq__view {
  position: sticky;
  top: 0;
  height: 100dvh;
  overflow: clip;
}

.seq__still,
.seq__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.seq__still { object-fit: cover; }

.seq__canvas {
  /* On top of the still once frames are drawn; transparent before that. */
  display: block;
}

.seq__overlay {
  position: absolute;
  inset: auto 0 0 0;
  display: grid;
  gap: 0.75rem;
  padding: clamp(1.25rem, 4vw, 3rem);
}

@media (prefers-reduced-motion: reduce) {
  .seq { min-height: 100dvh; }
}
`;

export function viteScaffold(o: {
  name: string; title: string; description: string; port: number; fontsHref: string; concept: Concept; extraDeps: string[];
}): ParsedFile[] {
  const p = o.concept.palette;
  const tokens = `:root {
  --color-dominant: ${p.dominant};
  --color-accent: ${p.accent};
  --color-support-1: ${p.support[0] ?? p.dominant};
  --color-support-2: ${p.support[1] ?? p.accent};
  --font-display: ${quote(o.concept.typography.display)}, ${fallback(o.concept.typography.display)};
  --font-body: ${quote(o.concept.typography.body)}, ${fallback(o.concept.typography.body)};
}
`;
  const pkg = {
    name: o.name,
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" },
    dependencies: {
      react: "^19.0.0", "react-dom": "^19.0.0", gsap: "^3.12.5", lenis: "^1.1.0",
      ...Object.fromEntries(o.extraDeps.map((d) => [d, "latest"])),
    },
    devDependencies: {
      vite: "^6.0.0", "@vitejs/plugin-react": "^4.3.4", typescript: "^5.6.0",
      "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0",
    },
  };
  return [
    { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler",
          jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, isolatedModules: true, resolveJsonModule: true,
          types: ["vite/client"],
        },
        include: ["src", "vite.config.ts"],
      }, null, 2) + "\n",
    },
    {
      path: "vite.config.ts",
      content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: ${o.port}, strictPort: true },
  build: { target: "es2022" },
});
`,
    },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(o.title)}</title>
    <meta name="description" content="${esc(o.description)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    ${o.fontsHref ? `<link rel="stylesheet" href="${esc(o.fontsHref)}" />` : "<!-- no web fonts: Google Fonts lookup failed, system fallbacks apply -->"}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    { path: "src/vite-env.d.ts", content: '/// <reference types="vite/client" />\n' },
    {
      path: "src/main.tsx",
      content: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "lenis/dist/lenis.css";
import "./styles/tokens.css";
import "./styles/global.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`,
    },
    {
      path: "src/motion/smooth.ts",
      content: `import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Smooth scrolling wired into GSAP's ticker. Returns a cleanup function. Skipped when reduced motion is requested. */
export function initSmoothScroll(): () => void {
  if (prefersReducedMotion()) return () => {};
  const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (t: number) => lenis.raf(t * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);
  return () => {
    gsap.ticker.remove(tick);
    lenis.destroy();
  };
}

export { gsap, ScrollTrigger };
`,
    },
    { path: "src/motion/sequence.tsx", content: SEQUENCE_TSX },
    { path: "src/motion/sequence.css", content: SEQUENCE_CSS },
    { path: "src/styles/tokens.css", content: tokens },
  ];
}
