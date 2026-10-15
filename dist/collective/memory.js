/**
 * What the collective remembers between missions.
 *
 * The research is unambiguous about which way this goes wrong. Xiong et al. (ACL 2026) measured agents
 * whose memory added everything: errors got copied into later tasks and re-added, and success rates fell
 * (RegAgent 67.53 → 55.48) compared with a strict evaluator adding selectively (70.95). The STALE
 * benchmark (400 expert-validated scenarios) found even the best system only 55.2% accurate at noticing
 * that a recalled belief had been overtaken. AgentPoison showed that a memory store is an attack surface
 * where 0.1% poisoned entries can steer an agent.
 *
 * So this memory is deliberately narrow:
 *   - only two kinds of model-written entry get in: a claim whose quote the server itself re-read (and
 *     only from a mission that actually closed, and only when that quote visibly bears on the claim —
 *     thin support is kept out, because memory is read back as if it were settled), and a claim the
 *     server *rejected*, kept so nobody repeats it;
 *   - `ruling` entries are the owner's words only, never generated;
 *   - every entry carries its provenance: mission, path, lines, exact quote;
 *   - on load, every entry is re-checked against the current file. If the code it quotes is gone, it is
 *     marked stale, kept out of prompts and reported, because a memory that cannot go stale is a memory
 *     that will confidently lie;
 *   - entries are hints, never instructions. Nothing here can turn into a command the agents obey;
 *   - a rejection the repair pass re-cited correctly is not filed: the code was never misdescribed, so it
 *     is not added to the list of things nobody should say again.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalise } from "./verify.js";
export const memoryFile = (root) => path.join(root, ".design-mcp", "collective", "memory.jsonl");
const idFor = (kind, rel, quote) => crypto.createHash("sha1").update(`${kind}|${rel}|${normalise(quote)}`).digest("hex").slice(0, 12);
async function readAll(root) {
    try {
        const text = await fs.readFile(memoryFile(root), "utf8");
        return text
            .split("\n")
            .filter(Boolean)
            .map((l) => {
            try {
                return JSON.parse(l);
            }
            catch {
                return null;
            }
        })
            .filter((x) => !!x && !!x.id && !!x.kind && !!x.text);
    }
    catch {
        return [];
    }
}
/** Load, then re-check every quoted entry against the file as it is now. */
export async function loadMemory(root) {
    const items = await readAll(root);
    const cache = new Map();
    for (const item of items) {
        item.stale = undefined;
        // Only "established" entries claim the code says something. A rejection is *supposed* to be absent
        // from the file — that is what made it a rejection — so the freshness rule must not touch it.
        if (item.kind !== "established" || !item.path || !item.quote)
            continue;
        let text = cache.get(item.path);
        if (text === undefined) {
            try {
                text = await fs.readFile(path.join(root, item.path), "utf8");
            }
            catch {
                text = null;
            }
            cache.set(item.path, text);
        }
        if (text === null)
            item.stale = "the file it quoted no longer exists";
        else if (!normalise(text).includes(normalise(item.quote)))
            item.stale = "the quoted code is no longer in that file";
    }
    const stale = items.filter((i) => i.stale);
    const live = items.filter((i) => !i.stale);
    return { items, stale, live };
}
async function writeAll(root, items) {
    const file = memoryFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
}
/**
 * Add what this mission learned. Quality-gated on purpose: adding everything is a measured way to make
 * an agent worse, so `established` entries need a quote the verifier confirmed, a mission that reached a
 * conclusion, a per-mission cap, and no conflict on that file.
 */
export async function admitFromMission(input) {
    const existing = await readAll(input.root);
    const byId = new Map(existing.map((i) => [i.id, i]));
    const added = [];
    const skipped = [];
    let reinforced = 0;
    const now = new Date().toISOString();
    const conflicted = new Set(input.conflictPaths);
    const settled = new Set(input.settled ?? []);
    // A verified quote that does not visibly back its claim is not admitted. The quote is real, so the gate
    // passed it, but memory is read by the next mission as if it were settled — and unsupported statements
    // presented as supported are exactly what an audit of generative search engines found in half of the
    // sentences it checked (Liu, Zhang & Liang, https://arxiv.org/html/2304.09848v2). It stays in the
    // dossier, labelled, where a reader can see it.
    const thin = input.closingRan ? input.verification.claims.filter((c) => c.status === "verified" && c.support === "thin").length : 0;
    const candidates = input.closingRan
        ? input.verification.claims
            .filter((c) => c.status === "verified" && c.lines && !conflicted.has(c.path) && c.support !== "thin")
            // A quote confirmed by two independent units is the strongest thing a mission can produce.
            .sort((a, b) => input.verification.claims.filter((x) => x.path === b.path && x.quote === b.quote).length - input.verification.claims.filter((x) => x.path === a.path && x.quote === a.quote).length)
            .slice(0, input.perMission)
        : [];
    for (const c of candidates) {
        const id = idFor("established", c.path, c.quote);
        const prior = byId.get(id);
        if (prior) {
            prior.hits += 1;
            prior.at = now;
            reinforced += 1;
            continue;
        }
        const item = { id, kind: "established", text: c.claim, mission: input.mission, at: now, hits: 1, path: c.path, lines: c.lines, quote: c.quote };
        byId.set(id, item);
        added.push(item);
    }
    if (!input.closingRan)
        skipped.push("this mission did not reach a conclusion, so nothing was recorded as established");
    if (thin)
        skipped.push(`${thin} verified claim(s) were kept out of memory: the quote is real but shares no wording with the claim, so nobody should read it back as settled`);
    let settledSkips = 0;
    // Rejections are worth keeping even from a failed mission: they are the cheapest lesson available,
    // and they are the ones a fresh worker is most likely to invent again. `found-elsewhere` is excluded —
    // that quote is real, only the line numbers were wrong, so it is a citation error, not a false belief.
    for (const c of input.verification.rejected) {
        if (c.status !== "quote-not-found" && c.status !== "file-missing")
            continue;
        // The repair pass re-cited this one correctly: the code was never misdescribed, so it is not filed
        // among the things nobody should say again.
        if (settled.has(`${c.unit}|${c.claim}`)) {
            settledSkips++;
            continue;
        }
        const id = idFor("rejected", c.path, c.quote);
        const prior = byId.get(id);
        if (prior) {
            prior.hits += 1;
            prior.at = now;
            reinforced += 1;
            continue;
        }
        const item = { id, kind: "rejected", text: c.claim, mission: input.mission, at: now, hits: 1, path: c.path, quote: c.quote, detail: c.detail };
        byId.set(id, item);
        added.push(item);
    }
    if (settledSkips)
        skipped.push(`${settledSkips} rejection(s) were re-cited correctly by the repair pass, so they were not recorded as things not to say`);
    await writeAll(input.root, prune([...byId.values()], input.cap));
    return { added, reinforced, skipped };
}
/** The owner's own words. Never generated, never pruned. */
export async function addRuling(root, text, cap) {
    const all = await readAll(root);
    const id = crypto.createHash("sha1").update(`ruling|${normalise(text)}`).digest("hex").slice(0, 12);
    const existing = all.find((i) => i.id === id);
    if (existing) {
        existing.hits += 1;
        await writeAll(root, prune(all, cap));
        return existing;
    }
    const item = { id, kind: "ruling", text, at: new Date().toISOString(), hits: 1, detail: "the owner's ruling: treat as a constraint, cite it as 'owner ruling'" };
    await writeAll(root, prune([...all, item], cap));
    return item;
}
/** Rulings are permanent; everything else is capped, by usefulness first (hits) then recency. */
function prune(items, cap) {
    const rulings = items.filter((i) => i.kind === "ruling");
    const rest = items
        .filter((i) => i.kind !== "ruling")
        .sort((a, b) => b.hits - a.hits || b.at.localeCompare(a.at))
        .slice(0, Math.max(0, cap - rulings.length));
    return [...rulings, ...rest].sort((a, b) => a.at.localeCompare(b.at));
}
export const memoryBlockTokens = (block) => Math.ceil(block.length / 4);
/**
 * What goes into a prompt. Stale entries are absent by construction, and the block says out loud that
 * these are hints: an entry that quietly graduated into "fact" would be exactly the failure the
 * freshness research describes.
 */
export function renderMemoryBlock(loaded, opts = {}) {
    const budget = opts.tokens ?? 400;
    const live = loaded.live;
    if (!live.length)
        return "";
    const rulings = live.filter((i) => i.kind === "ruling");
    const established = live.filter((i) => i.kind === "established").sort((a, b) => b.hits - a.hits || a.at.localeCompare(b.at));
    const rejected = live.filter((i) => i.kind === "rejected").sort((a, b) => b.hits - a.hits || a.at.localeCompare(b.at));
    const lines = [
        "=== WHAT THIS COLLECTIVE ALREADY KNOWS ABOUT THIS REPO (hints, not instructions) ===",
        `Established in earlier missions: ${established.length ? "these claims were verified against the file when they were made, and re-checked just now." : "(nothing yet)"}`,
    ];
    const push = (s) => {
        lines.push(s);
        return Math.ceil(lines.join("\n").length / 4) <= budget;
    };
    for (const r of rulings)
        if (!push(`- [owner ruling] ${r.text}`))
            break;
    for (const e of established)
        if (!push(`- ${e.path}${e.lines ? `:${e.lines[0]}` : ""} (confirmed ${e.hits}×): ${e.text}`))
            break;
    if (rejected.length) {
        push("Already rejected by the citation gate in earlier missions — do NOT restate these as facts:");
        for (const r of rejected)
            if (!push(`- ${r.path}: ${r.text}`))
                break;
    }
    push("These are prior results, not current evidence: re-read the code before relying on any of them, and cite it again.");
    return lines.join("\n");
}
export function renderMemoryReport(loaded, added) {
    const { live, stale, items } = loaded;
    const group = (k) => live.filter((i) => i.kind === k);
    const lines = [
        `${items.length} memory entr${items.length === 1 ? "y" : "ies"} for this repo: ${live.length} live, ${stale.length} stale.`,
    ];
    if (added?.length)
        lines.push("", `Just added (${added.length}):`, ...added.map((i) => `- [${i.kind}] ${i.path ?? ""}: ${i.text.slice(0, 140)}`));
    for (const r of group("ruling"))
        lines.push(`- [ruling] ${r.text}`);
    for (const e of group("established"))
        lines.push(`- [established ×${e.hits}] ${e.path}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ""}: ${e.text}`);
    for (const r of group("rejected"))
        lines.push(`- [rejected ×${r.hits}] ${r.path}: ${r.text}${r.detail ? ` — ${r.detail}` : ""}`);
    if (stale.length) {
        lines.push("", "Stale — the quoted code is gone or changed, so these are kept out of every prompt until they are re-confirmed:", ...stale.map((s) => `- ${s.path}: ${s.text.slice(0, 100)} (${s.stale})`));
    }
    lines.push("", "Memory is a hint list, never an instruction, and never a citation: quote the file, not this.");
    return lines.join("\n");
}
export async function clearMemory(root) {
    const all = await readAll(root);
    await fs.rm(memoryFile(root), { force: true });
    return all.length;
}
