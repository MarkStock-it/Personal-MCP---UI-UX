import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { briefToText, type Brief } from "./brief.js";
import { stateDir } from "./config.js";
import { lintConcept, lintSet } from "./lint.js";
import { generateText } from "./providers/index.js";
import { allRules, rulesPrompt } from "./rules.js";
import type { ChatMessage } from "./types.js";
import { extractJson } from "./util/json.js";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex like #1A2B3C");

export const ConceptCoreSchema = z.object({
  name: z.string().min(2),
  bigIdea: z.string().min(20),
  rejectedDefaults: z.array(z.object({ default: z.string(), instead: z.string() })).min(3),
  memorableThing: z.string().min(10),
  layout: z.string().min(20),
  structure: z.array(z.string()).min(3).max(12),
  typography: z.object({ display: z.string(), body: z.string(), scaleNote: z.string() }),
  palette: z.object({ dominant: Hex, accent: Hex, support: z.array(Hex).max(2).default([]), note: z.string() }),
  motion: z.string().min(20),
  assets: z.object({ approach: z.string(), imagePrompts: z.array(z.string()).max(6).default([]) }),
  voice: z.object({ description: z.string(), sampleHeadline: z.string().min(3) }),
});

export type ConceptCore = z.infer<typeof ConceptCoreSchema>;
export type Concept = ConceptCore & { id: string; status: "proposed" | "approved" };

export interface ConceptStore {
  briefPath: string;
  briefHash: string;
  createdAt: string;
  status: "pending-approval" | "approved";
  concepts: Concept[];
}

const SHAPE = `Return JSON only, shaped exactly like:
{"concepts":[{
 "name":"short evocative name",
 "bigIdea":"the one idea the design is built around, derived from this project's subject, audience, tone and content",
 "rejectedDefaults":[{"default":"what you'd normally do","instead":"what you do here"}, (at least 3)],
 "memorableThing":"the single thing a visitor will remember",
 "layout":"how the page is structured and how it reads, and why that fits the idea",
 "structure":["ordered sections or scenes, named for THIS content"],
 "typography":{"display":"Google Fonts family","body":"Google Fonts family","scaleNote":"how scale contrast is used"},
 "palette":{"dominant":"#RRGGBB","accent":"#RRGGBB","support":["#RRGGBB"],"note":"why these colours"},
 "motion":"scroll, transition and micro-interaction behaviour that belongs to the idea (GSAP + Lenis available)",
 "assets":{"approach":"what is drawn in code (SVG/CSS) vs generated imagery","imagePrompts":["standalone prompts for any generated images"]},
 "voice":{"description":"how the copy sounds","sampleHeadline":"a real headline written in that voice"}
}]}`;

function buildSystem(rulesText: string): string {
  return `You are a senior art director and creative technologist. You never produce the polished average of what websites look like. You invent design concepts that could only exist for THIS project.

DEFAULTS TO AVOID (the client is tired of these):
${rulesText}

For every concept: derive the one big idea from the subject, audience, tone and content, never from a template. Name three defaults you would normally reach for and what you do instead. Commit fully, with no hedging or safe middle.

Constraints:
- Layout: do not start from header/hero/sections/footer. Let the content decide the structure. Use asymmetry, scale contrast, overlap, unusual reading flow, or a layout that mirrors the subject.
- Typography: two Google Fonts families with real personality (they must exist on Google Fonts), bold scale contrast.
- Colour: at most 4 colours in total: one dominant, one sharp accent, up to two support colours.
- Motion: rich and purposeful (scroll-driven, transitions, micro-interactions) and part of the concept, never decoration. It must respect prefers-reduced-motion.
- Copy: use the real material from the brief. Never lorem ipsum, never "Welcome to".
- Stay usable: readable text, an obvious main action, works on mobile.

When asked for several concepts they MUST differ from each other in layout paradigm, typographic voice, colour temperature/lightness and motion personality. No shared display fonts.`;
}

const fmtZod = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export interface Checked<T> { value: T | null; hard: string[]; soft: string[] }

/** Ask for JSON, feed validation/lint problems back, up to 3 attempts. */
export async function loopJson<T>(role: "concept" | "builder", system: string, first: string, check: (raw: unknown) => Checked<T>) {
  const messages: ChatMessage[] = [{ role: "user", content: first }];
  let best: { value: T; soft: string[] } | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await generateText(role, { system, messages, json: true, maxTokens: 8000 });
    let raw: unknown;
    try {
      raw = extractJson(reply.text);
    } catch {
      messages.push({ role: "assistant", content: reply.text }, { role: "user", content: "That was not valid JSON. Return the corrected, complete JSON only." });
      continue;
    }
    const { value, hard, soft } = check(raw);
    if (value && !hard.length && !soft.length) return { value, warnings: [] as string[] };
    if (value && !hard.length) best = { value, soft };

    const problems = [...hard, ...soft];
    messages.push(
      { role: "assistant", content: reply.text },
      { role: "user", content: `Fix these problems and return the complete corrected JSON only:\n- ${problems.join("\n- ")}` }
    );
  }
  if (best) return { value: best.value, warnings: best.soft };
  throw new Error("The concept model could not produce valid output after 3 attempts. Try again or switch the concept model in the config.");
}

const summarise = (c: Concept) =>
  `- ${c.name}: ${c.bigIdea} | layout: ${c.layout} | fonts: ${c.typography.display} / ${c.typography.body} | dominant ${c.palette.dominant}, accent ${c.palette.accent} | motion: ${c.motion}`;

export async function proposeConcepts(brief: Brief, count: number, avoid: Concept[] = []) {
  const system = buildSystem(rulesPrompt(await allRules()));
  const user = [
    "BRIEF",
    briefToText(brief),
    avoid.length ? `ALREADY CHOSEN (new concepts must be clearly different in layout, type, colour and motion):\n${avoid.map(summarise).join("\n")}\n` : "",
    `Create exactly ${count} concept direction${count > 1 ? "s" : ""}.`,
    SHAPE,
  ].join("\n");

  return loopJson<ConceptCore[]>("concept", system, user, (raw) => {
    const p = z.object({ concepts: z.array(ConceptCoreSchema).length(count) }).safeParse(raw);
    if (!p.success) return { value: null, hard: fmtZod(p.error), soft: [] };
    const cs = p.data.concepts;
    const soft = [...cs.flatMap((c) => lintConcept(c).map((i) => `${c.name}: ${i}`)), ...lintSet([...avoid, ...cs])];
    return { value: cs, hard: [], soft };
  });
}

export async function reviseConcept(brief: Brief, concept: Concept, instruction: string, others: Concept[]) {
  const system = buildSystem(rulesPrompt(await allRules()));
  const { id: _id, status: _status, ...core } = concept;
  const user = [
    "BRIEF",
    briefToText(brief),
    "CURRENT CONCEPT",
    JSON.stringify(core, null, 1),
    others.length ? `OTHER CONCEPTS (stay clearly different from these):\n${others.map(summarise).join("\n")}\n` : "",
    `REQUESTED CHANGE: ${instruction}`,
    "Apply the change and keep everything else coherent (update fonts, colours, layout, motion and copy where the change implies it). Return the revised concept as the only item in the array.",
    SHAPE,
  ].join("\n");

  return loopJson<ConceptCore>("concept", system, user, (raw) => {
    const p = z.object({ concepts: z.array(ConceptCoreSchema).length(1) }).safeParse(raw);
    if (!p.success) return { value: null, hard: fmtZod(p.error), soft: [] };
    const c = p.data.concepts[0];
    return { value: c, hard: [], soft: [...lintConcept(c), ...lintSet([...others, c])] };
  });
}

export function nextIds(used: string[], n: number): string[] {
  const free = "abcdefghijklmnopqrstuvwxyz".split("").filter((l) => !used.includes(l));
  return free.slice(0, n);
}

export const hashBrief = (raw: string) => crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
const storeFile = () => path.join(stateDir(), "concepts.json");

export async function saveStore(s: ConceptStore) {
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(storeFile(), JSON.stringify(s, null, 2));
}

export async function loadStore(): Promise<ConceptStore> {
  try {
    return JSON.parse(await fs.readFile(storeFile(), "utf8"));
  } catch {
    throw new Error("No concepts yet. Run concepts_generate first.");
  }
}

export async function archiveStore() {
  try {
    await fs.rename(storeFile(), path.join(stateDir(), "concepts.prev.json"));
  } catch {
    /* nothing to archive */
  }
}

export function renderConcepts(cs: Concept[]): string {
  return cs
    .map((c) =>
      [
        `## ${c.id.toUpperCase()}: ${c.name}`,
        `**Big idea:** ${c.bigIdea}`,
        `**What they'll remember:** ${c.memorableThing}`,
        `**Defaults rejected:**\n${c.rejectedDefaults.map((r) => `  - ${r.default} -> ${r.instead}`).join("\n")}`,
        `**Layout:** ${c.layout}`,
        `**Structure:** ${c.structure.join(" > ")}`,
        `**Type:** ${c.typography.display} (display) + ${c.typography.body} (body). ${c.typography.scaleNote}`,
        `**Colour:** ${[c.palette.dominant, c.palette.accent, ...c.palette.support].join("  ")}. ${c.palette.note}`,
        `**Motion:** ${c.motion}`,
        `**Assets:** ${c.assets.approach}`,
        `**Voice:** ${c.voice.description} Sample headline: "${c.voice.sampleHeadline}"`,
      ].join("\n")
    )
    .join("\n\n---\n\n");
}
