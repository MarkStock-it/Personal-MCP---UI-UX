/**
 * What the collective learns about the owner and about the work, between missions.
 *
 * This is deliberately not a second memory. Memory holds claims about the code, each with a quote the
 * server re-read, and it must go stale when that code changes. This file holds two other things:
 *
 *   - history: how many missions have run here, what they graded, and which files they kept landing on.
 *     That is computed from the dossier's own numbers, so it cannot be wrong about anything except its
 *     own arithmetic, and it costs no model call to keep — which matters because it is read at the top
 *     of every session, in `collective_hello`, and missions are expected to make it grow.
 *   - nothing about the owner's preferences. Those are rulings in `memory.ts`, written in the owner's
 *     own words and already carried into every prompt. Keeping a second copy here would create two
 *     places to edit, one of which would quietly drift.
 *
 * The rules that must not be relaxed:
 *   - recording is best-effort. A read-only project or a corrupt file must never fail a mission; the
 *     caller catches the write and turns it into a warning, and `loadOwner` returns empty rather than
 *     throwing.
 *   - it is history, never evidence. Nothing here may be cited as a fact about the code, and the
 *     renderers say so in as many words, because a count of past missions is exactly the kind of thing
 *     a model would love to promote into a claim about today's code.
 *   - a repeated mission is not a new lesson. Files and skills count once per mission, so "landed on
 *     this file in 5 missions" means five missions, not fifteen findings.
 *   - the file is written atomically (temp + rename): two overlapping jobs must not leave half a record.
 */
import fs from "node:fs/promises";
import path from "node:path";
/** How many hot files and skills are kept. Bounded so the greeting stays cheap forever. */
export const OWNER_FILE_CAP = 40;
export const OWNER_SKILL_CAP = 20;
export const ownerFile = (root) => path.join(root, ".design-mcp", "collective", "owner.json");
const GRADES = ["strong", "partial", "thin", "nothing"];
function emptyStats() {
    const at = new Date().toISOString();
    return {
        version: 1,
        firstAt: at,
        lastAt: at,
        missions: 0,
        units: 0,
        verified: 0,
        rejected: 0,
        grades: { strong: 0, partial: 0, thin: 0, nothing: 0 },
        files: [],
        skills: [],
    };
}
/** Never throws: a missing or unreadable record means "nothing learned yet", not a failed greeting. */
export async function loadOwner(root) {
    try {
        const raw = JSON.parse(await fs.readFile(ownerFile(root), "utf8"));
        if (!raw || raw.version !== 1 || typeof raw.missions !== "number")
            return emptyStats();
        const stats = emptyStats();
        stats.firstAt = typeof raw.firstAt === "string" ? raw.firstAt : stats.firstAt;
        stats.lastAt = typeof raw.lastAt === "string" ? raw.lastAt : stats.lastAt;
        stats.missions = Math.max(0, Math.floor(raw.missions));
        stats.units = Math.max(0, Math.floor(raw.units ?? 0));
        stats.verified = Math.max(0, Math.floor(raw.verified ?? 0));
        stats.rejected = Math.max(0, Math.floor(raw.rejected ?? 0));
        for (const g of GRADES) {
            const n = raw.grades?.[g];
            stats.grades[g] = typeof n === "number" && n > 0 ? Math.floor(n) : 0;
        }
        stats.files = Array.isArray(raw.files)
            ? raw.files
                .filter((f) => !!f && typeof f.path === "string" && typeof f.hits === "number")
                .map((f) => ({ path: f.path, hits: Math.max(0, Math.floor(f.hits)) }))
                .slice(0, OWNER_FILE_CAP)
            : [];
        stats.skills = Array.isArray(raw.skills)
            ? raw.skills
                .filter((s) => !!s && typeof s.name === "string" && typeof s.hits === "number")
                .map((s) => ({ name: s.name, hits: Math.max(0, Math.floor(s.hits)) }))
                .slice(0, OWNER_SKILL_CAP)
            : [];
        if (raw.last && typeof raw.last.id === "string" && GRADES.includes(raw.last.grade)) {
            stats.last = {
                id: raw.last.id,
                mission: typeof raw.last.mission === "string" ? raw.last.mission : "",
                grade: raw.last.grade,
                at: typeof raw.last.at === "string" ? raw.last.at : stats.lastAt,
            };
        }
        return stats;
    }
    catch {
        return emptyStats();
    }
}
/** Merge one mission's outcome into the record. Files and skills count once per mission. */
export async function recordMission(root, input) {
    const stats = await loadOwner(root);
    const now = new Date().toISOString();
    stats.missions += 1;
    stats.lastAt = now;
    stats.units += Math.max(0, input.units);
    stats.verified += Math.max(0, input.verified);
    stats.rejected += Math.max(0, input.rejected);
    stats.grades[input.grade] += 1;
    stats.last = { id: input.id, mission: input.mission, grade: input.grade, at: now };
    for (const p of new Set(input.files.filter(Boolean))) {
        const found = stats.files.find((f) => f.path === p);
        if (found)
            found.hits += 1;
        else
            stats.files.push({ path: p, hits: 1 });
    }
    for (const name of new Set(input.skills.filter(Boolean))) {
        const found = stats.skills.find((s) => s.name === name);
        if (found)
            found.hits += 1;
        else
            stats.skills.push({ name, hits: 1 });
    }
    // Most useful first: the ranking is the whole point of keeping the list, and it is stable on ties.
    stats.files.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
    stats.skills.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
    stats.files = stats.files.slice(0, OWNER_FILE_CAP);
    stats.skills = stats.skills.slice(0, OWNER_SKILL_CAP);
    const file = ownerFile(root);
    try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify(stats, null, 2));
        await fs.rename(temp, file);
    }
    catch {
        // The caller decides whether to warn. The returned object is still the merged view, so a read-only
        // project gets a useful greeting for the rest of the process even though nothing was persisted.
    }
    return stats;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/**
 * The block the leader sees before it plans: how much work this repo has seen, and where it keeps
 * landing. It is history and it is labelled as such; it is never a fact about the code.
 */
export function renderOwnerStats(stats, opts = {}) {
    if (!stats.missions)
        return "";
    const grades = GRADES.filter((g) => stats.grades[g] > 0).map((g) => `${stats.grades[g]} ${g.toUpperCase()}`);
    const hot = stats.files.slice(0, opts.files ?? 5).map((f) => `${f.path} (${f.hits})`);
    const lines = [
        "=== HOW THIS OWNER HAS WORKED IN THIS REPO (history, never evidence about the code) ===",
        `Missions run here: ${stats.missions} — ${grades.join(", ") || "no grade recorded"}.`,
        ...(hot.length ? [`Files those missions kept landing on: ${hot.join(", ")}.`] : []),
        ...(stats.skills.length ? [`Skills that reached a worker: ${stats.skills.map((s) => `${s.name} (${s.hits})`).join(", ")}.`] : []),
        "Treat this as a map of where the work has been, not as a claim about what the code says: quote the file.",
    ];
    return lines.join("\n");
}
/**
 * The greeting's section. Cheap by construction: one small JSON file, no model, no git, no scan.
 * It also tells the assistant how to teach the collective a preference, because that is the half of
 * "learns me" a server cannot infer.
 */
export function renderOwnerSection(stats, opts = {}) {
    if (!stats.missions) {
        return [
            "## What I know about you and this work",
            "- Nothing learned yet — the first mission starts this record.",
            '- Teach a standing preference any time with `collective_memory { action: "ruling", text }`; it is permanent and reaches every prompt.',
        ].join("\n");
    }
    const grades = GRADES.filter((g) => stats.grades[g] > 0).map((g) => `${stats.grades[g]} ${g.toUpperCase()}`);
    const hot = stats.files.slice(0, opts.files ?? 5).map((f) => `${f.path} (${f.hits})`);
    return [
        "## What I know about you and this work",
        `- ${plural(stats.missions, "mission")} in this repo since ${stats.firstAt.slice(0, 10)}: ${grades.join(", ") || "no grade recorded"}${stats.last ? `, last one ${stats.last.grade.toUpperCase()} (“${stats.last.mission.slice(0, 90)}”)` : ""}.`,
        ...(hot.length ? [`- Files those missions kept landing on: ${hot.join(", ")}.`] : []),
        ...(stats.skills.length ? [`- Skills that have actually reached a worker: ${stats.skills.map((s) => `${s.name} (${s.hits})`).join(", ")}.`] : []),
        "- Your standing preferences are the rulings listed above; add one with `collective_memory { action: \"ruling\", text }`. Mission outcomes are recorded here automatically, no model call.",
    ].join("\n");
}
