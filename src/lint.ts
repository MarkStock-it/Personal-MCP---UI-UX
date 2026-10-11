import type { ConceptCore } from "./concepts.js";
import { BANNED_FONTS, GENERIC_FONT_WORDS } from "./rules.js";

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

const rgbDistance = (a: string, b: string) => {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isBannedFont(font: string): string | null {
  const f = font.trim();
  if (GENERIC_FONT_WORDS.includes(f.toLowerCase())) return f;
  for (const banned of BANNED_FONTS) {
    if (new RegExp(`(^|[^a-z])${esc(banned)}([^a-z]|$)`, "i").test(f)) return banned;
  }
  return null;
}

const GENERIC_SECTIONS = ["hero", "features", "testimonials", "pricing", "cta", "footer", "about", "faq"];
const BAD_PHRASES = ["welcome to", "unlock", "elevate", "seamless", "revolutioni", "empower", "supercharge", "lorem ipsum"];

/** Problems with a single concept. Empty array = clean. */
export function lintConcept(c: ConceptCore): string[] {
  const issues: string[] = [];

  for (const [label, font] of [["display", c.typography.display], ["body", c.typography.body]] as const) {
    const hit = isBannedFont(font);
    if (hit) issues.push(`${label} font "${font}" is a default-AI font (${hit}). Pick a distinctive Google Fonts family.`);
  }

  for (const [label, hex] of [["dominant", c.palette.dominant], ["accent", c.palette.accent]] as const) {
    const { h, s } = hexToHsl(hex);
    if (h >= 250 && h <= 295 && s > 0.4) issues.push(`${label} colour ${hex} is the purple/indigo default. Choose a colour with a reason.`);
  }

  const headline = c.voice.sampleHeadline.toLowerCase();
  const phrase = BAD_PHRASES.find((p) => headline.includes(p));
  if (phrase) issues.push(`sample headline uses the cliché "${phrase}". Write it in the project's own voice.`);

  const generic = c.structure.filter((s) => GENERIC_SECTIONS.some((g) => s.toLowerCase().includes(g)));
  if (generic.length >= 4) issues.push(`structure is the standard template (${generic.join(", ")}). Let the content decide the structure.`);

  return issues;
}

/** Problems across a set of concepts (they must truly differ). */
export function lintSet(cs: ConceptCore[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const [a, b] = [cs[i], cs[j]];
      if (a.typography.display.trim().toLowerCase() === b.typography.display.trim().toLowerCase())
        issues.push(`"${a.name}" and "${b.name}" use the same display font. Concepts must differ.`);
      if (rgbDistance(a.palette.dominant, b.palette.dominant) < 70)
        issues.push(`"${a.name}" and "${b.name}" have nearly the same dominant colour. Concepts must differ.`);
    }
  }
  return issues;
}
