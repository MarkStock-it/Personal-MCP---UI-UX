/**
 * Making the greeting automatic.
 *
 * Nothing in MCP lets a server open a conversation, so "run every time I open a new session" has to be
 * carried by something the host already reads on its own: the repository's own instruction file. This
 * writes one short block between markers into AGENTS.md (and CLAUDE.md, if the repo has one), telling the
 * host to call `collective_hello` at the start of a session in this repo and whenever the owner says
 * "Hello collective."
 *
 * The rules that keep this polite:
 *   - it only ever touches the text between its own markers, so a hand-written AGENTS.md survives intact;
 *   - writing the same block twice is a no-op, and it says so rather than rewriting the file;
 *   - `remove` takes the block out and leaves everything else exactly as it was;
 *   - it never invents a rule the tooling cannot carry — every clause names a tool or a resource that
 *     exists on this server.
 */
import fs from "node:fs/promises";
import path from "node:path";
export const BLOCK_START = "<!-- design-mcp:collective:start -->";
export const BLOCK_END = "<!-- design-mcp:collective:end -->";
export const DEFAULT_TARGETS = ["AGENTS.md", "CLAUDE.md"];
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
        "  `code_verify_cites`, and run real work through `collective_plan` / `collective_run`. The full ground",
        "  rules are the resource `code://focus`.",
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
/** `dry` reports what it would do and writes nothing — how action=show stays honest. */
export async function installSessionBlock(root, opts = {}) {
    const block = sessionBlock();
    const wanted = opts.targets?.length ? opts.targets : DEFAULT_TARGETS;
    const present = [];
    for (const t of wanted)
        if ((await readIfPresent(path.resolve(root, t))) !== null)
            present.push(t);
    const targets = present.length ? present : opts.create === false ? [] : [wanted[0]];
    const out = [];
    for (const rel of targets) {
        const file = path.resolve(root, rel);
        const existing = await readIfPresent(file);
        // Exactly one blank line between the repo's own text and the block, whichever route we took here —
        // otherwise a second install would see "head\n\n" + "\n" + block and rewrite the file it just wrote.
        const raw = existing === null ? "" : blockOf(existing)?.before ?? existing.replace(/\s*$/, "\n\n");
        const head = raw.replace(/\s*$/, raw.trim() ? "\n" : "");
        // An unclosed marker means someone hand-edited it; refuse rather than guess where the block ends.
        if (existing !== null && existing.includes(BLOCK_START) && !existing.includes(BLOCK_END)) {
            return [...out, { file: rel, action: "unchanged", bytes: existing.length }];
        }
        const next = `${head}${head ? "\n" : ""}${block}\n`;
        if (existing === next) {
            out.push({ file: rel, action: "unchanged", bytes: existing.length });
            continue;
        }
        if (!opts.dry)
            await fs.writeFile(file, next);
        out.push({ file: rel, action: existing === null ? "created" : blockOf(existing) ? "updated" : "appended", bytes: next.length });
    }
    return out;
}
export async function removeSessionBlock(root, opts = {}) {
    const wanted = opts.targets?.length ? opts.targets : DEFAULT_TARGETS;
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
export function renderInstallReport(results, root, dry = false) {
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
        return `- ${r.file}: ${what} (${r.bytes} bytes)`;
    });
    const live = results.some((r) => r.action === "created" || r.action === "appended" || r.action === "updated");
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
        "",
        "What this does and does not do:",
        "- It does not make the server speak first — MCP has no way for a server to open a conversation. It relies on the host reading the instruction file it already reads, which is why the block is in the repo rather than in the server.",
        `- The block lives between ${BLOCK_START} and ${BLOCK_END}. Your own text in those files is never touched, and removing the block restores the file.`,
        "- If your host does not read instruction files at all, the marker file is inert and `collective_hello` still works the moment you (or a prompt) call it: type \"Hello collective.\" and call it.",
        dry ? "- Nothing was read outside these files and nothing was written (action=show)." : "",
        `- Project root: ${root}`,
    ]
        .filter(Boolean)
        .join("\n");
}
