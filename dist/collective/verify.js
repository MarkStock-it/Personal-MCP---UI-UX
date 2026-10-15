/**
 * The gate between what the collective says and what is true.
 *
 * Every finding a worker reports is re-read from disk here. The quote must be present at the cited
 * lines; whitespace is normalised away, nothing else is. A claim that fails is not "downgraded" — it is
 * marked rejected and removed from what the leader is allowed to build on, because a team that can
 * propagate an invented fact is worse than a single model that invents one.
 *
 * This runs with no model, so it cannot be talked out of its answer.
 */
import fs from "node:fs/promises";
import path from "node:path";
export const STATUS_MEANING = {
    verified: "the quote is in the file at the cited lines",
    "found-elsewhere": "the quote is in the file, but not at the cited lines: the line numbers were wrong",
    "quote-not-found": "the quote is not in that file at all: the claim is unverified",
    "file-missing": "that path does not exist in the project",
    "outside-project": "that path is outside the project: refused, not read",
};
/** Whitespace-insensitive, otherwise exact. Line-number gutters are stripped so a quote of a quote still matches. */
export function normalise(text) {
    return text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => l.replace(/^\s*\d+\s*\|/, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}
const head = (s, n = 48) => normalise(s).slice(0, n);
export async function verifyReports(input) {
    const t0 = Date.now();
    const root = path.resolve(input.projectRoot);
    const files = input.cache ?? new Map();
    const counts = { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 };
    const claims = [];
    const rejected = [];
    const unparsed = [];
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
    for (const report of input.reports) {
        const unit = input.units.find((u) => u.id === report.unit);
        const role = unit?.role ?? "explorer";
        if (!unit)
            unparsed.push({ unit: report.unit, error: "the report names a unit that is not in the plan" });
        for (const f of report.findings) {
            const rel = f.path.replace(/^\.\//, "").replace(/\\/g, "/");
            const abs = path.resolve(root, rel);
            const claim = { unit: report.unit, role, claim: f.claim, path: rel, lines: f.lines, quote: f.quote, confidence: f.confidence, status: "quote-not-found" };
            if (!abs.startsWith(root + path.sep) && abs !== root) {
                claim.status = "outside-project";
                claim.detail = "refused: nothing outside the project is read";
            }
            else if (normalise(f.quote).length < 8) {
                claim.status = "quote-not-found";
                claim.detail = "the quote is too short to prove anything (under 8 characters after normalising)";
            }
            else {
                const text = await read(rel);
                if (text === null) {
                    claim.status = "file-missing";
                    claim.detail = "no such file (or unreadable)";
                }
                else {
                    const normFile = normalise(text);
                    const q = normalise(f.quote);
                    if (f.lines) {
                        const slice = text.split("\n").slice(Math.max(0, f.lines[0] - 1), f.lines[1]);
                        if (normalise(slice.join("\n")).includes(q)) {
                            claim.status = "verified";
                            claim.foundAt = f.lines[0];
                        }
                        else if (normFile.includes(q)) {
                            claim.status = "found-elsewhere";
                            claim.foundAt = locate(text, q);
                            claim.detail = `the quote is real but lives near line ${claim.foundAt}, not ${f.lines[0]}-${f.lines[1]}`;
                        }
                    }
                    else if (normFile.includes(q)) {
                        claim.status = "found-elsewhere";
                        claim.foundAt = locate(text, q);
                        claim.detail = `no line range was cited; the quote is near line ${claim.foundAt}`;
                    }
                    else {
                        // Last tolerance: a quote that merely edits the punctuation of a real line is still rejected,
                        // but we say which line it resembles so the worker can repair it instead of guessing again.
                        const near = nearestLine(text, q);
                        claim.detail = near ? `not found; closest line is ${near.line}: "${near.text}"` : "not found in that file, and nothing there resembles it";
                    }
                }
            }
            counts[claim.status]++;
            claims.push(claim);
            if (claim.status !== "verified")
                rejected.push(claim);
        }
    }
    const units = input.reports.map((r) => {
        const mine = claims.filter((c) => c.unit === r.unit);
        const ok = mine.filter((c) => c.status === "verified").length;
        return {
            unit: r.unit,
            role: input.units.find((u) => u.id === r.unit)?.role ?? "explorer",
            verdict: r.verdict,
            answered: r.answer.trim().length > 0,
            verified: ok,
            rejected: mine.length - ok,
            total: mine.length,
            unknowns: r.unknowns.length,
            answer: r.answer,
        };
    });
    return { claims, rejected, units, conflicts: conflictsIn(input.units, input.reports), counts, unparsed, ms: Date.now() - t0 };
}
/** Approximate line where a normalised quote sits, by matching its first words against each line. */
function locate(text, q) {
    const lines = text.split("\n");
    const needle = head(q, 40);
    if (!needle)
        return undefined;
    for (let i = 0; i < lines.length; i++) {
        if (normalise(lines[i]).includes(needle))
            return i + 1;
    }
    for (let i = 0; i < lines.length - 2; i++) {
        if (normalise(lines.slice(i, i + 3).join("\n")).includes(needle))
            return i + 1;
    }
    return undefined;
}
function nearestLine(text, q) {
    const words = new Set(q.split(" ").filter((w) => w.length > 3));
    if (!words.size)
        return null;
    const scored = [];
    text.split("\n").forEach((l, i) => {
        const n = normalise(l);
        if (n.length < 8)
            return;
        let score = 0;
        for (const w of words)
            if (n.includes(w))
                score++;
        if (score)
            scored.push({ line: i + 1, text: l.trim().slice(0, 120), score });
    });
    const best = scored.sort((a, b) => b.score - a.score || a.line - b.line)[0];
    return best && best.score >= 2 ? { line: best.line, text: best.text } : null;
}
/** Two units that write to the same file cannot see each other. Catch it before the work is merged. */
export function conflictsIn(units, reports) {
    const owners = new Map();
    const writers = new Set(["implementer", "architect"]);
    for (const u of units) {
        if (!writers.has(u.role))
            continue;
        for (const p of u.scope) {
            const set = owners.get(p) ?? new Set();
            set.add(u.id);
            owners.set(p, set);
        }
    }
    for (const r of reports) {
        if (!writers.has(units.find((u) => u.id === r.unit)?.role ?? ""))
            continue;
        for (const s of r.steps) {
            const set = owners.get(s.path) ?? new Set();
            set.add(r.unit);
            owners.set(s.path, set);
        }
    }
    return [...owners.entries()]
        .filter(([, ids]) => ids.size > 1)
        .map(([p, ids]) => `${p} is claimed by ${[...ids].join(" and ")} — those units cannot see each other's work; merge them or hand the file to one of them`)
        .sort();
}
/** The same gate, for claims the host's own assistant wants checked before it answers. */
export async function verifyCallerClaims(projectRoot, claims) {
    const units = [{ id: "caller", role: "explorer", objective: "claims supplied by the caller, checked against the files", scope: [], mustAnswer: ["is every quote where it says it is?"], doneWhen: [] }];
    const reports = [
        {
            unit: "caller",
            answer: `${claims.length} caller-supplied claim(s)`,
            findings: claims.map((c) => ({
                claim: c.claim ?? c.quote.replace(/\s+/g, " ").slice(0, 80),
                path: c.path,
                lines: c.lines,
                quote: c.quote,
                confidence: c.confidence ?? "medium",
            })),
            steps: [],
            unknowns: [],
            openQuestions: [],
            verdict: "ok",
        },
    ];
    return verifyReports({ projectRoot, units, reports });
}
export function renderVerification(v, opts = {}) {
    const total = v.claims.length;
    const order = ["verified", "found-elsewhere", "quote-not-found", "file-missing", "outside-project"];
    const lines = [
        `${total} claim(s) checked against the files in ${v.ms} ms: ${order.map((s) => `${v.counts[s]} ${s}`).filter((s) => !s.startsWith("0 ")).join(", ") || "none"}.`,
        ...(v.unparsed.length ? [`${v.unparsed.length} worker report(s) could not be used: ${v.unparsed.map((u) => `${u.unit} (${u.error})`).join("; ")}`] : []),
        "",
        "Per unit:",
        ...v.units.map((u) => `  ${u.unit} (${u.role}): ${u.verified}/${u.total} claims verified, verdict ${u.verdict}, ${u.unknowns} unknown(s) admitted — ${u.answer.replace(/\s+/g, " ").slice(0, 160)}`),
    ];
    if (v.rejected.length) {
        lines.push("", "REJECTED (do not build on these):");
        for (const c of v.rejected.slice(0, opts.limit ?? 20)) {
            lines.push(`  - [${c.status}] ${c.unit} ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim.replace(/\s+/g, " ").slice(0, 140)}`);
            if (c.detail)
                lines.push(`      ${c.detail}`);
            if (opts.quotes)
                lines.push(`      quoted: "${c.quote.replace(/\s+/g, " ").slice(0, 120)}"`);
        }
        if (v.rejected.length > (opts.limit ?? 20))
            lines.push(`  ... and ${v.rejected.length - (opts.limit ?? 20)} more`);
    }
    if (v.conflicts.length)
        lines.push("", "CONFLICTS:", ...v.conflicts.map((c) => `  - ${c}`));
    return lines.join("\n");
}
