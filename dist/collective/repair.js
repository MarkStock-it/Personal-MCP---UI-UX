import { packContext, renderPack } from "../codebase/pack.js";
import { pLimit } from "../util/limit.js";
import { askJson } from "./ask.js";
import { RepairSchema, repairSystem, repairUser } from "./roles.js";
import { normalise, verifyReports } from "./verify.js";
/** The statuses a worker can actually do something about: the quote is real, or the citation is wrong. */
const REPAIRABLE = ["quote-not-found", "found-elsewhere"];
/** How many rejected findings one unit is handed back in a single pass. */
const MAX_REPAIRS_PER_UNIT = 8;
export const repairableRejections = (v) => v.rejected.filter((c) => REPAIRABLE.includes(c.status));
const emptyVerification = () => ({
    claims: [],
    rejected: [],
    units: [],
    conflicts: [],
    counts: { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 },
    thin: [],
    supportCounts: { overlap: 0, thin: 0, unchecked: 0 },
    unparsed: [],
    ms: 0,
});
export async function runRepairRound(input) {
    const t0 = Date.now();
    const attempts = [];
    /** The claims this pass produced, per unit, kept beside the attempt records rather than inside them. */
    const produced = new Map();
    const limit = pLimit(Math.max(1, input.concurrency));
    const byUnit = new Map();
    for (const c of repairableRejections(input.verification)) {
        byUnit.set(c.unit, [...(byUnit.get(c.unit) ?? []), c]);
    }
    await Promise.all([...byUnit.entries()].map(([unitId, claims]) => limit(async () => {
        const unit = input.units.find((u) => u.id === unitId);
        if (!unit)
            return;
        const sent = claims.slice(0, MAX_REPAIRS_PER_UNIT);
        const started = Date.now();
        try {
            const pack = await packContext(input.projectRoot, input.index, {
                query: [unit.objective, ...unit.mustAnswer].join(" "),
                paths: unit.scope,
                budget: input.cfg.contextTokensPerWorker,
                symbols: [],
            });
            const asked = await askJson({
                role: "worker",
                system: repairSystem(unit.role, input.assigned?.get(unit.id)),
                user: repairUser(unit, renderPack(pack), sent, input.memoryBlock),
                schema: RepairSchema,
                maxTokens: 1800,
                attempts: 2,
            });
            const findings = asked.value.findings.map((f) => ({ ...f, unit: unitId }));
            const checked = findings.length
                ? await verifyReports({
                    projectRoot: input.projectRoot,
                    units: input.units,
                    reports: [{ unit: unitId, answer: asked.value.note || "repair pass", findings, steps: [], unknowns: [], openQuestions: [], verdict: "ok" }],
                })
                : emptyVerification();
            // Which of the sent findings were actually addressed. A claim that comes back with the same text is
            // a re-citation; a verified finding with different text was offered in its place, which is honest but
            // is not the same claim fixed. Both are counted, separately, because the reader can tell them apart.
            const sentTexts = new Set(sent.map((c) => normalise(c.claim)));
            const recited = checked.claims.filter((c) => c.status === "verified" && sentTexts.has(normalise(c.claim))).length;
            const replaced = checked.claims.filter((c) => c.status === "verified" && !sentTexts.has(normalise(c.claim))).length;
            const withdrawn = asked.value.dropped.map((d) => ({ claim: d.claim, why: d.why }));
            const addressed = withdrawn.filter((w) => sentTexts.has(normalise(w.claim))).length;
            produced.set(unitId, checked.claims);
            attempts.push({
                unit: unitId,
                role: unit.role,
                sent: sent.length,
                recited,
                replaced,
                withdrawn,
                unaddressed: Math.max(0, sent.length - recited - addressed),
                note: asked.value.note,
                ms: Date.now() - started,
            });
            input.log(`  ${unitId}: repair pass — ${recited} of ${sent.length} re-cited under the same claim, ${replaced} replaced by a different finding${withdrawn.length ? `, ${withdrawn.length} withdrawn` : ""}`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            attempts.push({ unit: unitId, role: unit.role, sent: sent.length, recited: 0, replaced: 0, withdrawn: [], unaddressed: sent.length, note: "", error: message, ms: Date.now() - started });
            input.log(`  ${unitId}: repair pass failed (${message.split("\n").slice(0, 2).join(" ")})`);
        }
    })));
    const claims = [...produced.values()].flat();
    const counts = { verified: 0, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 };
    for (const c of claims)
        counts[c.status]++;
    const verification = { ...emptyVerification(), claims, counts };
    return {
        attempts: attempts.sort((a, b) => a.unit.localeCompare(b.unit)),
        verification,
        calls: attempts.length,
        repaired: counts.verified,
        stillRejected: claims.length - counts.verified,
        ms: Date.now() - t0,
    };
}
