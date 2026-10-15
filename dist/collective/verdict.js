import { normalise } from "./verify.js";
import { handleFor } from "./personas.js";
export function missionVerdict(input) {
    const units = input.units;
    const productive = units.filter((u) => input.reports.some((r) => r.unit === u.id)).length;
    // A finding the repair pass settled is not a wrong citation any more — whether it was re-cited correctly or
    // withdrawn by its own worker, which is the worker agreeing the code does not say it. What is left is the
    // only thing this number means: a citation that is still wrong at the end of the run.
    const settled = new Set([
        ...(input.repair?.verification.claims ?? []).filter((c) => c.status === "verified").map((c) => `${c.unit}|${normalise(c.claim)}`),
        ...(input.repair?.attempts ?? []).flatMap((a) => a.withdrawn.map((w) => `${a.unit}|${normalise(w.claim)}`)),
    ]);
    // Distinct findings, keyed by unit and claim: a failed repair that repeats the same finding is the same
    // problem twice, and counting it twice would make the mission look worse than it was.
    const unresolved = new Map();
    for (const c of [...input.roundOne.rejected, ...(input.repair?.verification.rejected ?? [])]) {
        const k = `${c.unit}|${normalise(c.claim)}`;
        if (!settled.has(k))
            unresolved.set(k, true);
    }
    const stillWrong = unresolved.size;
    const verifierUnit = units.find((u) => u.role === "verifier");
    const verifier = verifierUnit
        ? {
            unit: verifierUnit.id,
            handle: handleFor("verifier"),
            reported: input.reports.some((r) => r.unit === verifierUnit.id),
            evidence: input.merged.claims.filter((c) => c.unit === verifierUnit.id && c.status === "verified").length,
        }
        : null;
    const rejectedDistinct = new Set([...input.roundOne.rejected, ...(input.repair?.verification.rejected ?? [])].map((c) => `${c.unit}|${normalise(c.claim)}`)).size;
    const totals = {
        verified: input.merged.counts.verified,
        rejected: rejectedDistinct,
        rejectedAttempts: input.merged.rejected.length,
        repaired: input.repair?.repaired ?? 0,
        withdrawn: (input.repair?.attempts ?? []).reduce((n, a) => n + a.withdrawn.length, 0),
        stillWrong,
        thin: input.merged.thin.length,
        units: units.length,
        productive,
        verifier,
    };
    const grade = totals.verified === 0
        ? "nothing"
        : totals.verified < 2 || productive * 2 <= units.length
            ? "thin"
            : totals.stillWrong === 0 && totals.thin === 0 && productive === units.length && input.closingRan
                ? "strong"
                : "partial";
    const lines = [
        "## Verdict (counted from the gate's results, not written by a model)",
        `- Evidence: ${totals.verified} quote(s) re-read from the files and matched where they were cited${totals.repaired ? `, of which ${totals.repaired} came back in the repair pass after failing once` : ""}.`,
        `- Not evidence: ${totals.rejected} finding(s) the gate rejected${totals.rejectedAttempts > totals.rejected ? ` (${totals.rejectedAttempts} attempt(s) in the record below, counting the repair pass)` : ""}; ${totals.stillWrong} still wrong at the end, ${totals.withdrawn} withdrawn by their own worker with a reason rather than guessed at again.`,
        ...(totals.thin ? [`- Weak support: ${totals.thin} verified quote(s) share no wording with the claim they are attached to. They are listed separately below and were kept out of memory.`] : []),
        `- Coverage: ${totals.productive} of ${totals.units} unit(s) produced something usable.`,
        verifier
            ? `- Falsification: ${verifier.handle} (${verifier.unit}) ${verifier.reported ? `reported, with ${verifier.evidence} verified counter-observation(s)` : "produced nothing usable, so nothing in this run tried to destroy the plan"}.`
            : "- Falsification: the plan had no verifier unit, so nothing in this run tried to destroy it.",
        `- Closing pass: ${input.closingRan ? "ran, over the verified findings only" : "did not run — the findings below are unmerged"}.`,
        `- Grade: ${grade.toUpperCase()} — a count of what survived the gate, not a judgement of the answer.`,
        "",
        "This is arithmetic over citations, not an assessment: a verified quote proves the file says that and nothing more, an unfalsified plan is not a right one, and this run did not execute the project's own gates.",
    ];
    return {
        grade,
        totals,
        lines,
        headline: `verdict ${grade.toUpperCase()} (${totals.verified} verified, ${totals.rejected} rejected${totals.repaired ? `, ${totals.repaired} repaired` : ""}, ${totals.productive}/${totals.units} units usable)`,
    };
}
