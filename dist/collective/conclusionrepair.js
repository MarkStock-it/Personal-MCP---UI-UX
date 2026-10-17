import { askJson } from "./ask.js";
import { applyConclusionFixes, checkConclusion } from "./conclusion.js";
import { ConclusionRepairSchema, conclusionRepairSystem, conclusionRepairUser } from "./roles.js";
/** How many files the leader is shown, so "a file that is not in it" is a rule it can actually obey. */
const MAX_FILE_LIST = 400;
export async function runConclusionRepairRound(input) {
    const t0 = Date.now();
    const files = input.index.files.map((f) => f.path).sort();
    const shown = files.slice(0, MAX_FILE_LIST);
    const attempted = { sent: input.issues.length, rewritten: 0, withdrawn: [], unaddressed: input.issues.length, stillBroken: 0, note: "", ms: 0 };
    let synthesis = input.synthesis;
    let fixes = [];
    const started = Date.now();
    try {
        const asked = await askJson({
            role: "leader",
            system: conclusionRepairSystem(),
            user: conclusionRepairUser({
                mission: input.mission,
                issues: input.issues.map((i) => ({ index: i.index, kind: i.kind, field: i.field, text: i.text, because: i.because })),
                files: shown,
                fileCount: files.length,
                rejected: input.verification.rejected.map((c) => `[${c.status}] ${c.unit} ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim}${c.detail ? ` — ${c.detail}` : ""}`),
                memory: input.memoryBlock,
            }),
            schema: ConclusionRepairSchema,
            maxTokens: 1600,
            attempts: 2,
        });
        fixes = [
            ...asked.value.fixed.map((f) => ({ fixes: f.fixes, text: f.text })),
            ...asked.value.dropped.map((d) => ({ fixes: d.fixes, why: d.why })),
        ];
        attempted.note = asked.value.note;
        attempted.ms = Date.now() - started;
        synthesis = applyConclusionFixes(input.synthesis, input.issues, fixes);
        // Re-check the whole paragraph, not just the answered sentences: a rewrite can introduce a new
        // contradiction in place of the old one, and finding that is the point of gating the answer again.
        const remaining = await checkConclusion({
            synthesis,
            verification: input.verification,
            index: input.index,
            root: input.projectRoot,
            exists: new Map(),
        });
        const stillFlagged = new Set(remaining.map((r) => r.text.replace(/\s+/g, " ").trim()));
        const byNumber = new Map(input.issues.map((i) => [i.index, i]));
        for (const f of fixes) {
            const issue = byNumber.get(f.fixes);
            if (!issue)
                continue;
            if (f.why && !f.text) {
                attempted.withdrawn.push({ text: issue.text, why: f.why });
            }
            else if (f.text) {
                if (stillFlagged.has(f.text.replace(/\s+/g, " ").trim()))
                    attempted.stillBroken++;
                else
                    attempted.rewritten++;
            }
        }
        attempted.unaddressed = Math.max(0, input.issues.length - attempted.rewritten - attempted.withdrawn.length - attempted.stillBroken);
        input.log(`  leader: conclusion repair — ${attempted.rewritten} of ${input.issues.length} sentence(s) rewritten without contradicting the record, ${attempted.withdrawn.length} given up, ${attempted.stillBroken} still contradicting it`);
        return { attempt: attempted, synthesis, issues: input.issues, remaining, calls: 1, rewritten: attempted.rewritten, withdrawn: attempted.withdrawn.length, ms: Date.now() - t0 };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        attempted.error = message;
        attempted.ms = Date.now() - started;
        input.log(`  leader: conclusion repair failed (${message.split("\n").slice(0, 2).join(" ")})`);
        return { attempt: attempted, synthesis: input.synthesis, issues: input.issues, remaining: input.issues, calls: 1, rewritten: 0, withdrawn: 0, ms: Date.now() - t0 };
    }
}
