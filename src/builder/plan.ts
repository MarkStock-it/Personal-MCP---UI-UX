import { z } from "zod";
import { briefToText, type Brief } from "../brief.js";
import { loopJson, type Concept } from "../concepts.js";
import type { BuildConfig } from "../config.js";
import { safeRel } from "./files.js";
import { RESERVED } from "./scaffold.js";

export const PlanSchema = z.object({
  extraDependencies: z.array(z.string()).max(6).default([]),
  images: z
    .array(z.object({
      name: z.string().regex(/^[a-z0-9-]{2,40}$/, "lowercase letters, digits and hyphens only"),
      prompt: z.string().min(20),
      shape: z.enum(["square", "landscape", "portrait"]),
      usage: z.string().min(3),
    }))
    .max(12)
    .default([]),
  modules: z
    .array(z.object({
      name: z.string().regex(/^[A-Z][A-Za-z0-9]{2,30}$/, "PascalCase"),
      brief: z.string().min(30),
      contentExport: z.string().regex(/^[a-z][A-Za-z0-9]{2,30}$/, "camelCase"),
      files: z.array(z.object({ path: z.string(), purpose: z.string() })).min(1).max(4),
      exports: z.string().min(3),
    }))
    .min(2)
    .max(12),
});
export type Plan = z.infer<typeof PlanSchema>;

const SHAPE = `Return JSON only:
{"extraDependencies":["package names, only if the concept truly needs them"],
 "images":[{"name":"kebab-case-name","prompt":"complete standalone image prompt (subject, style, lighting, palette, framing)","shape":"square|landscape|portrait","usage":"where it is used"}],
 "modules":[{"name":"PascalCaseName","brief":"what this section/scene/effect does, how it looks, how it moves","contentExport":"camelCaseNameInContentTs","files":[{"path":"src/components/Name.tsx","purpose":"..."},{"path":"src/components/Name.css","purpose":"..."}],"exports":"default export Name component, takes no props"}]}`;

const SYSTEM = `You are a lead creative developer. You turn an approved design concept into an implementation plan for a React + TypeScript + Vite site (GSAP and Lenis are already installed).

Plan only the FEATURE MODULES, in reading order: each is a section, scene, or effect layer that exists because of the concept (not because websites usually have one). Typical count is 4 to 9.
Rules:
- Each module owns its own .tsx and its own .css file. Modules must be self-contained: they import their copy from src/content.ts and may import src/motion/smooth.ts, nothing from other modules.
- Do NOT plan these, they are produced separately: src/content.ts (all copy), src/styles/global.css, src/styles/tokens.css, src/App.tsx, src/main.tsx, src/motion/smooth.ts.
- File paths must be under src/ (e.g. src/components/Name.tsx). Each module's tsx file default-exports a component that takes no props.
- Modules must make the concept's layout, structure and motion real. Do not fall back to a standard hero/features/testimonials structure.
- Images: only plan images that earn their place. Prefer code-drawn SVG/CSS for shapes, textures and diagrams. Image prompts must match the concept's palette and mood.`;

export async function makePlan(concept: Concept, brief: Brief, cfg: BuildConfig, rulesText: string): Promise<{ plan: Plan; warnings: string[] }> {
  const { id: _i, status: _s, ...core } = concept;
  const user = [
    "BRIEF", briefToText(brief),
    "APPROVED CONCEPT", JSON.stringify(core, null, 1),
    `DEFAULTS TO AVOID:\n${rulesText}`,
    `Allowed extra npm packages (use none unless the concept needs them, e.g. WebGL): ${cfg.extraDependencyAllowlist.join(", ")}`,
    `Maximum images: ${cfg.maxImages}`,
    SHAPE,
  ].join("\n\n");

  const { value, warnings } = await loopJson<Plan>("builder", SYSTEM, user, (raw) => {
    const p = PlanSchema.safeParse(raw);
    if (!p.success) return { value: null, hard: p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`), soft: [] };
    const plan = p.data;
    const soft: string[] = [];
    const names = plan.modules.map((m) => m.name);
    if (new Set(names).size !== names.length) soft.push("module names must be unique");
    const exportsNames = plan.modules.map((m) => m.contentExport);
    if (new Set(exportsNames).size !== exportsNames.length) soft.push("contentExport values must be unique");
    const seen = new Set<string>();
    for (const m of plan.modules) {
      for (const f of m.files) {
        const rel = safeRel(f.path);
        if (!rel || !rel.startsWith("src/") || !/\.(tsx?|css)$/.test(rel)) soft.push(`${m.name}: file path "${f.path}" must be a .ts/.tsx/.css file under src/`);
        else if (RESERVED.includes(rel) || ["src/App.tsx", "src/content.ts", "src/styles/global.css"].includes(rel)) soft.push(`${m.name}: "${rel}" is reserved`);
        else if (seen.has(rel)) soft.push(`duplicate file path ${rel}`);
        else seen.add(rel);
      }
      if (!m.files.some((f) => f.path.endsWith(".tsx"))) soft.push(`${m.name}: needs a .tsx component file`);
    }
    for (const d of plan.extraDependencies) if (!cfg.extraDependencyAllowlist.includes(d)) soft.push(`package "${d}" is not allowed. Allowed: ${cfg.extraDependencyAllowlist.join(", ")}`);
    if (plan.images.length > cfg.maxImages) soft.push(`too many images (${plan.images.length}); maximum is ${cfg.maxImages}`);
    return { value: plan, hard: [], soft };
  });

  // Enforce what the model could not fix itself.
  value.extraDependencies = value.extraDependencies.filter((d) => cfg.extraDependencyAllowlist.includes(d));
  value.images = value.images.slice(0, cfg.maxImages);
  return { plan: value, warnings };
}
