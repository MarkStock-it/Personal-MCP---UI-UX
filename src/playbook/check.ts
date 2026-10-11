/**
 * Deterministic design checks. No model, no network: these are the numbers behind the
 * playbook's advice, so an agent can verify a palette or a file instead of guessing.
 *
 * Colour maths reuses hexToRgb/hexToHsl from ../lint.ts (same parsers, same rounding), so a
 * verdict here and a lint warning on a concept always agree.
 */
import { hexToHsl, hexToRgb } from "../lint.js";
import { SLOP_CHECKS } from "./slop.js";
import type { SlopCheck } from "./types.js";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

/** WCAG relative luminance. Formula per WCAG 2.2, expressed independently. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. Order of arguments does not matter. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Thresholds straight from WCAG 2.2 AA (1.4.3 text, 1.4.11 non-text). */
export const CONTRAST = { body: 4.5, large: 3, ui: 3, aaaBody: 7, aaaLarge: 4.5 } as const;

export const contrastVerdict = (ratio: number): "AA body" | "AA large/UI only" | "fail" =>
  ratio >= CONTRAST.body ? "AA body" : ratio >= CONTRAST.large ? "AA large/UI only" : "fail";

/** Perceptual-ish mix in sRGB space: good enough for deriving a tint, not a colour-managed blend. */
export function mixHex(a: string, b: string, t = 0.5): string {
  const [x, y] = [hexToRgb(a), hexToRgb(b)];
  const hex = (n: number) => Math.round(clamp01(n / 255) * 255).toString(16).padStart(2, "0");
  return `#${hex(x[0] + (y[0] - x[0]) * t)}${hex(x[1] + (y[1] - x[1]) * t)}${hex(x[2] + (y[2] - x[2]) * t)}`.toUpperCase();
}

export type Role = "surface" | "ink" | "accent";

/**
 * Guess what a colour is FOR. Both signals matter: lightness decides whether a colour can
 * hold text or sit behind it, and chroma decides how loudly it does so.
 */
export function classify(hex: string): { role: Role; l: number; s: number; h: number } {
  const { h, s, l } = hexToHsl(hex);
  const role: Role = l >= 0.78 ? "surface" : l <= 0.34 ? "ink" : "accent";
  return { role, l, s, h };
}

export interface SoftnessNote { level: "ok" | "watch" | "harsh"; note: string }

/**
 * The softness verdict. Saturation alone is a bad signal — a near-white tint can be 75%
 * saturated and still read calm, because lightness, not chroma, dominates perception.
 * So the harshness test is chroma *at mid lightness*: that is what reads as neon.
 */
export function softness(hex: string): SoftnessNote {
  const { h, s, l } = classify(hex);
  const hsl = `h${h.toFixed(0)} s${pct(s)} l${pct(l)}`;

  // The purple/indigo band is the signature colour of generated UI (same 250-295 hue and >40%
  // saturation that lint.ts flags on a concept). It is reported alongside the verdict rather than
  // as its own exclusive branch: the loudest violet and the most obvious default are usually the
  // same colour, and a reviewer needs to hear both.
  // Only a mid-tone can be the "generated UI" colour: a near-white paper or a near-black ink that
  // happens to sit on that hue is a legitimate surface or ink, not a default accent.
  const purple = h >= 250 && h <= 295 && s > 0.4 && l > 0.32 && l < 0.78;
  const alsoPurple = purple
    ? " It also sits in the default purple/indigo band (hue 250-295 at over 40% saturation), which is the signature of generated UI: keep it as a small accent, or shift the hue on purpose."
    : "";

  if (s > 0.55 && l > 0.32 && l < 0.78)
    return { level: "harsh", note: `${hex} (${hsl}) is a high-chroma mid-lightness colour: as a field it reads loud/neon.${alsoPurple}` };
  // What is wrong with pure white or black is the missing hue bias, not the lightness: a tinted
  // paper at 97% lightness is a design decision, so only near-neutral extremes are flagged.
  if ((l >= 0.97 || l <= 0.06) && s < 0.08)
    return { level: "watch", note: `${hex} (${hsl}) is a neutral near-white/near-black: it flattens the page. Give it a hue bias (a tinted paper or a coloured ink) instead.` };
  if (purple)
    return { level: "watch", note: `${hex} (${hsl}) sits in the default purple/indigo band (hue 250-295 at over 40% saturation). Keep it as a small accent or shift the hue on purpose.` };
  if (l >= 0.78)
    return { level: "ok", note: `${hex} (${hsl}) is a light surface: reads soft, and it will pick up whatever hue you give it.` };
  if (l <= 0.34)
    return { level: "ok", note: `${hex} (${hsl}) is an ink: good for text, and its hue bias sets the whole page's temperature.` };
  return { level: "ok", note: `${hex} (${hsl}) is a mid-tone: use it as the single accent, not as a field.` };
}

export interface PaletteReport {
  colours: { hex: string; role: Role; h: number; s: number; l: number; verdict: SoftnessNote }[];
  pairs: { fg: string; bg: string; ratio: number; verdict: string }[];
  hueSpread: number;
  problems: string[];
  suggestions: string[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Full offline diagnosis of a palette: roles, softness, every ink/surface contrast pair, hue spread. */
export function paletteCheck(input: string[]): PaletteReport {
  const bad = input.filter((c) => !HEX.test(c.trim()));
  const colours = input.filter((c) => HEX.test(c.trim())).map((c) => {
    const hex = c.trim().toUpperCase();
    const { h, s, l, role } = classify(hex);
    return { hex, role, h, s, l, verdict: softness(hex) };
  });
  if (bad.length) throw new Error(`Not 6-digit hex colours: ${bad.join(", ")}. Use #RRGGBB.`);
  if (colours.length < 2) throw new Error("Give at least two colours (an ink and a surface) so contrast can be checked.");

  const inks = colours.filter((c) => c.role === "ink");
  const surfaces = colours.filter((c) => c.role === "surface");
  const accents = colours.filter((c) => c.role === "accent");
  const pairs: PaletteReport["pairs"] = [];
  const push = (fg: string, bg: string) => pairs.push({ fg, bg, ratio: contrastRatio(fg, bg), verdict: contrastVerdict(contrastRatio(fg, bg)) });
  // Only combinations that can actually occur: text sitting on a surface, accent text on a surface,
  // and text on an accent chip. Accent-on-accent is not a real pairing, and reporting it only buries
  // the ratios that matter under a list of meaningless 1.1:1 rows.
  for (const fg of inks) for (const bg of surfaces) push(fg.hex, bg.hex);
  for (const a of accents) {
    for (const bg of surfaces) push(a.hex, bg.hex);
    for (const ink of inks) push(ink.hex, a.hex);
  }
  pairs.sort((a, b) => a.ratio - b.ratio);

  const hues = colours.map((c) => c.h).filter((_, i) => colours[i].s > 0.08);
  const hueSpread = hues.length > 1 ? Math.max(...hues) - Math.min(...hues) : 0;

  const problems: string[] = [];
  const suggestions: string[] = [];
  for (const c of colours) if (c.verdict.level === "harsh") problems.push(`harsh field: ${c.verdict.note}`);
  if (!inks.length) problems.push("no ink colour (lightness <= 34%): nothing here can hold body text at readable contrast.");
  if (!surfaces.length) problems.push("no light surface (lightness >= 78%): the page has no paper to sit on.");
  if (accents.length > 1) problems.push(`${accents.length} mid-tone accents. One accent plus tints of the ink/surface reads more expensive than two bright colours fighting.`);
  if (hueSpread > 150) problems.push(`hue spread is ${hueSpread.toFixed(0)}deg: that is two palettes. Keep the paper and fields in one hue family and let the accent jump.`);
  for (const p of pairs.filter((p) => p.verdict === "fail").slice(0, 4))
    suggestions.push(`${p.fg} on ${p.bg} is ${p.ratio.toFixed(2)}:1 — below 4.5:1. Darken the text or lighten the surface until it passes; do not shrink the type to compensate.`);
  if (pairs.some((p) => p.ratio >= CONTRAST.aaaBody) && pairs.some((p) => p.verdict === "fail"))
    suggestions.push("Reuse the ink/surface pair that already passes at 7:1 instead of introducing a new mid-tone for body text.");

  return { colours, pairs, hueSpread, problems, suggestions };
}

export function renderPalette(r: PaletteReport): string {
  return [
    "Palette check (offline, WCAG 2.2 AA thresholds)",
    "",
    "Colours:",
    ...r.colours.map((c) => `  ${c.hex}  ${c.role.padEnd(7)}  h${c.h.toFixed(0)} s${pct(c.s)} l${pct(c.l)}  ${c.verdict.level.toUpperCase()} — ${c.verdict.note}`),
    "",
    `Hue spread (saturated colours only): ${r.hueSpread.toFixed(0)}deg`,
    "",
    "Contrast (lowest first):",
    ...r.pairs.slice(0, 12).map((p) => `  ${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)}:1 — ${p.verdict}`),
    "",
    r.problems.length ? `Problems:\n${r.problems.map((p) => `  - ${p}`).join("\n")}` : "Problems: none found.",
    r.suggestions.length ? `\nSuggestions:\n${r.suggestions.map((s) => `  - ${s}`).join("\n")}` : "",
    "",
    "Reminder: 4.5:1 for body text, 3:1 for large text (>=24px, or >=19px bold) and for non-text UI edges. Translucent layers must be checked against their worst-case composite.",
  ].filter(Boolean).join("\n");
}

export interface SlopFinding { line: number; check: string; severity: SlopCheck["severity"]; text: string; instead: string }

/** Scan a CSS/HTML/JS/TS snippet for the machine-detectable defaults in the anti-slop checklist. */
export function scanSlop(text: string, checks: SlopCheck[] = SLOP_CHECKS): SlopFinding[] {
  const findings: SlopFinding[] = [];
  const lines = text.split("\n");
  for (const check of checks) {
    let re: RegExp;
    try {
      re = new RegExp(check.pattern, check.flags ?? "i");
    } catch {
      continue; // a malformed pattern is a bug in the checklist, not in the user's file
    }
    lines.forEach((line, i) => {
      if (re.test(line)) {
        findings.push({ line: i + 1, check: check.id, severity: check.severity, text: line.trim().slice(0, 140), instead: check.instead });
      }
    });
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

export function renderSlopFindings(findings: SlopFinding[], label: string): string {
  if (!findings.length) return `${label}: nothing from the anti-slop checklist matched. That does not prove the design is original — run critique_rubric next.`;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return [
    `${label}: ${findings.length} match(es) from the anti-slop checklist (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`,
    "",
    ...findings.slice(0, 40).map((f) => `  line ${f.line} [${f.severity}] ${f.check}: ${f.text}\n    instead: ${f.instead}`),
    findings.length > 40 ? `  ...and ${findings.length - 40} more.` : "",
    "",
    "High-severity matches alone make a page read as generated. Fix those before adding anything new.",
  ].filter(Boolean).join("\n");
}
