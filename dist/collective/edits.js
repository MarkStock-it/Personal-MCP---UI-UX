/**
 * The edit gate: what the collective is about to change, checked before anyone changes it.
 *
 * The mission loop already refuses to believe a claim whose quote is not in the file. It did nothing of
 * the sort for the work the mission actually produces. A worker could hand back a step whose path does not
 * exist, whose "anchor" symbol was never in that file, or whose line range is past the end of a file that
 * changed yesterday — and it would travel into the dossier, into memory, and into the owner's editor as if
 * the server had looked at it. Findings were gated; the edits were prose.
 *
 * That gap is measured, not theoretical. In repository-level code generation, undefined or unimported
 * project functions and attributes (dependency conflicts) were 11.26% of the hallucination categories
 * identified, with API knowledge conflicts at 20.41% — shares of the coded hallucination distribution, not
 * of all outputs (Wang et al., "LLM Hallucinations in Practical Code Generation",
 * https://arxiv.org/html/2409.20550v1). GPT-4o produced valid invocations for only 38.58% of low-frequency
 * API calls in CloudAPIBench (https://arxiv.org/abs/2407.09726). A study of 769 failed agent patches found
 * shallow code-context/architecture understanding in 47.74% of the analysed failures
 * (PAGENT, https://arxiv.org/html/2506.17772v1). None of those are rates of "edits whose anchor does not
 * exist" — nobody has measured that — but every one of them is the class of error this file catches.
 *
 * So each edit is checked against the file as it is now, with no model:
 *   - the path must exist and be inside the project;
 *   - if a line range is given, the file must have those lines;
 *   - if an anchor is given, its text must be in that file, at the cited lines when lines are cited
 *     (`anchored`), somewhere else in the file (`anchor-elsewhere`: the anchor is real, the line numbers
 *     are stale), more than once with no line range to disambiguate it (`anchor-ambiguous`), or nowhere
 *     (`anchor-not-found`: the edit cannot be applied as described);
 *   - with no anchor and no lines there is nothing to check but the path, and that is stated as
 *     `unanchored` rather than passed off as checked.
 *
 * It also answers the question the gate can answer better than the model: what a change there can break.
 * The answer comes from the index's own import graph, so it is arithmetic, not a guess — how many files
 * import this one, which of them are tests, and whether the anchor is declared in a *different* file,
 * which means this edit sits at a use site and a rename has to sweep the importers of the declaration.
 *
 * Two things this deliberately is not, and the dossier says both:
 *   - It does not apply the change. A real pre-apply gate builds the proposed result in memory and parses
 *     it (PAGENT parses the added Python with `ast` before analysing the patch); against a step written as
 *     prose there is nothing to apply, and inventing a diff format to satisfy the gate would be worse than
 *     saying so.
 *   - It says nothing about whether the change is right. It says the edit lands where it claims to land,
 *     which is the half that can be checked without reading the code or trusting a model.
 *
 * Line numbers are positions in a snapshot, not durable identities: a repo-wide rename or a single insert
 * at the top of the file moves every line under it. Each checked edit therefore carries the hash of the
 * file exactly as this check read it, so the applier can tell whether the lines above are still valid
 * before trusting them — the same idea as LSP's versioned document edits
 * (https://github.com/Microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md)
 * and `git apply --check`, which tests a patch against the working tree without writing it
 * (https://git-scm.com/docs/git-apply/2.18.0). A mismatch means re-check, never guess.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isTestPath } from "../codebase/scan.js";
import { findReferences, referenceSurface } from "../codebase/refs.js";
import { isCode } from "../codebase/symbols.js";
import { locate, nearestLine, normalise } from "./verify.js";
/** What each status means. Printed wherever a status is shown, like the citation statuses. */
export const EDIT_STATUS_MEANING = {
    anchored: "the file exists and the anchor (or the cited line range) is really there — as the file is now",
    unanchored: "only the path could be checked: the edit names no anchor and no line range, so nothing about where it lands is known",
    "anchor-elsewhere": "the anchor text is in the file, but not at the cited lines: the line numbers are stale, the edit itself may be real",
    "anchor-ambiguous": "the anchor text appears several times and no line range was cited, so which occurrence the edit means cannot be decided from the text",
    "anchor-not-found": "the anchor text is not in that file at all: the edit as described cannot be applied",
    "lines-out-of-range": "the cited line range starts past the end of the file as it is now",
    "no-such-file": "that path does not exist in the project (or is unreadable)",
    "outside-project": "that path is outside the project: refused, not read",
};
const emptyCounts = () => ({
    anchored: 0,
    unanchored: 0,
    "anchor-elsewhere": 0,
    "anchor-ambiguous": 0,
    "anchor-not-found": 0,
    "lines-out-of-range": 0,
    "no-such-file": 0,
    "outside-project": 0,
});
/** The statuses that mean the edit cannot be applied as written. */
const BROKEN = ["no-such-file", "outside-project", "anchor-not-found", "lines-out-of-range"];
/**
 * Every edit a mission produced: each worker's proposed steps, then the closing leader's ordered plan.
 * Steps that name no file are returned separately — there is nothing to check, and silently dropping them
 * would hide how much of the plan was never checkable at all.
 */
export function proposedEdits(input) {
    const edits = [];
    const pathless = [];
    for (const r of input.reports) {
        const unit = input.units.find((u) => u.id === r.unit);
        r.steps.forEach((s, i) => {
            if (!s.path.trim()) {
                pathless.push({ source: r.unit, intent: s.intent });
                return;
            }
            edits.push({ source: r.unit, sourceIndex: i, role: unit?.role, scope: unit?.scope, path: s.path, intent: s.intent, anchor: s.anchor, lines: s.lines, risk: s.risk });
        });
    }
    (input.synthesis?.plan ?? []).forEach((s, i) => {
        if (!s.path?.trim()) {
            pathless.push({ source: "plan", intent: s.intent });
            return;
        }
        edits.push({ source: "plan", sourceIndex: i, path: s.path, intent: s.step, anchor: s.anchor, lines: s.lines, risk: s.risk });
    });
    return { edits, pathless };
}
export async function verifyEdits(input) {
    const t0 = Date.now();
    const root = path.resolve(input.projectRoot);
    const files = input.cache ?? new Map();
    const byPath = new Map(input.index.files.map((f) => [f.path, f]));
    const known = [...byPath.keys()];
    const edits = [];
    const read = async (rel) => {
        if (files.has(rel))
            return files.get(rel);
        let text = null;
        try {
            text = await fs.readFile(path.join(root, rel), "utf8");
        }
        catch {
            text = null;
        }
        files.set(rel, text);
        return text;
    };
    for (const e of input.edits) {
        const rel = e.path.replace(/^\.\//, "").replace(/\\/g, "/").trim();
        const abs = path.resolve(root, rel);
        const out = { ...e, path: rel, status: "unanchored", flags: [] };
        if (!abs.startsWith(root + path.sep) && abs !== root) {
            out.status = "outside-project";
            out.detail = "refused: nothing outside the project is checked";
            push(out, edits);
            continue;
        }
        const text = await read(rel);
        if (text === null) {
            out.status = "no-such-file";
            const near = nearestPath(rel, known);
            out.detail = near ? `no such file (or unreadable); the closest path in the index is ${near}` : "no such file (or unreadable), and nothing in the index resembles it";
            push(out, edits);
            continue;
        }
        const lines = text.split("\n");
        out.fileLines = lines.length;
        out.bytes = Buffer.byteLength(text, "utf8");
        out.snapshot = crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
        out.impact = impactOf(input.index, rel, byPath.has(rel), e.anchor);
        const anchorIdent = e.anchor ? identOf(e.anchor) : null;
        if (out.impact.declaredIn && anchorIdent && input.callSites !== false) {
            // The same bounded surface the rename line names, but with the actual lines: "3 files import it" is a
            // warning, "formatMoney is used at checkout.ts:4 and cart.ts:3" is something a reader can check.
            const surface = referenceSurface(input.index, anchorIdent);
            const refs = await findReferences({ projectRoot: root, index: input.index, name: anchorIdent, only: surface.files, cache: files, maxPerFile: 8 });
            // Code only: a README that names the function is not a call site, and the impact line exists to be
            // acted on.
            const codeUses = refs.uses.filter((u) => !u.declaration && (u.lang === undefined || isCode(u.lang)));
            out.impact.callSites = codeUses.slice(0, 6);
            out.impact.callSiteCount = codeUses.length;
        }
        const anchor = e.anchor ? normalise(e.anchor) : "";
        const cited = e.lines ? `${e.lines[0]}-${e.lines[1]}` : "";
        if (!anchor && !e.lines) {
            out.status = "unanchored";
            out.detail = "no anchor and no line range: only the path could be checked, so where this edit lands is unknown to the server";
        }
        else if (e.lines && e.lines[0] > lines.length) {
            out.status = "lines-out-of-range";
            // The most useful thing to say here is where the anchor really is: the file changed under the edit,
            // and a re-check needs a line to look at rather than a lecture about staleness.
            const at = anchor && anchor.length >= 3 ? locate(text, anchor) : undefined;
            if (at)
                out.anchorAt = at;
            out.detail = `the file has ${lines.length} line(s) now; the cited range starts at ${e.lines[0]}${at ? `, and the anchor is really at line ${at}` : anchor ? ", and the anchor is not in the file either" : ""}`;
        }
        else if (!anchor) {
            // Lines are cited and they exist: that is as much as a line range alone can prove.
            out.status = "anchored";
            out.anchorAt = e.lines[0];
            out.detail = `no anchor text to match, but line ${cited} exists in the file as it is now`;
        }
        else if (anchor.length < 3) {
            out.status = "unanchored";
            out.detail = `the anchor "${out.anchor}" is too short to identify anything; quote a line or name a symbol`;
        }
        else if (e.lines) {
            const slice = lines.slice(Math.max(0, e.lines[0] - 1), Math.min(lines.length, e.lines[1]));
            const at = firstAnchorLine(lines, anchor, e.lines);
            if (normalise(slice.join("\n")).includes(anchor)) {
                out.status = "anchored";
                out.anchorAt = at ?? e.lines[0];
            }
            else if (normalise(text).includes(anchor)) {
                out.status = "anchor-elsewhere";
                out.anchorAt = locate(text, anchor) ?? at;
                out.detail = `the anchor is real but lives at line ${out.anchorAt}, not ${cited}`;
            }
            else {
                const near = nearestLine(text, anchor);
                out.status = "anchor-not-found";
                out.detail = near
                    ? `not at ${cited}; the closest line is ${near.line}: "${near.text}"`
                    : `not in that file at or near ${cited}, and nothing there resembles it`;
            }
        }
        else {
            const occurrences = normalise(text).split(anchor).length - 1;
            const at = firstAnchorLine(lines, anchor);
            out.occurrences = occurrences;
            out.anchorAt = at;
            if (occurrences === 0) {
                const near = nearestLine(text, anchor);
                out.status = "anchor-not-found";
                out.detail = near ? `not in that file; the closest line is ${near.line}: "${near.text}"` : "not in that file, and nothing there resembles it";
            }
            else if (occurrences > 1) {
                out.status = "anchor-ambiguous";
                out.detail = `the anchor occurs ${occurrences} times in this file (the first is line ${at}); with no line range the server cannot say which one this edit means, so it is not treated as placed`;
            }
            else {
                out.status = "anchored";
            }
        }
        if (e.scope?.length && !e.scope.includes(rel)) {
            out.flags.push(`outside the files ${e.source} owns (${e.scope.join(", ")}): another unit may own this file and this unit cannot see its work`);
        }
        if (out.impact.unindexed) {
            out.flags.push("this file has no entry in the index (skipped, or outside the configured roots), so nothing can be said about who imports it");
        }
        if (out.impact.importedBy >= 4 && (e.risk ?? "medium") === "low") {
            out.flags.push(`the risk is stated as low, but ${out.impact.importedBy} indexed file(s) import this one`);
        }
        if (out.impact.tests.length) {
            out.flags.push(`${out.impact.tests.length} test file(s) import this one: ${out.impact.tests.join(", ")}`);
        }
        push(out, edits);
    }
    const counts = emptyCounts();
    for (const e of edits)
        counts[e.status]++;
    return {
        edits,
        counts,
        broken: edits.filter((e) => BROKEN.includes(e.status)).length,
        unanchored: counts.unanchored + counts["anchor-ambiguous"],
        staleLines: counts["anchor-elsewhere"],
        notes: aggregate(edits),
        ms: Date.now() - t0,
    };
}
const push = (e, into) => into.push(e);
/**
 * What a change to this file can break, from the index's own import graph. Nothing here is inferred from
 * the intent's wording: it is the same edges the digest shows, so two runs cannot disagree about it.
 */
function impactOf(index, rel, indexed, anchor) {
    const importedBy = index.graph[rel]?.importedBy ?? [];
    const tests = importedBy.filter((p) => isTestPath(p));
    const out = { importedBy: importedBy.length, importers: importedBy.slice(0, 8), tests: tests.slice(0, 6), unindexed: !indexed };
    const ident = anchor ? identOf(anchor) : null;
    if (ident) {
        /* Filled in by the caller, which can afford the extra reads (see `callSites` in EditCheckInput). */
        // A declaration of this name in ANOTHER indexed file means the edit is at a use site. Useful, not a
        // defect: it is exactly what a rename has to sweep, and it is the cheapest way to see that the worker
        // is editing a caller rather than the definition it was asked about.
        const owners = index.files.filter((f) => f.path !== rel && f.symbols.some((s) => s.name === ident));
        const decl = owners
            .map((f) => ({ f, sym: f.symbols.find((s) => s.name === ident) }))
            .sort((a, b) => (index.graph[b.f.path]?.importedBy.length ?? 0) - (index.graph[a.f.path]?.importedBy.length ?? 0) || a.f.path.localeCompare(b.f.path))[0];
        if (decl) {
            out.declaredIn = { path: decl.f.path, line: decl.sym.line };
            const sweep = index.graph[decl.f.path]?.importedBy ?? [];
            if (sweep.length)
                out.renameSweep = sweep.slice(0, 8);
        }
    }
    return out;
}
/** The identifier an anchor names, when it names one at all. A quoted line of code names nothing. */
function identOf(anchor) {
    const m = normalise(anchor).match(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/);
    return m ? m[0].split(".")[0] : null;
}
/** The first line where the anchor's text appears, scanning line windows so a multi-line anchor is found. */
function firstAnchorLine(lines, anchor, within) {
    const from = within ? Math.max(0, within[0] - 1) : 0;
    const to = within ? Math.min(lines.length, within[1]) : lines.length;
    for (let i = from; i < to; i++) {
        if (normalise(lines[i]).includes(anchor))
            return i + 1;
        if (i + 3 < to && normalise(lines.slice(i, i + 4).join("\n")).includes(anchor))
            return i + 1;
    }
    return undefined;
}
/** A "did you mean" for a path that is not there, from the index alone. Deterministic, and it gives up fast. */
function nearestPath(rel, known) {
    const base = path.posix.basename(rel);
    const stem = base.replace(/\.[^.]+$/, "").toLowerCase();
    let best = null;
    for (const p of known) {
        const b = path.posix.basename(p);
        const bStem = b.replace(/\.[^.]+$/, "").toLowerCase();
        let score = 0;
        if (b === base)
            score += 6;
        else if (bStem === stem)
            score += 4;
        // Both directions, because the two ways to get a name wrong are dropping a letter and adding one:
        // "formatts" should find "format", and "leaky" should find "leaky" in a file spelled with another
        // extension. A four-character floor keeps this from answering with noise.
        else if (stem.length >= 4 && bStem.length >= 4 && (bStem.includes(stem) || stem.startsWith(bStem)))
            score += 3;
        if (path.posix.dirname(p) === path.posix.dirname(rel))
            score += 2;
        if (score > (best?.score ?? 0))
            best = { p, score };
    }
    return best && best.score >= 4 ? best.p : null;
}
/**
 * Hazards that only exist between edits: the same anchor proposed twice, two sources writing into
 * overlapping lines of one file, and which file in the set carries the most dependents.
 */
function aggregate(edits) {
    const notes = [];
    const byAnchor = new Map();
    for (const e of edits) {
        if (!e.anchor)
            continue;
        const k = `${e.path}|${normalise(e.anchor)}`;
        const hit = byAnchor.get(k) ?? { sources: new Set(), anchor: e.anchor };
        hit.sources.add(e.source);
        byAnchor.set(k, hit);
    }
    for (const [k, v] of byAnchor) {
        if (v.sources.size < 2)
            continue;
        notes.push(`${k.split("|")[0]}: ${[...v.sources].join(" and ")} both propose an edit at the same anchor ("${normalise(v.anchor).slice(0, 60)}") — either the same work twice or a conflict`);
    }
    const byFile = new Map();
    for (const e of edits)
        byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
    for (const [file, list] of byFile) {
        const ranged = list.filter((e) => e.lines);
        for (let i = 0; i < ranged.length; i++) {
            for (let j = i + 1; j < ranged.length; j++) {
                const a = ranged[i];
                const b = ranged[j];
                if (a.source === b.source)
                    continue;
                const lo = Math.max(a.lines[0], b.lines[0]);
                const hi = Math.min(a.lines[1], b.lines[1]);
                if (lo <= hi)
                    notes.push(`${file}: ${a.source} (lines ${a.lines[0]}-${a.lines[1]}) and ${b.source} (lines ${b.lines[0]}-${b.lines[1]}) propose edits that overlap at lines ${lo}-${hi}, and they cannot see each other's work`);
            }
        }
    }
    const ranked = edits.filter((e) => e.impact).sort((a, b) => (b.impact.importedBy - a.impact.importedBy) || a.path.localeCompare(b.path));
    const hot = ranked[0];
    if (hot && hot.impact.importedBy >= 3)
        notes.push(`the riskiest file in this set is ${hot.path}: ${hot.impact.importedBy} indexed file(s) import it, so a change there is felt beyond the file`);
    return notes;
}
const keyOf = (e) => `${e.source}|${e.sourceIndex}`;
/**
 * Fold the repair pass's answer into the mission's edit check.
 *
 * The same shape as `mergeVerification`: nothing is replaced or removed, the first attempt stays in the
 * record marked as superseded, and a re-placed step joins the list marked `repaired`, so a reader can always
 * see that the same source said it twice and only the second placement stood. The ended-state counts are
 * what the verdict uses — a step that was re-placed or given up by its own author is no longer an edit that
 * cannot be applied, and the replacement is judged exactly like any other step.
 */
export function mergeEditChecks(base, extra, settled) {
    const fixed = new Set(settled.fixed);
    const withdrew = new Set(settled.withdrawn);
    const edits = [
        ...base.edits.map((e) => (fixed.has(keyOf(e)) ? { ...e, superseded: "fixed" } : withdrew.has(keyOf(e)) ? { ...e, superseded: "withdrawn" } : e)),
        ...extra.edits.map((e) => ({ ...e, repaired: true })),
    ];
    const counts = emptyCounts();
    for (const e of edits)
        counts[e.status]++;
    const active = edits.filter((e) => e.repaired || (!fixed.has(keyOf(e)) && !withdrew.has(keyOf(e))));
    return {
        edits,
        counts,
        broken: active.filter((e) => BROKEN.includes(e.status)).length,
        unanchored: active.filter((e) => e.status === "unanchored" || e.status === "anchor-ambiguous").length,
        staleLines: active.filter((e) => e.status === "anchor-elsewhere").length,
        notes: [...base.notes, ...extra.notes],
        ms: base.ms + extra.ms,
    };
}
export function renderEditCheck(check, opts = {}) {
    const limit = opts.limit ?? 20;
    const lines = [];
    if (opts.heading !== false) {
        lines.push("## The edits, checked before anyone applies them", "The same gate as the citations, pointed at the work instead of the claims: every path must exist,", "every anchor must really be in that file at the lines it cites, and the file's own importers say what", "a change there can break. No model is involved, so this cannot be argued with — and it is not a review", "of the change: an edit that lands where it says it lands can still be wrong.", "");
    }
    if (!check.edits.length) {
        lines.push("- No edit was proposed by this run, so there was nothing to check.");
        return lines.join("\n");
    }
    const settled = check.edits.filter((e) => e.superseded);
    const rePlaced = settled.filter((e) => e.superseded === "fixed").length;
    const givenUp = settled.filter((e) => e.superseded === "withdrawn").length;
    lines.push(`- ${check.edits.length} edit(s) checked in ${check.ms} ms: ${Object.entries(check.counts)
        .filter(([, n]) => n)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ")}.`, `- ${check.broken} cannot be applied as described, ${check.staleLines} ${check.staleLines === 1 ? "has" : "have"} a real anchor with stale line numbers, ${check.unanchored} ${check.unanchored === 1 ? "is" : "are"} anchored to nothing.${settled.length
        ? ` That counts only what is still true at the end: ${[
            rePlaced ? `${rePlaced} of the steps above ${rePlaced === 1 ? "was" : "were"} re-placed by the repair pass` : "",
            givenUp ? `${givenUp} ${givenUp === 1 ? "was" : "were"} given up by their own author with a reason` : "",
        ]
            .filter(Boolean)
            .join(", and ")}; each is marked where it appears in this list.`
        : ""}`);
    for (const e of check.edits.slice(0, limit)) {
        const head = `### ${e.path || "(no path)"} — ${e.status}${e.source === "plan" ? " · from the closing plan" : ` · from ${e.source}${e.role ? ` (${e.role})` : ""}`}${e.superseded ? ` · superseded by the repair pass (${e.superseded})` : e.repaired ? " · came back from the repair pass" : ""}`;
        const where = e.anchor
            ? `anchor: "${normalise(e.anchor).slice(0, 120)}"${e.lines ? `, cited at ${e.lines[0]}-${e.lines[1]}` : ""}${e.anchorAt ? `, really at line ${e.anchorAt}` : ""}${e.occurrences ? `, occurs ${e.occurrences}×` : ""}`
            : e.lines
                ? `no anchor, cited at ${e.lines[0]}-${e.lines[1]}`
                : "no anchor, no line range";
        const impact = e.impact
            ? `impact: ${e.impact.importedBy} indexed file(s) import this one${e.impact.importers.length ? ` (${e.impact.importers.slice(0, 5).join(", ")}${e.impact.importedBy > 5 ? ", ..." : ""})` : ""}${e.impact.tests.length ? `; ${e.impact.tests.length} of them are tests` : ""}${e.impact.declaredIn ? `; the anchor \`${identOf(e.anchor ?? "") ?? "?"}\` is declared in ${e.impact.declaredIn.path}:${e.impact.declaredIn.line}, so this edit sits at a use site${e.impact.renameSweep?.length ? ` and a rename would have to sweep ${e.impact.renameSweep.length} importer(s): ${e.impact.renameSweep.slice(0, 5).join(", ")}` : ""}` : ""}.`
            : "impact: unknown";
        const callSites = e.impact?.callSites?.length
            ? ` where it is used: ${e.impact.callSites.map((c) => `${c.path}:${c.line}`).join(", ")}${(e.impact.callSiteCount ?? 0) > e.impact.callSites.length ? ` (${e.impact.callSiteCount} use(s) on the rename surface, first ${e.impact.callSites.length} named)` : ""}`
            : "";
        lines.push(...[head, `intent: ${e.intent.replace(/\s+/g, " ").slice(0, 240)}`, where, `${impact}${callSites}`, e.detail ? `what the server found: ${e.detail}` : "", e.snapshot ? `snapshot: ${e.path} was ${e.fileLines} line(s), ${e.bytes} bytes, sha256 ${e.snapshot} when this was checked.` : "", ...e.flags.map((f) => `flag: ${f}`)].filter(Boolean));
    }
    if (check.edits.length > limit)
        lines.push(`... and ${check.edits.length - limit} more edit(s), listed in the job result.`);
    if (check.notes.length)
        lines.push("", "Between the edits:", ...check.notes.map((n) => `- ${n}`));
    lines.push("", "What this checks, and what it does not: the path exists, the anchor is really in the file at the cited", "lines, the file has not been reformatted out from under the line numbers, and the index says who imports", "it. It does not apply the change, it does not parse the result, and it does not judge whether the change", "is right. The line numbers belong to the snapshot hash above: if that file hashes differently when you", "apply the edit, the numbers are stale, and the honest move is to re-check rather than to guess.");
    return lines.join("\n");
}
