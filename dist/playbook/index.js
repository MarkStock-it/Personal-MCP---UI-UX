import { COLOR_TOPIC } from "./color.js";
import { FLOOR_TOPIC } from "./floor.js";
import { LAYOUT_TOPIC } from "./layout.js";
import { MOTION_TOPIC } from "./motion.js";
import { ORGANIC_TOPIC } from "./organic.js";
import { RUBRIC_TOPIC } from "./rubric.js";
import { SLOP_TOPIC } from "./slop.js";
import { TYPE_TOPIC } from "./typography.js";
/** Ordered so the index reads the way a design gets built: motion -> material -> type -> colour -> structure -> floor. */
export const TOPICS = [
    MOTION_TOPIC,
    ORGANIC_TOPIC,
    TYPE_TOPIC,
    COLOR_TOPIC,
    LAYOUT_TOPIC,
    FLOOR_TOPIC,
    RUBRIC_TOPIC,
    SLOP_TOPIC,
];
export const TOPIC_IDS = TOPICS.map((t) => t.id);
export const findTopic = (id) => TOPICS.find((t) => t.id === id.toLowerCase());
export const findEntry = (entryId) => {
    const q = entryId.toLowerCase();
    for (const topic of TOPICS) {
        const entry = topic.entries.find((e) => e.id === q);
        if (entry)
            return { topic, entry };
    }
    return undefined;
};
/** Resource URI for a topic, e.g. design://playbook/motion. Kept in one place so hosts can rely on it. */
export const resourceUri = (topicId) => `design://playbook/${topicId.toLowerCase()}`;
const haystack = (e) => [e.id, e.name, e.intent, e.why, ...e.do, ...(e.avoid ?? []), e.pattern ?? "", ...Object.keys(e.params ?? {})]
    .join(" ")
    .toLowerCase();
/**
 * Loose text search across the playbook. Every whitespace-separated term must appear,
 * so "soft palette contrast" narrows instead of widening. Terms are also matched against
 * the topic id and title, so "motion" returns the whole motion topic.
 */
export function searchPlaybook(query, topicId) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = topicId ? [findTopic(topicId)].filter(Boolean) : TOPICS;
    const out = [];
    for (const topic of pool) {
        for (const entry of topic.entries) {
            const hay = `${topic.id} ${topic.title} ${haystack(entry)}`;
            if (terms.every((t) => hay.includes(t)))
                out.push({ topic, entry });
        }
    }
    // Prefer entries that match fewer, more specific terms up front: exact id hit, then name hit.
    const q = query.trim().toLowerCase();
    return out.sort((a, b) => rank(b.entry, q) - rank(a.entry, q));
}
const rank = (e, q) => (e.id === q ? 100 : 0) + (e.name.toLowerCase() === q ? 50 : 0) + (e.id.includes(q) ? 10 : 0) + (e.do.length ? 1 : 0);
const sourceLine = (s) => `    - ${s.title} — ${s.url} [${s.license}]${s.adapted ? ` — ADAPTED: ${s.change ?? "unspecified"}` : s.change ? ` — ${s.change}` : ""}`;
export function renderEntry(e) {
    const lines = [`### ${e.name}  (id: ${e.id})`, `When: ${e.intent}`, `Why it works: ${e.why}`, "", "Do:"];
    lines.push(...e.do.map((d) => `  - ${d}`));
    if (e.avoid?.length)
        lines.push("", "Pitfalls:", ...e.avoid.map((a) => `  - ${a}`));
    if (e.params && Object.keys(e.params).length)
        lines.push("", `Tune: ${Object.entries(e.params).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (e.pattern)
        lines.push("", "Pattern:", ...e.pattern.split("\n").map((l) => `  ${l}`));
    if (e.verify)
        lines.push("", `Verify: ${e.verify}`);
    lines.push("", "Sources:", ...e.sources.map(sourceLine));
    return lines.join("\n");
}
export function renderTopic(topic, query) {
    const entries = query ? searchPlaybook(query, topic.id).map((h) => h.entry) : topic.entries;
    if (!entries.length) {
        return `Topic "${topic.id}" has nothing matching "${query}". Entries here: ${topic.entries.map((e) => e.id).join(", ")}.`;
    }
    return [
        `# ${topic.title} (${topic.id})${query ? ` — matching "${query}"` : ""}`,
        topic.summary,
        "",
        ...entries.map(renderEntry),
    ].join("\n");
}
/** The catalogue: what a future design agent can ask for. */
export function topicIndex() {
    return [
        `Design playbook — ${TOPICS.length} topics, ${TOPICS.reduce((n, t) => n + t.entries.length, 0)} entries (offline, no keys).`,
        "",
        ...TOPICS.map((t) => [
            `## ${t.id} — ${t.title}`,
            t.summary,
            ...t.entries.map((e) => `  - ${e.id}: ${e.name} — ${e.intent}`),
            "",
        ].join("\n")),
        "Read one topic with design_playbook { topic }, search it with design_playbook { query }, or attach it as the resource design://playbook/<topic>.",
    ].join("\n");
}
