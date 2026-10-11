import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./config.js";
const RULES = [
    ["project", /^(project|about|overview|what)/i],
    ["audience", /audience|who\b|visitors?|users?/i],
    ["tone", /tone|voice|mood|feel/i],
    ["goals", /goal|cta|success|action|objective/i],
    ["sections", /pages?|sections?|structure|sitemap/i],
    ["references", /reference|inspiration|avoid|anti/i],
    ["constraints", /brand|constraint|tech|requirement|must/i],
    ["content", /content|copy|material|text|facts/i],
];
export const REQUIRED = ["project", "audience", "tone", "content", "goals"];
export function parseBrief(markdown) {
    const text = markdown.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
    const [head = "", ...parts] = text.split(/^##\s+/m);
    const brief = {
        project: head.replace(/^#\s+/m, "").trim(),
        audience: "", tone: "", content: "", goals: "", sections: "", references: "", constraints: "",
        extras: [], raw: markdown,
    };
    for (const part of parts) {
        const nl = part.indexOf("\n");
        const title = (nl === -1 ? part : part.slice(0, nl)).trim();
        const body = (nl === -1 ? "" : part.slice(nl + 1)).trim();
        const key = RULES.find(([, re]) => re.test(title))?.[0];
        if (key)
            brief[key] = brief[key] ? `${brief[key]}\n\n${body}` : body;
        else if (body)
            brief.extras.push({ title, body });
    }
    return brief;
}
export function validateBrief(b) {
    const missing = REQUIRED.filter((k) => !b[k].trim());
    const thin = REQUIRED.filter((k) => b[k].trim() && b[k].trim().length < 25);
    return { missing, thin };
}
export function briefToText(b) {
    const block = (label, v) => (v.trim() ? `### ${label}\n${v.trim()}\n` : "");
    return [
        block("Project", b.project),
        block("Audience", b.audience),
        block("Tone and voice", b.tone),
        block("Content (real material to use)", b.content),
        block("Goals", b.goals),
        block("Pages / sections wanted", b.sections),
        block("References and anti-references", b.references),
        block("Brand and constraints", b.constraints),
        ...b.extras.map((e) => block(e.title, e.body)),
    ].join("\n");
}
export function resolveInProject(p) {
    const root = projectDir();
    const full = path.resolve(root, p);
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error(`Path must stay inside the project folder (${root}).`);
    }
    return full;
}
export async function readBrief(p = "brief.md") {
    const file = resolveInProject(p);
    let raw;
    try {
        raw = await fs.readFile(file, "utf8");
    }
    catch {
        throw new Error(`No brief found at ${file}. Run brief_init to create a template.`);
    }
    return { brief: parseBrief(raw), file };
}
export const BRIEF_TEMPLATE = `# Project name: one-line description of what this is

<!-- Everything inside comments is ignored. Replace the guidance with your own words. -->

## Audience
<!-- Who visits? Age, context, what they care about, what they already know, what they distrust. -->

## Tone and voice
<!-- 3 to 6 words plus a sentence. e.g. "dry, confident, a little rude. Talks like a mechanic, not a marketer." -->

## Content
<!-- Paste the REAL material: names, facts, numbers, product details, quotes, headlines you already like. The more real copy, the less generic the design. -->

## Goals
<!-- The one action a visitor should take. What does success look like? -->

## Pages and sections
<!-- Optional. What must exist? Leave empty to let the concept decide the structure. -->

## References and anti-references
<!-- Optional. Sites/objects/eras you love, and things you never want it to resemble. -->

## Brand and constraints
<!-- Optional. Logo, existing colors or fonts, required tech, things that must not change. -->
`;
