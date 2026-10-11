import fs from "node:fs/promises";
import path from "node:path";
import { loadStore } from "./concepts.js";
import { stateDir } from "./config.js";
import { generateText } from "./providers/index.js";
import { findVariations, loadReport } from "./test/run.js";
import type { ChatMessage, ImageInput } from "./types.js";

/** Screenshots are full-page JPEGs; keep the vision request to 3 frames so it stays fast and cheap. */
const MAX_SHOTS = 3;
/** Skip frames larger than this (roughly: extremely long pages). Providers downscale server-side anyway. */
const MAX_SHOT_BYTES = 1_200_000;

const SYSTEM = `You are a senior art director reviewing a website variation against its approved concept. Be specific and opinionated: name what works, what breaks the concept, and what looks like default AI output. Rank fixes by visual impact. Keep it under 500 words. Never suggest lorem ipsum, stock testimonials, gradient blobs, or generic hero layouts as fixes.`;

function pickShots(files: string[]): string[] {
  const desktop = files.filter((f) => f.startsWith("desktop-"));
  const mobile = files.filter((f) => f.startsWith("mobile-"));
  const picks: string[] = [];
  if (desktop.length) picks.push(desktop[0]);
  if (mobile.length) picks.push(mobile[0]);
  if (desktop.length > 1) picks.push(desktop[desktop.length - 1]);
  return picks.slice(0, MAX_SHOTS);
}

/** Art-director review of a tested variation: concept + test report + screenshots go to the critic model. */
export async function critiqueVariation(id: string): Promise<{ text: string; file: string; shotsUsed: string[] }> {
  const vid = id.toLowerCase();
  const v = (await findVariations()).find((x) => x.id === vid);
  if (!v) throw new Error(`No built variation "${id}". Run design_build first.`);
  const report = await loadReport(vid); // throws when design_test has not run yet

  let conceptBlock = "(concept store unavailable; reviewing against the report alone)";
  try {
    const store = await loadStore();
    const c = store.concepts.find((c) => c.id === vid);
    if (c) {
      conceptBlock = [
        `Concept "${c.name}": ${c.bigIdea}`,
        `Remembered for: ${c.memorableThing}`,
        `Layout: ${c.layout}`,
        `Type: ${c.typography.display} + ${c.typography.body}`,
        `Colour: ${[c.palette.dominant, c.palette.accent, ...c.palette.support].join("  ")}`,
        `Motion: ${c.motion}`,
        `Voice sample: "${c.voice.sampleHeadline}"`,
      ].join("\n");
    }
  } catch {
    /* concepts store missing; critique from the report alone */
  }

  const shotDir = path.join(stateDir(), "shots", vid);
  let names: string[] = [];
  try {
    names = (await fs.readdir(shotDir)).filter((f) => f.endsWith(".jpg")).sort();
  } catch {
    throw new Error(`No screenshots for "${id}". Run design_test first.`);
  }
  const images: ImageInput[] = [];
  const shotsUsed: string[] = [];
  const skipped: string[] = [];
  for (const f of pickShots(names)) {
    const buf = await fs.readFile(path.join(shotDir, f));
    if (buf.length > MAX_SHOT_BYTES) {
      skipped.push(`${f} (${Math.round(buf.length / 1024)} KB, over the per-frame cap)`);
      continue;
    }
    images.push({ mediaType: "image/jpeg", base64: buf.toString("base64") });
    shotsUsed.push(f);
  }

  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      `VARIATION ${v.id.toUpperCase()} "${v.name}" (build status: ${v.status})`,
      "",
      "APPROVED CONCEPT IT WAS BUILT FROM",
      conceptBlock,
      "",
      "AUTOMATED TEST REPORT",
      report,
      skipped.length ? `\nScreenshots skipped: ${skipped.join("; ")}` : "",
      "",
      "Review the attached screenshots against the concept and the report. Call out concept drift first, then anything the gates missed.",
    ].join("\n"),
    images,
  }];
  const r = await generateText("critic", { system: SYSTEM, messages, maxTokens: 2500 });

  const dir = path.join(stateDir(), "critiques");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${vid}.md`);
  await fs.writeFile(file, `# Critique ${vid} "${v.name}" (${new Date().toISOString()})\n\nShots reviewed: ${shotsUsed.join(", ") || "none"}\n\n${r.text}\n`);

  return {
    text: [
      `CRITIQUE ${v.id.toUpperCase()} "${v.name}" (shots: ${shotsUsed.join(", ") || "none"})`,
      "",
      r.text,
      "",
      `Saved to ${file}. Fix what matters, then re-run design_build (overwrite=true) and design_test.`,
    ].join("\n"),
    file,
    shotsUsed,
  };
}
