import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "./config.js";
export const BUILTIN_RULES = [
    "Centered hero with headline, subheadline and two buttons.",
    "A row of three identical feature cards.",
    "Soft gradients, especially purple-to-blue; floating gradient blobs.",
    "Rounded boxes with soft drop shadows used everywhere.",
    "Generic sans-serif typography with timid size contrast.",
    "Emoji or stock-style icons used as filler.",
    "Dark mode with neon glow as a substitute for an idea.",
    "Sticky blurred-glass navbar with logo left, links right, button far right.",
    "Testimonial carousel with circular avatars.",
    "Placeholder-sounding copy: lorem ipsum, 'Welcome to', 'Unlock the power of', 'Elevate', 'Seamless'.",
    "A uniform grid with identical spacing on every section.",
].map((text, i) => ({ id: `builtin-${i + 1}`, text, source: "builtin" }));
// Fonts that signal 'default AI output'. Matched as whole words, case-insensitive.
export const BANNED_FONTS = [
    "Inter", "Roboto", "Arial", "Helvetica", "Open Sans", "Lato", "Poppins", "Montserrat", "system-ui",
];
export const GENERIC_FONT_WORDS = ["sans-serif", "serif", "sans", "default"];
export const rulesFile = () => path.join(stateDir(), "rules.json");
export async function loadUserRules() {
    try {
        const parsed = JSON.parse(await fs.readFile(rulesFile(), "utf8"));
        return Array.isArray(parsed.rules) ? parsed.rules : [];
    }
    catch {
        return [];
    }
}
export async function allRules() {
    return [...BUILTIN_RULES, ...(await loadUserRules())];
}
export function rulesPrompt(rules) {
    return rules.map((r) => `- ${r.text}`).join("\n");
}
