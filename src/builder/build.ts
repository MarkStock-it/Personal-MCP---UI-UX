import fs from "node:fs/promises";
import path from "node:path";
import { briefToText, type Brief } from "../brief.js";
import type { Concept } from "../concepts.js";
import { apiKeyFor, loadConfig, projectDir, type BuildConfig } from "../config.js";
import { generateImage, generateText } from "../providers/index.js";
import { allRules, rulesPrompt } from "../rules.js";
import type { ChatMessage } from "../types.js";
import { run } from "../util/exec.js";
import type { Limit } from "../util/limit.js";
import { exportLines, parseFileBlocks, safeRel, writeFiles, type ParsedFile } from "./files.js";
import { fontsUrl, resolveFontParam } from "./fonts.js";
import { makePlan, type Plan } from "./plan.js";
import { buildSystem } from "./prompts.js";
import { RESERVED, viteScaffold } from "./scaffold.js";
import { installSequences, renderSequenceList } from "./sequences.js";

export interface Ctx {
  cfg: BuildConfig;
  llm: Limit;      // bounds concurrent model calls across all variations
  installs: Limit; // bounds concurrent npm installs
  log: (m: string) => void;
}

export interface VariationResult {
  id: string;
  name: string;
  dir: string;
  port: number;
  status: "built" | "built-with-type-errors" | "failed";
  notes: string[];
  error?: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "concept";

/** Call the builder model for files, retrying with feedback until all expected files arrive complete. */
async function genFiles(ctx: Ctx, system: string, user: string, expected: string[], what: string): Promise<ParsedFile[]> {
  const messages: ChatMessage[] = [{ role: "user", content: user }];
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await ctx.llm(() => generateText("builder", { system, messages, maxTokens: 12000 }));
    const { files, unterminated } = parseFileBlocks(reply.text);
    const byPath = new Map(files.map((f) => [safeRel(f.path) ?? f.path, f]));
    const missing = expected.filter((p) => !byPath.has(p));
    if (!missing.length && !unterminated) return expected.map((p) => byPath.get(p)!);

    ctx.log(`${what}: incomplete output (attempt ${attempt + 1}), retrying`);
    messages.push(
      { role: "assistant", content: reply.text },
      {
        role: "user",
        content: [
          unterminated ? `The file ${unterminated} was cut off or not closed with === END FILE ===.` : "",
          missing.length ? `Missing files: ${missing.join(", ")}.` : "",
          "Return ALL requested files again in full and in the required format. Be more compact if needed: shorter CSS, fewer variants, but keep the concept intact.",
        ].filter(Boolean).join(" "),
      }
    );
  }
  throw new Error(`${what}: the builder model could not return complete files after 3 attempts.`);
}

function sharedContext(concept: Concept, brief: Brief, tokens: string, images: { file: string; shape: string; usage: string }[], sequenceText: string, plan: Plan, extraDeps: string[]): string {
  const { id: _i, status: _s, ...core } = concept;
  return [
    "APPROVED CONCEPT", JSON.stringify(core, null, 1),
    "BRIEF (real material, keep copy faithful to it)", briefToText(brief),
    "DESIGN TOKENS (src/styles/tokens.css, already exists)", tokens,
    images.length
      ? "AVAILABLE IMAGES (use these exact paths)\n" + images.map((i) => `- /images/${i.file} (${i.shape}): ${i.usage}`).join("\n")
      : "AVAILABLE IMAGES: none. Draw everything in SVG/CSS.",
    sequenceText,
    `INSTALLED EXTRA PACKAGES: ${extraDeps.length ? extraDeps.join(", ") : "none"}`,
    "SITE PLAN, in reading order\n" +
      plan.modules.map((m, i) => `${i + 1}. ${m.name}: ${m.brief}\n   files: ${m.files.map((f) => f.path).join(", ")}\n   copy export in src/content.ts: ${m.contentExport}\n   exports: ${m.exports}`).join("\n"),
  ].filter(Boolean).join("\n\n");
}

async function installAndBuild(ctx: Ctx, root: string, tag: string) {
  const cfg = ctx.cfg;
  ctx.log(`${tag} npm install`);
  const inst = await ctx.installs(() => run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], root, cfg.installTimeoutSec * 1000));
  if (inst.code !== 0) return { ok: false as const, stage: "install", out: inst.timedOut ? "npm install timed out" : inst.out.slice(-3000) };
  ctx.log(`${tag} npm run build`);
  const b = await run("npm", ["run", "build"], root, cfg.buildTimeoutSec * 1000);
  return b.code === 0 ? { ok: true as const, stage: "build", out: "" } : { ok: false as const, stage: "build", out: b.timedOut ? "build timed out" : b.out.slice(-6000) };
}

export async function buildVariation(o: { concept: Concept; brief: Brief; index: number; overwrite: boolean; ctx: Ctx }): Promise<VariationResult> {
  const { concept: c, brief, ctx } = o;
  const cfg = ctx.cfg;
  const tag = `[${c.id}]`;
  const log = (m: string) => ctx.log(`${tag} ${m}`);
  const dirName = `${c.id}-${slug(c.name)}`;
  const root = path.join(projectDir(), "variations", dirName);
  const port = cfg.firstPort + o.index;
  const notes: string[] = [];
  const done = (status: VariationResult["status"], error?: string): VariationResult => ({
    id: c.id, name: c.name, dir: path.relative(projectDir(), root), port, status, notes, ...(error ? { error } : {}),
  });

  try {
    const exists = await fs.access(root).then(() => true, () => false);
    if (exists) {
      if (!o.overwrite) return done("failed", `${dirName} already exists. Re-run with overwrite=true to replace it.`);
      await fs.rm(root, { recursive: true, force: true });
    }

    // Fonts (verified against Google Fonts so a bad axis spec cannot silently break typography)
    const [dp, bp] = await Promise.all([resolveFontParam(c.typography.display), resolveFontParam(c.typography.body)]);
    if (!dp) notes.push(`Display font "${c.typography.display}" was not found on Google Fonts; a fallback font is used.`);
    if (!bp) notes.push(`Body font "${c.typography.body}" was not found on Google Fonts; a fallback font is used.`);
    const fontParams = [...new Set([dp, bp].filter((x): x is string => !!x))];

    // Plan
    log("planning implementation");
    const rules = rulesPrompt(await allRules());
    const { plan, warnings: planWarnings } = await ctx.llm(() => makePlan(c, brief, cfg, rules));
    for (const w of planWarnings) notes.push(`Plan warning (model could not fix): ${w}.`);
    log(`plan: ${plan.modules.map((m) => m.name).join(", ")}`);

    // Images
    const images: { file: string; shape: string; usage: string }[] = [];
    let imageKeyOk = true;
    if (plan.images.length) {
      try { apiKeyFor(loadConfig().config.roles.image.provider); } catch (e) { imageKeyOk = false; notes.push(`${msg(e)} Images were skipped; everything is code-drawn.`); }
    }
    if (imageKeyOk) {
      await Promise.all(plan.images.map((img) => ctx.llm(async () => {
        try {
          const r = await generateImage({ prompt: img.prompt, shape: img.shape });
          const ext = r.mediaType.includes("jpeg") ? "jpg" : r.mediaType.includes("webp") ? "webp" : "png";
          const file = `${img.name}.${ext}`;
          await fs.mkdir(path.join(root, "public", "images"), { recursive: true });
          await fs.writeFile(path.join(root, "public", "images", file), Buffer.from(r.base64, "base64"));
          images.push({ file, shape: img.shape, usage: img.usage });
          log(`image ${file} done`);
        } catch (e) {
          notes.push(`Image "${img.name}" failed (${msg(e)}); code-drawn fallback used.`);
        }
      })));
      images.sort((a, b) => a.file.localeCompare(b.file));
    }

    // Scroll scenes: sequences prepared in this project are copied in and offered to the builder.
    const sequences = await installSequences(root);
    if (sequences.length) log(`scroll sequences: ${sequences.map((s) => `${s.name} (${s.frames} frames)`).join(", ")}`);

    // Scaffold
    const title = brief.project.split(/[:\n]/)[0].replace(/[#*_`]/g, "").trim() || c.name;
    const scaffold = viteScaffold({
      name: `variation-${dirName}`, title, description: brief.project.replace(/[#*_`\n]/g, " ").trim().slice(0, 155),
      port, fontsHref: fontParams.length ? fontsUrl(fontParams) : "", concept: c, extraDeps: plan.extraDependencies,
    });
    await writeFiles(root, scaffold);
    const tokens = scaffold.find((f) => f.path === "src/styles/tokens.css")!.content;
    const system = buildSystem(rules);
    const shared = sharedContext(c, brief, tokens, images, sequences.length ? renderSequenceList(sequences) : "", plan, plan.extraDependencies);
    const written = new Map<string, string>();

    // 1) Foundation: all copy + global styles
    log("writing copy and global styles");
    const foundation = await genFiles(ctx, system, [
      shared,
      "YOUR TASK: write exactly these two files: src/content.ts and src/styles/global.css.",
      "src/content.ts: ALL visible copy for the site as exported, typed constants. Export one const per module using exactly its copy export name from the plan, plus export const site = { name, tagline, ... } for shared strings. Use the real material from the brief. Where the brief lacks specifics, write plausible, modest specifics in the project's voice and keep them consistent. Voice: " + c.voice.description,
      "src/styles/global.css: modern reset, base typography using var(--font-body) and var(--font-display), a fluid type scale as custom properties (--step--1 to --step-5, using clamp()), body background and text colour from the tokens, ::selection, a visible :focus-visible ring, .sr-only, and reduced-motion basics. Do NOT style sections or components here; modules own their layout.",
    ].join("\n\n"), ["src/content.ts", "src/styles/global.css"], "foundation");
    await writeFiles(root, foundation);
    foundation.forEach((f) => written.set(f.path, f.content));
    const contentSrc = written.get("src/content.ts")!;

    // 2) Feature modules, in parallel (bounded by the shared limiter)
    await Promise.all(plan.modules.map(async (m) => {
      log(`writing module ${m.name}`);
      const paths = m.files.map((f) => safeRel(f.path)!);
      const files = await genFiles(ctx, system, [
        shared,
        "COPY FILE (src/content.ts, already written; use its exact export names and property names):\n" + contentSrc,
        `YOUR TASK: implement the module "${m.name}": ${m.brief}`,
        `Write exactly these files: ${paths.join(", ")}.`,
        `File purposes:\n${m.files.map((f) => `- ${f.path}: ${f.purpose}`).join("\n")}`,
        `Import your copy with: import { ${m.contentExport} } from "<relative path to src/content>". ${m.exports}.`,
        "Style your own markup in your own .css file with class names prefixed by the module name to avoid clashes. Do not rely on classes from other modules.",
      ].join("\n\n"), paths, `module ${m.name}`);
      await writeFiles(root, files);
      files.forEach((f) => written.set(f.path, f.content));
      log(`module ${m.name} done`);
    }));

    // 3) App composition
    log("composing App");
    const exportsBlock = plan.modules.map((m) => {
      const tsx = m.files.map((f) => safeRel(f.path)!).find((p) => p.endsWith(".tsx"))!;
      return `${m.name} (${tsx}):\n${exportLines(written.get(tsx) ?? "")}`;
    }).join("\n\n");
    const [app] = await genFiles(ctx, system, [
      shared,
      "ACTUAL EXPORTS OF EACH MODULE:\n" + exportsBlock,
      "YOUR TASK: write exactly src/App.tsx (and nothing else). Compose all modules in reading order inside a <main>, with a skip-to-content link first. Call initSmoothScroll() from ../motion/smooth inside a useEffect and return its cleanup. Import each module's component using its real export as listed above. Any cross-module choreography that the concept needs (shared scroll progress, cursor effects) belongs here.",
    ].join("\n\n"), ["src/App.tsx"], "App");
    await writeFiles(root, [app]);
    written.set(app.path, app.content);

    // 4) Install, build, repair
    let result = await installAndBuild(ctx, root, tag);
    if (!result.ok && result.stage === "install") return done("failed", `npm install failed: ${result.out}`);

    for (let round = 1; !result.ok && round <= cfg.repairRounds; round++) {
      log(`build failed, repair round ${round}/${cfg.repairRounds}`);
      const mentioned = [...new Set([...result.out.matchAll(/(src\/[\w./-]+\.(?:tsx?|css))/g)].map((m) => m[1]))].filter((p) => written.has(p));
      if (!mentioned.length) break;
      const reply = await ctx.llm(() => generateText("builder", {
        system,
        maxTokens: 12000,
        messages: [{
          role: "user",
          content: [
            "The project failed to build. Fix the errors with the smallest changes that keep the design intact.",
            `BUILD OUTPUT:\n${result.out}`,
            "CURRENT FILES:\n" + mentioned.map((p) => `=== FILE: ${p} ===\n${written.get(p)}=== END FILE ===`).join("\n"),
            `Installed packages are only: react, react-dom, gsap, lenis${plan.extraDependencies.length ? ", " + plan.extraDependencies.join(", ") : ""}. Return the full corrected content of every file you change, in the required format.`,
          ].join("\n\n"),
        }],
      }));
      const { files } = parseFileBlocks(reply.text);
      const fixes = files.filter((f) => { const r = safeRel(f.path); return r && r.startsWith("src/") && !RESERVED.includes(r); });
      if (!fixes.length) break;
      await writeFiles(root, fixes);
      fixes.forEach((f) => written.set(safeRel(f.path)!, f.content));
      ctx.log(`${tag} npm run build (after repair)`);
      const b = await run("npm", ["run", "build"], root, cfg.buildTimeoutSec * 1000);
      result = b.code === 0 ? { ok: true, stage: "build", out: "" } : { ok: false, stage: "build", out: b.out.slice(-6000) };
    }

    let status: VariationResult["status"] = "built";
    if (!result.ok) {
      const loose = await run("npx", ["vite", "build"], root, cfg.buildTimeoutSec * 1000);
      if (loose.code === 0) {
        status = "built-with-type-errors";
        notes.push("Type check still fails, but the site bundles and runs. Remaining errors:\n" + result.out.slice(0, 700));
      } else {
        return done("failed", "Build failed after repairs:\n" + result.out.slice(0, 1200));
      }
    }

    await fs.writeFile(path.join(root, "design-mcp.json"), JSON.stringify({ conceptId: c.id, concept: c.name, port, status, files: [...written.keys()], images: images.map((i) => i.file), sequences: sequences.map((s) => s.name) }, null, 2));
    log(`done: ${status}`);
    return done(status);
  } catch (e) {
    return done("failed", msg(e));
  }
}
