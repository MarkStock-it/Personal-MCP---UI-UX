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
  "src/motion/smooth.ts", "src/styles/tokens.css",
];

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
    { path: "src/styles/tokens.css", content: tokens },
  ];
}
