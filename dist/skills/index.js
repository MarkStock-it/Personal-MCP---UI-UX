/**
 * The skills you installed, found and readable.
 *
 * A skill is instructions, so "running" one means putting its text in front of a model that is about to
 * work — not executing anything. This module finds every SKILL.md under the configured roots, reads the
 * front-matter for a name and a description, and hands the text to whoever needs it (the host, or a
 * collective unit the leader has assigned to that seat).
 *
 * Nothing here executes a skill's examples: a skill that says "run `npx playwright test`" is advice, and
 * the host that already has a terminal is the thing that decides to run it. An MCP tool that runs any
 * command a model asks for would be a hole in every project this server is pointed at, and no skill needs
 * that to work.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const MAX_DEPTH = 4;
const expand = (projectRoot, root) => root.startsWith("~") ? path.join(os.homedir(), root.slice(1)) : path.resolve(projectRoot, root);
function frontMatter(text) {
    const out = {};
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
        for (const line of fm[1].split("\n")) {
            const m = line.match(/^\s*(name|description)\s*:\s*(.+?)\s*$/i);
            if (m)
                out[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
        }
    }
    out.title = text.split("\n").find((l) => l.trim().startsWith("# "))?.replace(/^#\s*/, "").trim();
    return out;
}
async function walk(dir, depth) {
    if (depth > MAX_DEPTH)
        return [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const e of entries) {
        if (e.isSymbolicLink())
            continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory())
            found.push(...(await walk(abs, depth + 1)));
        else if (e.isFile() && e.name === "SKILL.md")
            found.push(abs);
    }
    return found;
}
export async function discoverSkills(projectRoot, cfg) {
    const skills = [];
    const roots = [];
    const notes = [];
    const seen = new Set();
    for (const raw of cfg.roots) {
        const root = expand(projectRoot, raw);
        roots.push(root);
        const files = await walk(root, 0);
        if (!files.length)
            continue;
        for (const file of files) {
            if (seen.has(file))
                continue;
            seen.add(file);
            try {
                const text = await fs.readFile(file, "utf8");
                if (text.length > cfg.maxSkillKB * 1024) {
                    notes.push(`${file} is over skills.maxSkillKB and was listed without being read`);
                }
                const fm = frontMatter(text);
                const dir = path.dirname(file);
                const siblings = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name !== "SKILL.md").map((e) => e.name);
                skills.push({
                    name: (fm.name ?? path.basename(dir)).trim(),
                    description: (fm.description ?? fm.title ?? "no description in the front-matter").trim(),
                    path: file,
                    root,
                    bytes: text.length,
                    files: siblings,
                    copies: [],
                });
            }
            catch {
                notes.push(`${file} could not be read`);
            }
        }
    }
    // One entry per skill name. An account skill and a project copy of it are the same skill to a reader, and
    // a menu that lists it twice is noise — so the longest copy wins and the others are named on the entry.
    const byName = new Map();
    for (const s of skills) {
        const key = s.name.toLowerCase();
        const prior = byName.get(key);
        if (!prior)
            byName.set(key, s);
        else if (s.bytes > prior.bytes)
            byName.set(key, { ...s, copies: [...prior.copies, prior.path] });
        else
            prior.copies.push(s.path);
    }
    return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), roots, notes };
}
export const findSkill = (skills, name) => {
    const q = name.trim().toLowerCase();
    return skills.find((s) => s.name.toLowerCase() === q) ?? skills.find((s) => s.name.toLowerCase().includes(q));
};
/** The SKILL.md text, cut at `maxKB` with the cut said out loud. */
export async function readSkill(skill, maxKB) {
    const text = await fs.readFile(skill.path, "utf8");
    const cap = maxKB * 1024;
    if (text.length <= cap)
        return text;
    return `${text.slice(0, cap)}\n\n[cut at skills.maxInPromptKB=${maxKB} KB; the rest of ${skill.name} is in ${skill.path}]`;
}
export function renderSkillIndex(scan, opts = {}) {
    const q = opts.query?.toLowerCase();
    const list = q
        ? scan.skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q))
        : scan.skills;
    if (!scan.skills.length) {
        return [
            "No SKILL.md found under:",
            ...scan.roots.map((r) => `- ${r}`),
            "",
            "Point `skills.roots` in design-mcp.config.json at the folder that holds your skills (a `~`, a relative path or an absolute one).",
        ].join("\n");
    }
    const shown = list.slice(0, opts.limit ?? 60);
    return [
        `${scan.skills.length} skill${scan.skills.length === 1 ? "" : "s"} found${scan.skills.some((s) => s.copies.length) ? " (duplicate copies of a name are counted once)" : ""}${q ? ` matching "${opts.query}" (${list.length})` : ""}. Roots: ${scan.roots.join(", ")}`,
        "",
        ...shown.map((s) => `- ${s.name} — ${s.description.replace(/\s+/g, " ").slice(0, 220)}\n    ${s.path}${s.files.length ? ` (also: ${s.files.slice(0, 6).join(", ")})` : ""}${s.copies.length ? ` — ${s.copies.length} other cop${s.copies.length === 1 ? "y" : "ies"} of this skill on disk: ${s.copies.slice(0, 2).join(", ")}${s.copies.length > 2 ? ", ..." : ""}` : ""}`),
        ...(list.length > shown.length ? ["", `... and ${list.length - shown.length} more`] : []),
        ...(scan.notes.length ? ["", "Notes:", ...scan.notes.map((n) => `- ${n}`)] : []),
        "",
        "Read one with skills_read (or the resource code://skills). Assign one to a collective unit and its text goes into that worker's prompt.",
    ].join("\n");
}
