/**
 * A deliberately lightweight symbol/import extractor.
 *
 * Why not a real parser: this runs over every file in the repo on every reindex, so it has to cost
 * milliseconds, not seconds, and it must not add a runtime dependency to a server that is started as
 * `node dist/index.js`. It is an INDEX, not a type checker: it finds declarations, their line span and
 * what they are called, and it never claims to understand the code. Anything it cannot see is reported
 * as absent rather than guessed, which is the only safe direction for an anti-hallucination layer.
 *
 * Known limits, stated where they matter: depth is counted after stripping comments and string bodies,
 * so a declaration spanning an unbalanced brace inside a template literal or a regex can end early;
 * computed export names and re-exports through `export * from` are not followed.
 */
export const LANG_BY_EXT = {
    ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
    ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
    ".json": "json", ".css": "css", ".html": "html", ".htm": "html",
    ".md": "md", ".mdx": "md", ".py": "py", ".sql": "sql",
    ".sh": "sh", ".bash": "sh", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
};
export const CODE_LANGS = ["ts", "tsx", "js", "jsx", "py"];
export const isCode = (lang) => CODE_LANGS.includes(lang);
export function langOf(file) {
    const m = file.toLowerCase().match(/\.[a-z0-9]+$/);
    return m ? LANG_BY_EXT[m[0]] ?? "other" : "other";
}
/** A line this long means a bundler wrote the file: keep the file, skip its symbols. */
export const MINIFIED_LINE = 1000;
/**
 * Strip comments and string bodies so brace counting is not thrown by prose.
 *
 * Line-oriented ON PURPOSE: the result must have exactly as many lines as the input, because the
 * caller indexes it with line numbers from the original text. A regex that collapses a multi-line
 * JSDoc block into one space shifts every following line and silently breaks the whole file — which
 * is exactly what happened to 24 real files before this was written this way.
 */
function stripForDepth(text) {
    const out = [];
    let inBlock = false;
    for (const raw of text.split("\n")) {
        let kept = "";
        let i = 0;
        while (i < raw.length) {
            if (inBlock) {
                const end = raw.indexOf("*/", i);
                if (end === -1) {
                    i = raw.length;
                    break;
                }
                inBlock = false;
                i = end + 2;
                continue;
            }
            const block = raw.indexOf("/*", i);
            const line = raw.indexOf("//", i);
            if (block !== -1 && (line === -1 || block < line)) {
                kept += raw.slice(i, block);
                inBlock = true;
                i = block + 2;
                continue;
            }
            if (line !== -1) {
                kept += raw.slice(i, line);
                break;
            }
            kept += raw.slice(i);
            break;
        }
        out.push(kept.replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``").replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''"));
    }
    return out.join("\n");
}
function depthDelta(line) {
    let d = 0;
    for (const ch of line) {
        if (ch === "{" || ch === "(" || ch === "[")
            d++;
        else if (ch === "}" || ch === ")" || ch === "]")
            d--;
    }
    return d;
}
/**
 * End line of a declaration that opens on `start` (0-indexed line array). Never runs past the file.
 *
 * Balanced depth alone is not enough: `export const loginPage = ({ settings }) =>` balances on its own
 * line while the body lives on the next ones, and reporting line 358-358 would hand a packer a
 * signature with no body as its "evidence". So a line that balances but is visibly unfinished keeps
 * reading: a trailing `=>`, `{`, `(`, `[`, `,`, `|`, `&`, `=` or `:`, or a function/class/interface/enum
 * whose opening brace has not arrived yet.
 */
function spanOf(lines, start, stripped) {
    const UNFINISHED = /(=>|\{|\[|\(|,|\||&|=|:)\s*$/;
    let depth = 0;
    for (let i = start; i < lines.length && i < start + 400; i++) {
        depth += depthDelta(stripped[i]);
        if (depth < 0)
            return i + 1;
        if (depth === 0) {
            const t = stripped[i].trimEnd();
            if (/[;}]$/.test(t))
                return i + 1;
            const bodyLater = /\b(function|class|interface|enum)\b/.test(t) && !/\{/.test(t);
            if (!bodyLater && !UNFINISHED.test(t))
                return i + 1;
            if (i > start + 40)
                return i + 1; // an unfinished line that never finishes: stop somewhere sane
        }
    }
    return Math.min(lines.length, start + 1);
}
/** The comment block immediately above a line, if there is one. */
function docAbove(lines, start) {
    const out = [];
    for (let i = start - 1; i >= 0 && out.length < 6; i--) {
        const t = lines[i].trim();
        if (!t)
            break;
        if (/^(\/\/|\*|\/\*|#)/.test(t))
            out.unshift(t.replace(/^(\/\/|\/\*+|\*+\/?|#+)\s?/, "").replace(/\*\/$/, "").trim());
        else
            break;
    }
    const doc = out.join(" ").trim();
    return doc ? doc.slice(0, 200) : undefined;
}
const TS_DECL = /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
function kindFor(kw, name, line, lang) {
    const jsx = lang === "tsx" || lang === "jsx";
    const pascal = /^[A-Z]/.test(name);
    if (kw === "function")
        return jsx && pascal ? "component" : "function";
    if (kw === "class")
        return jsx && pascal ? "component" : "class";
    if (kw === "interface" || kw === "type" || kw === "enum")
        return kw;
    // `const NAME = (…) =>` / `= function` / `= async () =>` are functions; everything else is a value.
    return /=\s*(async\s+)?(\(|function\b)|=>/.test(line.slice(line.indexOf("=")) || line) ? "function" : "const";
}
export function extractSymbols(text, lang, path = "") {
    const lines = text.split("\n");
    // Blank the shebang in place rather than deleting its line: `stripped` must stay index-aligned with `lines`.
    const stripped = stripForDepth(text.replace(/^#!.*/, "")).split("\n");
    const symbols = [];
    const imports = [];
    if (lang === "json") {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const key of Object.keys(parsed).slice(0, 40)) {
                    const at = lines.findIndex((l) => new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(l));
                    symbols.push({ name: key, kind: "key", line: at + 1 || 1, endLine: at + 1 || 1, exported: true });
                }
            }
        }
        catch {
            /* invalid JSON is the project's problem, not the index's */
        }
        return { symbols, imports };
    }
    if (lang === "md") {
        lines.forEach((line, i) => {
            const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
            if (m)
                symbols.push({ name: m[2].slice(0, 90), kind: "heading", line: i + 1, endLine: i + 1, exported: true, doc: lines[i + 2]?.trim().slice(0, 140) });
        });
        return { symbols, imports };
    }
    if (lang === "css") {
        lines.forEach((line, i) => {
            for (const m of line.matchAll(/(^|\s)--([\w-]{2,})\s*:/g))
                symbols.push({ name: `--${m[2]}`, kind: "key", line: i + 1, endLine: i + 1, exported: true });
        });
        return { symbols, imports }; // @import/url() targets are build-time asset paths, not module edges
    }
    if (lang === "py") {
        lines.forEach((line, i) => {
            const def = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/);
            const cls = line.match(/^class\s+([A-Za-z_]\w*)/);
            if (def)
                symbols.push({ name: def[1], kind: "function", line: i + 1, endLine: pySpan(lines, i), exported: !def[1].startsWith("_"), doc: docAbove(lines, i) });
            else if (cls)
                symbols.push({ name: cls[1], kind: "class", line: i + 1, endLine: pySpan(lines, i), exported: true, doc: docAbove(lines, i) });
            const imp = line.match(/^\s*(?:from\s+([\w.]+)\s+)?import\s+([\w.,\s*]+)/);
            if (imp)
                imports.push({ spec: (imp[1] ?? imp[2].split(",")[0]).trim(), line: i + 1, kind: "static" });
        });
        return { symbols, imports };
    }
    if (!isCode(lang))
        return { symbols, imports };
    lines.forEach((line, i) => {
        const m = line.match(TS_DECL);
        if (m) {
            const kw = m[6];
            const name = m[7];
            const exported = !!m[1] || !!m[2];
            symbols.push({
                name,
                kind: kindFor(kw, name, line, lang),
                line: i + 1,
                endLine: kw === "type" || kw === "interface" ? Math.max(i + 1, continuation(lines, i, stripped)) : spanOf(lines, i, stripped),
                exported,
                doc: docAbove(lines, i),
            });
            return;
        }
        const re = line.match(/^\s*export\s*(?:type\s*)?\{([^}]*)\}/);
        if (re) {
            const names = re[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
            if (names.length)
                symbols.push({ name: names.join(", ").slice(0, 80), kind: "reexport", line: i + 1, endLine: i + 1, exported: true });
        }
    });
    lines.forEach((line, i) => {
        const from = line.match(/^\s*import\s+(?:type\s+)?(?:[\s\S]*?)\bfrom\s+["']([^"']+)["']/) ?? line.match(/^\s*import\s+["']([^"']+)["']/);
        if (from)
            imports.push({ spec: from[1], line: i + 1, kind: importKind(from[1]) });
        for (const d of line.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
            imports.push({ spec: d[1], line: i + 1, kind: /^import/.test(d[0]) ? "dynamic" : "static" });
        }
    });
    return { symbols, imports };
}
function importKind(spec) {
    if (/\.(css|scss|sass|less)$/.test(spec))
        return "css";
    if (/\.(png|jpe?g|webp|avif|svg|gif|woff2?|ttf|mp4|webm|json|md)$/.test(spec))
        return "asset";
    return "static";
}
/** `type`/`interface` bodies can also end at a blank line before the next declaration. */
function continuation(lines, start, stripped) {
    let depth = depthDelta(stripped[start]);
    let last = start;
    for (let i = start + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (depth <= 0 && /^(export\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\b/.test(t))
            break;
        depth += depthDelta(stripped[i]);
        last = i;
        if (depth <= 0)
            break;
        if (!t && depth <= 0)
            break;
    }
    return last + 1;
}
function pySpan(lines, start) {
    const indent = lines[start].match(/^\s*/)[0].length;
    let last = start;
    for (let i = start + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t)
            continue;
        const ind = lines[i].match(/^\s*/)[0].length;
        if (ind <= indent)
            break;
        last = i;
    }
    return last + 1;
}
/** One line per symbol, for the digest and for packing: `12-30  export function foo()`. */
export function outline(symbols, opts = {}) {
    return symbols
        .filter((s) => (!opts.exportedOnly || s.exported) && (!opts.kinds || opts.kinds.includes(s.kind)))
        .sort((a, b) => a.line - b.line)
        .map((s) => `${String(s.line).padStart(4)} ${s.exported ? "export " : "       "}${s.kind === "heading" ? "" : s.kind + " "}${s.name}${s.endLine > s.line ? `  (lines ${s.line}-${s.endLine})` : ""}`);
}
