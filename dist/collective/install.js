/**
 * Making the greeting automatic.
 *
 * Nothing in MCP lets a server open a conversation, so "run every time I open a new session" has to be
 * carried by something the host already reads on its own: the repository's own instruction file. This
 * writes one short block between markers into the files the hosts actually read, telling them to call
 * `collective_hello` at the start of a session in this repo and whenever the owner says "Hello collective."
 *
 * Which files those are is not guesswork — it is the one part of this feature that external documentation
 * settles, so the table below carries the sources:
 *   - AGENTS.md is read natively by OpenAI Codex (root-to-cwd chain, `AGENTS.override.md` first), Cursor
 *     (root and nested), GitHub Copilot (coding agent and CLI), Windsurf/Cascade, and Claude Code v2.1.277+
 *     — but Claude Code's default `claude-md-or-agents-md` reads CLAUDE.md / .claude/CLAUDE.md /
 *     CLAUDE.local.md INSTEAD when one exists in the working directory or an ancestor, so a repo with a
 *     CLAUDE.md and only an AGENTS.md block is silently uncovered.
 *   - CLAUDE.md (and .claude/CLAUDE.md) is Claude Code's own project file. When a repo has both,
 *     `claude-md-and-agents-md` loads both; the default loads only the CLAUDE file.
 *   - GEMINI.md is Gemini CLI's default context file; it does not read AGENTS.md unless `context.fileName`
 *     is configured to include it, which is not this server's business to edit.
 *   - .github/copilot-instructions.md is Copilot's repo-wide file (path-specific rules live in
 *     .github/instructions/**\/*.instructions.md with `applyTo` frontmatter).
 *   - .cursor/rules/*.mdc and .windsurf/rules/*.md are rule directories with required frontmatter; they are
 *     deliberately not written here, because a plain-markdown block dropped in them would be ignored.
 *   - .windsurfrules is Windsurf's legacy single file, so it is only appended to, never created.
 *
 * The rules that keep this polite:
 *   - one file per host family, the one the repo already has, so no repo gets the same block twice in one
 *     host's context;
 *   - AGENTS.md is the only file it creates, since every other family is either already reached through
 *     AGENTS.md or is a host-specific file the repo either has or does not;
 *   - it only ever touches the text between its own markers, so a hand-written AGENTS.md survives intact;
 *   - writing the same block twice is a no-op, and it says so rather than rewriting the file;
 *   - `remove` takes the block out and leaves everything else exactly as it was;
 *   - it reports the families it did not cover and the exact `targets` to pass if you want them, instead of
 *     quietly creating files the repo never had;
 *   - it never invents a rule the tooling cannot carry — every clause names a tool or a resource that
 *     exists on this server.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assertUsableRoot } from "../project.js";
export const BLOCK_START = "<!-- design-mcp:collective:start -->";
export const BLOCK_END = "<!-- design-mcp:collective:end -->";
/** The instruction files a host reads on its own, grouped into families so only one per family is written. */
export const INSTRUCTION_TARGETS = [
    { path: "AGENTS.md", family: "agents", hosts: ["Codex", "Cursor", "GitHub Copilot", "Windsurf", "Freebuff"], coveredByAgents: true },
    { path: "CLAUDE.md", family: "claude", hosts: ["Claude Code"], coveredByAgents: false },
    { path: ".claude/CLAUDE.md", family: "claude", hosts: ["Claude Code"], coveredByAgents: false },
    { path: "GEMINI.md", family: "gemini", hosts: ["Gemini CLI (its default context file)"], coveredByAgents: false },
    { path: ".github/copilot-instructions.md", family: "copilot", hosts: ["GitHub Copilot, repo-wide"], coveredByAgents: true },
    { path: ".windsurfrules", family: "windsurf", hosts: ["Windsurf (legacy single file)"], coveredByAgents: true },
];
/** Kept for the reports below: the two files that cover Codex, Cursor, Copilot, Windsurf and Claude Code. */
export const DEFAULT_TARGETS = ["AGENTS.md", "CLAUDE.md"];
const targetOf = (p) => INSTRUCTION_TARGETS.find((t) => t.path === p) ?? null;
export function sessionBlock() {
    return [
        BLOCK_START,
        "<!-- managed by design-mcp: edit inside these markers only by asking the collective to reinstall -->",
        "## Session start: the collective",
        "",
        "This repository has a codebase-grounded collective available over MCP (server `design-mcp`).",
        "",
        "- **At the start of a session in this repo, and whenever the owner says \"Hello collective.\", call",
        "  `collective_hello` first, before any other work.** It returns the repo digest, what the collective",
        "  already established or already got wrong here, the open missions and the skills the owner installed.",
        "  Answer from that, never from memory of this repo.",
        "- Ground every statement about this code in `code_digest` / `code_context`, check it with",
        "  `code_verify_cites`, check where a change would land with `code_verify_edits` before you make it,",
        "  and run real work through `collective_plan` / `collective_run`. The full ground rules are the resource",
        "  `code://focus`.",
        "- The owner's installed skills are `skills_list` (resource `code://skills`); `skills_read` returns one in",
        "  full. A collective unit can be assigned a skill, whose text then goes into that worker's prompt.",
        "- Finish by running this project's own gates and reporting what was verified by running, what only by",
        "  reading, and what was not checked.",
        BLOCK_END,
    ].join("\n");
}
async function readIfPresent(file) {
    try {
        return await fs.readFile(file, "utf8");
    }
    catch {
        return null;
    }
}
const blockOf = (text) => {
    const start = text.indexOf(BLOCK_START);
    if (start < 0)
        return null;
    const end = text.indexOf(BLOCK_END, start);
    if (end < 0)
        return null;
    return { before: text.slice(0, start), after: text.slice(end + BLOCK_END.length), found: true };
};
/**
 * Which files this repo should carry the block in.
 *
 * With explicit `targets`, only those are considered: the ones that exist, plus the first one created when
 * `create` allows it. Otherwise the families above decide, taking the file the repo already has and naming —
 * never creating — the families it has nothing for.
 */
export async function planTargets(root, opts = {}) {
    if (opts.targets?.length) {
        const files = [];
        for (const t of opts.targets)
            if ((await readIfPresent(path.resolve(root, t))) !== null)
                files.push(t);
        if (!files.length && opts.create !== false)
            files.push(opts.targets[0]);
        return { files, uncovered: [] };
    }
    const families = [];
    for (const t of INSTRUCTION_TARGETS)
        if (!families.includes(t.family))
            families.push(t.family);
    const files = [];
    const missing = [];
    for (const family of families) {
        const candidates = INSTRUCTION_TARGETS.filter((t) => t.family === family);
        let picked = null;
        for (const c of candidates) {
            if ((await readIfPresent(path.resolve(root, c.path))) !== null) {
                picked = c;
                break;
            }
        }
        if (picked)
            files.push(picked.path);
        else
            missing.push(candidates[0]);
    }
    // AGENTS.md is the one file this will create, because it is the file the most hosts read and because a
    // repo that only has a host-specific file (say .claude/CLAUDE.md) covers that host and no other. It is
    // created even alongside an existing CLAUDE.md, where Claude Code's default skips it anyway — so the
    // file adds coverage for Codex, Cursor, Copilot and Windsurf and never repeats the block in one host.
    if (!files.includes("AGENTS.md") && opts.create !== false)
        files.unshift("AGENTS.md");
    // A gap is a host reached by no file we are writing. A file we are not writing whose hosts already read
    // AGENTS.md is not a gap, so it is named as a second location rather than as something missing.
    const uncovered = files.includes("AGENTS.md")
        ? missing.filter((m) => !m.coveredByAgents && m.path !== "AGENTS.md")
        : missing.filter((m) => m.path !== "AGENTS.md" || opts.create === false);
    return { files, uncovered };
}
/** `dry` reports what it would do and writes nothing — how action=show stays honest. */
export async function installSessionBlock(root, opts = {}) {
    // Writing an instruction block into a home folder would put a session-start instruction into every
    // unrelated project the owner opens. The root has to be a repo, or this does nothing.
    assertUsableRoot(root);
    const block = sessionBlock();
    const { files, uncovered } = await planTargets(root, { targets: opts.targets, create: opts.create });
    const out = [];
    for (const rel of files) {
        const file = path.resolve(root, rel);
        const existing = await readIfPresent(file);
        // Exactly one blank line between the repo's own text and the block, whichever route we took here —
        // otherwise a second install would see "head\n\n" + "\n" + block and rewrite the file it just wrote.
        const raw = existing === null ? "" : blockOf(existing)?.before ?? existing.replace(/\s*$/, "\n\n");
        const head = raw.replace(/\s*$/, raw.trim() ? "\n" : "");
        // An unclosed marker means someone hand-edited it; refuse rather than guess where the block ends.
        if (existing !== null && existing.includes(BLOCK_START) && !existing.includes(BLOCK_END)) {
            out.push({ file: rel, action: "unchanged", bytes: existing.length });
            continue;
        }
        const next = `${head}${head ? "\n" : ""}${block}\n`;
        if (existing === next) {
            out.push({ file: rel, action: "unchanged", bytes: existing.length });
            continue;
        }
        if (!opts.dry) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, next);
        }
        out.push({ file: rel, action: existing === null ? "created" : blockOf(existing) ? "updated" : "appended", bytes: next.length });
    }
    return { results: out, uncovered };
}
export async function removeSessionBlock(root, opts = {}) {
    assertUsableRoot(root);
    const wanted = opts.targets?.length ? opts.targets : INSTRUCTION_TARGETS.map((t) => t.path);
    const out = [];
    for (const rel of wanted) {
        const file = path.resolve(root, rel);
        const existing = await readIfPresent(file);
        if (existing === null) {
            out.push({ file: rel, action: "absent", bytes: 0 });
            continue;
        }
        const found = blockOf(existing);
        if (!found) {
            out.push({ file: rel, action: "absent", bytes: existing.length });
            continue;
        }
        const next = `${found.before.replace(/\s*$/, found.before.trim() ? "\n" : "")}${found.after.replace(/^\s*\n/, "")}`.replace(/^\n+/, "");
        if (!next.trim())
            await fs.rm(file, { force: true });
        else
            await fs.writeFile(file, next);
        out.push({ file: rel, action: "removed", bytes: next.length });
    }
    return out;
}
export function renderInstallReport(results, root, dry = false, uncovered = []) {
    const lines = results.map((r) => {
        const what = r.action === "created"
            ? "created with the session-start block"
            : r.action === "appended"
                ? "the block was appended; the file's own text was left alone"
                : r.action === "updated"
                    ? "the block was replaced between its markers; everything outside them is untouched"
                    : r.action === "removed"
                        ? "the block was removed; the rest of the file is as it was"
                        : r.action === "absent"
                            ? "no block to remove"
                            : "already up to date — nothing written";
        const hosts = targetOf(r.file)?.hosts;
        return `- ${r.file}: ${what} (${r.bytes} bytes)${hosts ? ` — read by ${hosts.join(", ")}` : ""}`;
    });
    const live = results.some((r) => r.action === "created" || r.action === "appended" || r.action === "updated");
    const covered = results.filter((r) => targetOf(r.file));
    const claudeShadow = covered.some((r) => targetOf(r.file)?.family === "claude") && covered.some((r) => r.file === "AGENTS.md");
    return [
        !results.length
            ? dry
                ? `No instruction file to show yet: none of ${DEFAULT_TARGETS.join(" or ")} exists in this project. install would create ${DEFAULT_TARGETS[0]}.`
                : "Nothing changed."
            : dry
                ? live
                    ? "Preview only (action=show): nothing was written. This is what install would do."
                    : "Nothing to do: the block is already up to date and correct."
                : live
                    ? "The collective now announces itself at the start of a session in this repo."
                    : "Nothing changed.",
        "",
        ...lines,
        ...(uncovered.length
            ? [
                "",
                "Hosts this does not reach yet (their own file does not exist here, and none was created):",
                ...uncovered.map((u) => `- ${u.hosts.join(", ")} reads ${u.path}. Pass targets: ["${u.path}"] to create it too.`),
            ]
            : []),
        ...(claudeShadow
            ? [
                "",
                "Why both AGENTS.md and a CLAUDE.md are here: Claude Code's default reads the CLAUDE file instead of AGENTS.md when one exists, while Codex, Cursor, Copilot and Windsurf read AGENTS.md. Both carry the block, so whichever a host loads, it gets told to say hello.",
            ]
            : []),
        "",
        "What this does and does not do:",
        "- It does not make the server speak first — MCP has no way for a server to open a conversation. It relies on the host reading the instruction file it already reads, which is why the block is in the repo rather than in the server.",
        `- The block lives between ${BLOCK_START} and ${BLOCK_END}. Your own text in those files is never touched, and removing the block restores the file.`,
        "- One file per host family: a repo with both CLAUDE.md and .claude/CLAUDE.md gets the block in the root one only, so no host sees it twice.",
        "- Rule directories are left alone on purpose: .cursor/rules/*.mdc and .windsurf/rules/*.md are ignored unless they carry frontmatter, so a plain block dropped there would do nothing.",
        "- If your host does not read instruction files at all, the marker file is inert and `collective_hello` still works the moment you (or a prompt) call it: type \"Hello collective.\" and call it.",
        dry ? "- Nothing was read outside these files and nothing was written (action=show)." : "",
        `- Project root: ${root}`,
    ]
        .filter(Boolean)
        .join("\n");
}
