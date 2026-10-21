/**
 * The one door every path argument of `agent_run` goes through.
 *
 * Three separate mistakes are refused here, and they are separate on purpose because each one has a different
 * fix on the caller's side:
 *   - the path names something outside the project, or escapes through `..`/an absolute path;
 *   - the path resolves outside the project through a symlink — which `path.resolve` cannot see, so the check
 *     is `realpath` of the deepest EXISTING ancestor, with the not-yet-created tail appended lexically;
 *   - the path is inside the project but is a place no model may touch: `.git/` (history), `node_modules/`
 *     (not ours), `.design-mcp/` (the journal and pre-images live there, so a write would erase the evidence),
 *     `dist/` (generated), or the secret list.
 *
 * A refusal always names the rule it hit. The model can only correct what it is told, and a bare "denied" is
 * how a loop spends three rounds guessing.
 *
 * Honest boundary: this binds the FILE tools. A shell command is not a path argument — `bash.mode: "shell"` is
 * the owner's terminal in that directory, and no path check here constrains it. See `bash.ts` and the plan.
 */
import fs from "node:fs/promises";
import path from "node:path";
/** Directories no model may read or write, whatever the config says. */
const DENIED_SEGMENTS = [".git", "node_modules", ".design-mcp", "dist"];
/** Files whose contents are credentials, not code. */
const SECRET_BASENAMES = [
    /^\.env(\..*)?$/i,
    /^\.npmrc$/i,
    /^\.netrc$/i,
    /\.pem$/i,
    /\.key$/i,
    /\.p12$/i,
    /^id_rsa/i,
    /^id_ed25519/i,
    /^\.git-credentials$/i,
];
/** Backslashes are accepted on input and normalised, so a Windows-style path is not a different path. */
export const toPosix = (p) => p.split("\\").join("/");
export const inside = (root, child) => {
    const rel = path.relative(root, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const denyReason = (rel) => {
    const segments = toPosix(rel).split("/");
    for (const seg of segments) {
        if (DENIED_SEGMENTS.includes(seg)) {
            return rel.includes(".design-mcp")
                ? `${rel}: refused — .design-mcp/ holds the run's own journal and pre-images, so it is unreadable and unwritable by a tool`
                : `${rel}: refused — ${seg}/ is never read or written by a tool`;
        }
    }
    const base = segments[segments.length - 1] ?? "";
    if (SECRET_BASENAMES.some((re) => re.test(base))) {
        return `${rel}: refused — that is a secret file; this tool does not read credentials`;
    }
    return null;
};
/**
 * Resolve an existing prefix with `realpath` and append the part that does not exist yet. This is the
 * difference between "the path I will write" and "where that path really points".
 */
async function realpathDeepest(abs) {
    const rest = [];
    let cur = abs;
    for (;;) {
        try {
            const real = await fs.realpath(cur);
            return rest.length ? path.join(real, ...rest.reverse()) : real;
        }
        catch {
            const parent = path.dirname(cur);
            if (parent === cur)
                return abs;
            rest.push(path.basename(cur));
            cur = parent;
        }
    }
}
export function normalizeRel(raw) {
    const s = raw.trim();
    if (!s)
        return { ok: false, reason: "an empty path names nothing" };
    if (s.includes("\0"))
        return { ok: false, reason: "a path may not contain a NUL byte" };
    const posix = toPosix(s);
    if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) {
        return { ok: false, reason: `${raw}: absolute paths are refused; give a path relative to the project root` };
    }
    const rel = path.posix.normalize(posix).replace(/^\.\//, "");
    if (!rel || rel === ".")
        return { ok: false, reason: `${raw}: that names the project root, not a file` };
    if (rel === ".." || rel.startsWith("../")) {
        return { ok: false, reason: `${raw}: refused — the path leaves the project` };
    }
    return { ok: true, rel };
}
async function resolve(sandbox, raw, mode) {
    const n = normalizeRel(raw);
    if (!n.ok)
        return n;
    const denied = denyReason(n.rel);
    if (denied)
        return { ok: false, reason: denied };
    const rootReal = await fs.realpath(sandbox.root).catch(() => path.resolve(sandbox.root));
    const abs = path.resolve(rootReal, n.rel);
    if (!inside(rootReal, abs)) {
        return { ok: false, reason: `${raw}: refused — that path is outside the project` };
    }
    const realAbs = await realpathDeepest(abs);
    if (!inside(rootReal, realAbs)) {
        return {
            ok: false,
            reason: `${raw}: refused — the path resolves outside the project through a symlink (${realAbs})`,
        };
    }
    if (mode === "write") {
        if (!sandbox.writeRoots.length) {
            return {
                ok: false,
                reason: `${raw}: refused — this run is read-only (agent.writeRoots is empty); nothing may be written`,
            };
        }
        const roots = sandbox.writeRoots.map((r) => path.posix.normalize(toPosix(r)).replace(/^\.\//, "").replace(/\/$/, ""));
        const allowed = roots.some((r) => n.rel === r || n.rel.startsWith(`${r}/`));
        if (!allowed) {
            return {
                ok: false,
                reason: `${raw}: refused — outside the directories this run may write (${sandbox.writeRoots.join(", ")})`,
            };
        }
    }
    return { ok: true, abs, rel: n.rel };
}
export const resolveRead = (sandbox, raw) => resolve(sandbox, raw, "read");
export const resolveWrite = (sandbox, raw) => resolve(sandbox, raw, "write");
