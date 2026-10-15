/**
 * The index, and the digest built from it.
 *
 * Why this exists: an assistant that reads whole files burns its context on code it does not need,
 * and an assistant that trusts its memory of a repo invents APIs that were never there. The index is
 * the third option — a description computed from the files themselves, small enough to always fit,
 * carrying real paths, real symbol names and real line numbers, so any claim can be checked against it
 * and anything it does not contain is reported as unknown instead of guessed.
 *
 * Everything here is deterministic: no model is involved, so the digest is the same text every time
 * for the same repo state, and two workers given the same digest cannot disagree about the repo map.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isTestPath, lightScan, scanRepo } from "./scan.js";
import { outline } from "./symbols.js";
/** Mirrors stateDir() from config, but rooted at whatever project we were handed (so it is testable). */
export const indexFile = (root) => path.join(root, ".design-mcp", "codebase", "index.json");
/** ~4 characters per token. An estimate, labelled as one everywhere it surfaces. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "what", "why", "how", "does", "should", "must", "can", "not", "but", "all", "any", "our", "your", "its", "it's", "add", "fix", "make", "need", "want", "use", "using", "code", "file", "files"]);
export function termsOf(query) {
    const raw = query.toLowerCase().split(/[^a-z0-9_.\-]+/).filter(Boolean);
    const out = [];
    for (const t of raw) {
        const clean = t.replace(/^[.\-_]+|[.\-_]+$/g, "");
        if (clean.length < 3 || STOP.has(clean))
            continue;
        if (!out.includes(clean))
            out.push(clean);
        // `src/components/Hero.tsx` should also match on `hero`.
        if (clean.includes("/") || clean.includes(".")) {
            for (const part of clean.split(/[/.\-_]/))
                if (part.length >= 3 && !out.includes(part))
                    out.push(part);
        }
    }
    return out.slice(0, 24);
}
/** Deterministic relevance of each file to the query terms. Used for the digest's focus and the packer. */
export function rankFiles(index, terms) {
    const hotspots = new Map(index.hotspots.map((h) => [h.path, h.importedBy]));
    const entries = new Set(index.entryPoints.map((e) => e.path));
    return index.files
        .map((f) => {
        const lowPath = f.path.toLowerCase();
        const why = [];
        let score = 0;
        let matched = false;
        for (const t of terms) {
            if (lowPath.includes(t)) {
                score += 4;
                matched = true;
                why.push(`path:${t}`);
            }
            const sym = f.symbols.find((s) => s.name.toLowerCase().includes(t));
            if (sym) {
                score += 3;
                matched = true;
                why.push(`symbol:${sym.name}`);
            }
            else if (f.symbols.some((s) => (s.doc ?? "").toLowerCase().includes(t))) {
                score += 1;
                matched = true;
                why.push(`doc:${t}`);
            }
        }
        if (entries.has(f.path))
            score += 1.5;
        if (hotspots.has(f.path))
            score += Math.min(1.5, hotspots.get(f.path) * 0.25);
        if (isTestPath(f.path))
            score += 0.25;
        return { path: f.path, score, why: [...new Set(why)], matched };
    })
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
/**
 * Which real file a relative import points at. TypeScript's NodeNext style imports `"./util.js"` while the
 * file on disk is `util.ts`, so a `.js`-spelled specifier has to be tried as TypeScript source as well —
 * without this, half the edges in a modern TS repo are invisible and the graph lies about who uses what.
 * Path aliases (tsconfig `paths`) are not resolved; those imports are reported as unresolved instead.
 */
const IMPORT_CANDIDATES = (spec) => {
    const bases = [spec];
    const js = spec.match(/\.(js|mjs|cjs|jsx)$/);
    if (js) {
        const stem = spec.slice(0, -js[0].length);
        bases.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    }
    return [...bases, ...bases.flatMap((b) => [`${b}.ts`, `${b}.tsx`, `${b}.js`, `${b}.jsx`, `${b}.mjs`, `${b}.cjs`, `${b}.json`, `${b}.css`, `${b}/index.ts`, `${b}/index.tsx`, `${b}/index.js`, `${b}/index.jsx`])];
};
function buildGraph(files) {
    const known = new Set(files.map((f) => f.path));
    const graph = {};
    const ext = new Map();
    for (const f of files) {
        const imports = [];
        for (const imp of f.imports) {
            if (!imp.spec.startsWith(".") && !imp.spec.startsWith("/")) {
                // `node:` builtins are the runtime, not a dependency: counting them as "third-party surface"
                // would tell the reader this project depends on the platform.
                if (!imp.spec.startsWith("node:"))
                    ext.set(imp.spec, (ext.get(imp.spec) ?? 0) + 1);
                continue;
            }
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), imp.spec));
            const hit = IMPORT_CANDIDATES(base).find((c) => known.has(c));
            if (hit)
                imports.push(hit);
        }
        graph[f.path] = { imports: [...new Set(imports)], importedBy: [] };
    }
    for (const [from, g] of Object.entries(graph))
        for (const to of g.imports)
            graph[to]?.importedBy.push(from);
    return {
        graph,
        externals: [...ext.entries()].map(([spec, count]) => ({ spec, count })).sort((a, b) => b.count - a.count || a.spec.localeCompare(b.spec)).slice(0, 24),
    };
}
function findEntryPoints(files, conventions) {
    const out = [];
    const push = (p, why) => {
        if (p && files.some((f) => f.path === p) && !out.some((o) => o.path === p))
            out.push({ path: p, why });
    };
    // A script runs from the directory that declares it, so `node src/server.js` in server/package.json
    // means server/src/server.js. Getting this wrong made every entry point vanish in this very repo.
    const dir = conventions.manifestDir ? `${conventions.manifestDir}/` : "";
    for (const s of conventions.scripts) {
        const m = s.command.match(/[\w./-]+\.(?:[cm]?[jt]sx?)/);
        if (m)
            push(`${dir}${m[0].replace(/^\.\//, "")}`, `the "${s.name}" script runs it`);
    }
    for (const p of ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "src/server.ts", "src/server.js", "src/app.ts", "src/app.js", "index.js", "server.js", "main.py", "app.py"]) {
        push(`${dir}${p}`, "conventional entry file name");
    }
    return out.slice(0, 6);
}
export async function buildIndex(projectRoot, cfg, stamp) {
    const scan = await scanRepo(projectRoot, cfg);
    const { graph, externals } = buildGraph(scan.files);
    const byLangMap = new Map();
    for (const f of scan.files) {
        const g = byLangMap.get(f.lang) ?? { lang: f.lang, files: 0, lines: 0 };
        g.files++;
        g.lines += f.lines;
        byLangMap.set(f.lang, g);
    }
    const hotspots = Object.entries(graph)
        .map(([p, g]) => ({ path: p, importedBy: g.importedBy.length }))
        .filter((h) => h.importedBy > 0)
        .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
        .slice(0, 12);
    return {
        version: 1,
        root: projectRoot,
        name: scan.conventions.name,
        generatedAt: new Date().toISOString(),
        buildMs: scan.ms,
        stamp,
        conventions: scan.conventions,
        files: scan.files,
        skipped: scan.skipped,
        notes: scan.notes,
        totals: {
            files: scan.files.length,
            lines: scan.files.reduce((n, f) => n + f.lines, 0),
            bytes: scan.files.reduce((n, f) => n + f.bytes, 0),
            byLang: [...byLangMap.values()].sort((a, b) => b.lines - a.lines),
        },
        graph,
        externals,
        entryPoints: findEntryPoints(scan.files, scan.conventions),
        hotspots,
    };
}
/** The cheap fingerprint that decides whether the cached index is still true. */
export async function stampFor(projectRoot, cfg) {
    const light = await lightScan(projectRoot, cfg);
    const h = crypto.createHash("sha1");
    h.update(JSON.stringify({ roots: cfg.roots, maxFiles: cfg.maxFiles, maxFileKB: cfg.maxFileKB, ignore: [...cfg.ignore].sort() }));
    for (const e of light.entries)
        h.update(`${e.path}:${e.bytes}:${e.mtimeMs}\n`);
    return { stamp: h.digest("hex").slice(0, 16), ms: light.ms, note: light.note };
}
/**
 * The cached index. Copying it fresh is only done when the files changed (path, size or mtime), so a
 * repeated question about an unchanged repo costs one stat pass and no reads.
 */
export async function getIndex(projectRoot, cfg, opts = {}) {
    const { stamp, ms } = await stampFor(projectRoot, cfg);
    if (!opts.refresh) {
        try {
            const cached = JSON.parse(await fs.readFile(indexFile(projectRoot), "utf8"));
            if (cached.version === 1 && cached.stamp === stamp)
                return { index: cached, cached: true, stampMs: ms };
        }
        catch {
            /* no usable cache */
        }
    }
    const index = await buildIndex(projectRoot, cfg, stamp);
    try {
        await fs.mkdir(path.dirname(indexFile(projectRoot)), { recursive: true });
        await fs.writeFile(indexFile(projectRoot), JSON.stringify(index));
    }
    catch {
        /* a read-only project is not a reason to fail the question */
    }
    return { index, cached: false, stampMs: ms };
}
const kb = (n) => Math.round(n / 1024);
export function summarizeIndex(loaded) {
    const { index, cached } = loaded;
    const syms = index.files.reduce((n, f) => n + f.symbols.filter((s) => s.exported).length, 0);
    const ago = Math.round((Date.now() - Date.parse(index.generatedAt)) / 1000);
    return [
        `${index.name}: ${index.totals.files} files, ${index.totals.lines} lines, ${syms} exported symbols (${index.totals.byLang.map((l) => `${l.lang} ${l.files}`).join(", ")})`,
        cached ? `index reused (verified unchanged ${ago}s ago, ${index.buildMs} ms to build it the first time)` : `index built in ${index.buildMs} ms`,
        ...index.notes.map((n) => `note: ${n}`),
    ].join("\n");
}
/**
 * The compact map. Sections are ordered by how much they change a decision, and the tail is dropped
 * (with the drop reported) rather than truncated mid-sentence.
 */
export function renderDigest(index, opts) {
    const terms = opts.focus ? termsOf(opts.focus) : [];
    const ranked = terms.length ? rankFiles(index, terms) : [];
    const rankOf = new Map(ranked.map((r, i) => [r.path, i]));
    const order = index.files
        .slice()
        .sort((a, b) => {
        if (terms.length)
            return (rankOf.get(a.path) ?? 999) - (rankOf.get(b.path) ?? 999);
        const hot = new Map(index.hotspots.map((h) => [h.path, h.importedBy]));
        return (hot.get(b.path) ?? 0) - (hot.get(a.path) ?? 0) || b.lines - a.lines;
    })
        .filter((f) => f.symbols.some((s) => s.exported) || isTestPath(f.path));
    const head = [
        `# ${index.name} — codebase digest`,
        `${index.totals.files} files, ${index.totals.lines} lines, ${kb(index.totals.bytes)} KB, ${index.totals.byLang.map((l) => `${l.lang} ${l.files}`).join(" / ")}`,
        `Everything below is computed from the files at ${index.root}. If something is not listed, it is not known — read the file, do not assume.`,
        "",
        "## How this project is built and run",
        `stack: ${[index.conventions.typescript ? `typescript${index.conventions.tsStrict ? " (strict)" : ""}` : null, index.conventions.moduleSystem, index.conventions.packageManager, ...index.conventions.frameworks].filter(Boolean).join(", ") || "unknown"}`,
        index.conventions.manifestPath ? `manifest: ${index.conventions.manifestPath}${index.conventions.packageName ? ` (${index.conventions.packageName})` : ""}` : "manifest: no package.json anywhere in the indexed files",
        ...index.conventions.scripts.slice(0, 8).map((s) => `run ${index.conventions.manifestDir ? `in ${index.conventions.manifestDir}/` : ""}: ${s.name} -> \`${s.command}\``),
        index.conventions.test ? "" : "warning: the nearest package.json declares no test script",
        "",
        "## The project's own rules (read these files in full before changing behaviour)",
        ...index.conventions.notes.map((n) => `- ${n.path} — ${n.heading}`),
        ...(index.entryPoints.length ? ["", "## Entry points", ...index.entryPoints.map((e) => `- ${e.path} — ${e.why}`)] : []),
        ...(index.hotspots.length ? ["", "## Most imported (change these carefully)", ...index.hotspots.slice(0, 8).map((h) => `- ${h.path} — imported by ${h.importedBy}`)] : []),
        ...(index.conventions.tests.length ? ["", "## Tests", `- ${index.conventions.tests.join("\n- ")}`] : []),
        ...(index.externals.length ? ["", "## Third-party surface", `- ${index.externals.slice(0, 12).map((e) => `${e.spec} ×${e.count}`).join(", ")}`] : []),
        "",
        "## Map (line numbers are real; use them for citations)",
    ];
    const budget = opts.tokens;
    const used = () => estimateTokens([...head, ...map].join("\n"));
    const map = [];
    const dropped = [];
    for (const f of order) {
        const syms = outline(f.symbols.filter((s) => s.exported || s.kind === "heading" || s.kind === "key"), { exportedOnly: true }).slice(0, 12);
        const block = [`### ${f.path}${isTestPath(f.path) ? "  (test)" : ""} — ${f.lines} lines`, ...syms.map((s) => `   ${s}`)];
        if (used() + estimateTokens(block.join("\n")) > budget) {
            dropped.push(f.path);
            continue;
        }
        map.push(...block);
    }
    const tail = [
        ...(dropped.length ? ["", `${dropped.length} more files did not fit the ${budget}-token budget: ${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", ..." : ""}`] : []),
        ...(index.skipped.length ? ["", `${index.skipped.length} files were skipped by the index: ${index.skipped.slice(0, 6).map((s) => `${s.path} (${s.reason})`).join("; ")}`] : []),
        "",
        `digest ~${estimateTokens([...head, ...map].join("\n"))} tokens (budget ${budget}, estimate at ~4 chars/token). Symbol lines come from lightweight extraction, not a type checker: treat a missing symbol as unknown, not as absent.`,
    ];
    return [...head, ...map, ...tail].join("\n");
}
/** The whole file/symbol map, for hosts that want the detail without the source. */
export function renderMap(index, focus) {
    const terms = focus ? termsOf(focus) : [];
    const ranked = terms.length ? rankFiles(index, terms) : [];
    const rankOf = new Map(ranked.map((r, i) => [r.path, i]));
    const files = index.files.slice().sort((a, b) => (terms.length ? (rankOf.get(a.path) ?? 999) - (rankOf.get(b.path) ?? 999) : a.path.localeCompare(b.path)));
    return [
        `# ${index.name} — file and symbol map (${index.totals.files} files)`,
        "",
        ...files.map((f) => {
            const syms = outline(f.symbols, { exportedOnly: false }).slice(0, 40);
            return [`## ${f.path} (${f.lang}, ${f.lines} lines)`, ...syms.map((s) => `   ${s}`)].join("\n");
        }),
    ].join("\n");
}
export function renderGraph(index) {
    const rows = Object.entries(index.graph).filter(([, g]) => g.imports.length || g.importedBy.length);
    return [
        `# ${index.name} — import graph (relative imports only; bare package imports are listed separately)`,
        "",
        ...rows.map(([p, g]) => `- ${p}\n    imports: ${g.imports.join(", ") || "(none)"}\n    imported by: ${g.importedBy.join(", ") || "(nobody)"}`),
        "",
        "## Third-party packages actually imported",
        ...index.externals.map((e) => `- ${e.spec} — used ${e.count}×`),
    ].join("\n");
}
export function renderConventions(index) {
    const c = index.conventions;
    return [
        `# ${c.name} — how this project is actually built`,
        "",
        `- typescript: ${c.typescript ? "yes" : "no"}${c.tsStrict ? " (strict: true in tsconfig)" : ""}`,
        `- module system: ${c.moduleSystem}`,
        `- package manager: ${c.packageManager ?? "unknown (no lockfile found)"}`,
        `- manifest: ${c.manifestPath ?? "none found"}${c.packageName ? ` — ${c.packageName}` : ""}`,
        `- frameworks/libraries in package.json: ${c.frameworks.join(", ") || "none detected"}`,
        `- commands${c.manifestDir ? ` (run inside ${c.manifestDir}/)` : " (run at the repo root)"}: ${c.scripts.map((s) => `${s.name}=\`${s.command}\``).join(", ") || "none"}`,
        `- tests: ${c.tests.join(", ") || "no test files matched"}`,
        "",
        "## Notes and rule files",
        ...c.notes.map((n) => `- ${n.path} — ${n.heading}`),
        "",
        "## Everything the index skipped",
        ...(index.skipped.length ? index.skipped.map((s) => `- ${s.path} — ${s.reason}`) : ["- (nothing)"]),
    ].join("\n");
}
