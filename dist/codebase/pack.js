/**
 * Packing: turning a question into the smallest set of real source lines that can answer it.
 *
 * The packer is the difference between "read the repo" and "read the repo". Every slice carries the
 * file's own line numbers, so anything an assistant writes from it can be checked afterwards
 * (`code_verify_cites`), and every file that was considered but left out is named with the reason, so
 * the assistant knows the difference between "not there" and "not in my context".
 *
 * Selection is deterministic and cheap: index ranking first (paths, symbol names, docs, hotspots),
 * then one hop along the import graph, then real source read only for the files that made the cut.
 */
import { estimateTokens, rankFiles, termsOf } from "./store.js";
import { readSource } from "./scan.js";
const CONTEXT_LINES = 2;
/** No single slice may eat more than this share of the budget. */
const MAX_SLICE_SHARE = 0.45;
function numbered(lines, from, to) {
    const out = [];
    for (let i = from; i <= to && i <= lines.length; i++)
        out.push(`${String(i).padStart(5)}| ${lines[i - 1] ?? ""}`);
    return out.join("\n");
}
function mergeRanges(rs) {
    const sorted = rs.slice().sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
        const last = out.at(-1);
        if (last && r[0] <= last[1] + 3)
            last[1] = Math.max(last[1], r[1]);
        else
            out.push([...r]);
    }
    return out;
}
/** Which line ranges of this file the question actually needs. */
function rangesFor(file, terms, whole, maxLines) {
    if (whole)
        return { ranges: [[1, Math.min(file.lines, maxLines)]], why: "small file, included whole" };
    const hits = file.symbols.filter((s) => {
        const name = s.name.toLowerCase();
        const doc = (s.doc ?? "").toLowerCase();
        return terms.some((t) => name.includes(t) || doc.includes(t));
    });
    if (hits.length) {
        const ranges = mergeRanges(hits.map((s) => [Math.max(1, s.line - CONTEXT_LINES), Math.min(file.lines, s.endLine + CONTEXT_LINES)]));
        return { ranges, why: `matched ${hits.slice(0, 3).map((h) => h.name).join(", ")}` };
    }
    const exported = file.symbols.filter((s) => s.exported);
    if (exported.length) {
        const ranges = mergeRanges(exported.slice(0, 6).map((s) => [Math.max(1, s.line - CONTEXT_LINES), Math.min(file.lines, s.endLine + CONTEXT_LINES)]));
        return { ranges, why: "no symbol matched the question; the public surface is included instead" };
    }
    return { ranges: [[1, Math.min(file.lines, Math.min(60, maxLines))]], why: "no symbols to trim by; the file head is shown" };
}
export async function packContext(projectRoot, index, opts) {
    const t0 = Date.now();
    const terms = termsOf(opts.query);
    const notes = [];
    const omitted = [];
    const known = new Map(index.files.map((f) => [f.path, f]));
    const exclude = new Set(opts.exclude ?? []);
    const budget = Math.max(400, opts.budget);
    const picked = new Map();
    const add = (p, score, why) => {
        if (exclude.has(p)) {
            omitted.push({ path: p, reason: "excluded on purpose (another workstream owns it)" });
            return;
        }
        const prev = picked.get(p);
        if (!prev || score > prev.score)
            picked.set(p, { score, why });
    };
    for (const p of opts.paths ?? []) {
        const clean = p.replace(/^\.\//, "");
        if (known.has(clean))
            add(clean, 100, "named in the request");
        else
            omitted.push({ path: p, reason: "not in the index: it does not exist, or it is ignored, binary, minified or over the size cap" });
    }
    if (!(opts.paths ?? []).length) {
        const ranked = rankFiles(index, terms).filter((r) => r.matched);
        if (ranked.length) {
            for (const r of ranked.slice(0, opts.seeds ?? 8))
                add(r.path, r.score, r.why.join(" ") || "closest match to the question");
        }
        else {
            notes.push(`nothing in the index matched "${opts.query}", so the repo's centre of gravity is shown instead`);
            for (const e of index.entryPoints.slice(0, 2))
                add(e.path, 5, e.why);
            for (const h of index.hotspots.slice(0, 3))
                add(h.path, 4, `imported by ${h.importedBy} files`);
        }
    }
    for (const sym of opts.symbols ?? []) {
        const file = index.files.find((f) => f.symbols.some((s) => s.name === sym));
        if (file)
            add(file.path, 90, `defines ${sym}`);
        else
            omitted.push({ path: sym, reason: `no symbol named ${sym} exists in the index` });
    }
    // One hop along the graph: what the seeds depend on, and who would break if they changed.
    const hopLimit = 12;
    let hops = 0;
    for (const [p, info] of [...picked]) {
        const g = index.graph[p];
        if (!g)
            continue;
        for (const dep of g.imports) {
            if (hops++ > hopLimit)
                break;
            add(dep, info.score * 0.6, `imported by ${p}`);
        }
        for (const user of g.importedBy.slice(0, 3)) {
            if (hops++ > hopLimit)
                break;
            add(user, info.score * 0.7, `uses ${p}, so it may need changing too`);
        }
    }
    const ordered = [...picked.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const perSlice = Math.floor(budget * MAX_SLICE_SHARE);
    const slices = [];
    let used = 0;
    for (const [p, info] of ordered) {
        const file = known.get(p);
        const text = await readSource(projectRoot, p);
        if (text === null) {
            omitted.push({ path: p, reason: "unreadable now (deleted or binary) even though the index listed it" });
            continue;
        }
        const lines = text.split("\n");
        const remaining = budget - used;
        if (remaining < 60) {
            omitted.push({ path: p, reason: `over the ${budget}-token budget` });
            continue;
        }
        const whole = file.lines <= 160 && file.bytes < 24_000;
        const { ranges, why } = rangesFor(file, terms, whole, Math.max(20, perSlice));
        // Trim ranges until the slice fits its share and what is left of the budget.
        let kept = [];
        let truncated = false;
        const cap = Math.max(20, Math.min(perSlice, remaining) - 20); // the header line and markers cost too
        let acc = 0;
        for (const r of ranges) {
            const len = r[1] - r[0] + 1;
            if (acc + len > cap) {
                const room = cap - acc;
                if (room >= 8) {
                    kept.push([r[0], r[0] + room - 1]);
                    acc += room;
                }
                truncated = true;
                break;
            }
            kept.push(r);
            acc += len;
        }
        if (!kept.length) {
            omitted.push({ path: p, reason: "over the token budget" });
            continue;
        }
        const body = kept.map((r) => numbered(lines, r[0], r[1])).join("\n     …\n");
        const header = `--- ${p} — ${kept.map((r) => (r[0] === r[1] ? `line ${r[0]}` : `lines ${r[0]}-${r[1]}`)).join(", ")} of ${file.lines} — ${info.why}`;
        const sliceText = `${header}\n${body}`;
        const tokens = estimateTokens(sliceText);
        if (used + tokens > budget) {
            omitted.push({ path: p, reason: `over the ${budget}-token budget` });
            continue;
        }
        used += tokens;
        slices.push({ path: p, ranges: kept, text: sliceText, why: info.why, tokens, truncated });
    }
    return {
        query: opts.query,
        tokens: used,
        budget,
        slices,
        omitted,
        notes,
        ms: Date.now() - t0,
    };
}
/** The pack as text, with the contract that makes it checkable. */
export function renderPack(pack) {
    const head = [
        `Context for: ${pack.query}`,
        `${pack.slices.length} files, ~${pack.tokens} of a ${pack.budget}-token budget, packed in ${pack.ms} ms. Line numbers are the file's real numbers: cite as path:line.`,
        ...pack.notes.map((n) => `note: ${n}`),
    ];
    const body = pack.slices.length
        ? pack.slices.map((s) => s.text + (s.truncated ? "\n     [cut at the token budget]" : ""))
        : ["(nothing matched: the pack is empty, so the answer must be 'not in the indexed codebase', not a guess.)"];
    const tail = [
        "",
        pack.omitted.length
            ? "Considered and left out (a file listed here is not evidence that the code is not there):"
            : "Considered and left out: nothing — every file that matched the question fits the budget.",
        ...pack.omitted.slice(0, 25).map((o) => `  - ${o.path}: ${o.reason}`),
    ];
    return [...head, "", ...body, ...tail].join("\n");
}
