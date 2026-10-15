/**
 * The conversation — round two, where the copies finally read each other.
 *
 * Round one keeps them apart on purpose: independent attempts to describe the same code catch different
 * things. But a team that never speaks is not a team, so round two hands every worker the **verified**
 * findings of the others — never their unchecked claims — and asks for a position: agree, rebut, extend,
 * or say plainly that it cannot be checked.
 *
 * The guardrails are the part the research insists on. Liang et al. found that forcing disagreement
 * polarises debate and that a judge tends to favour its own model; Smit et al. found an agent told to
 * oppose can attack a correct answer; Kim et al. found copies of similar models give the same wrong
 * answer most of the time when they are wrong. So: agreement is explicitly not counted as evidence,
 * disagreement is explicitly not counted as insight, rebuttals that carry a quote go through the same
 * gate as everything else and are labelled unproven when they do not, and "nothing changed my mind" is a
 * respectable answer rather than a failed one.
 */
import { z } from "zod";
import { askJson } from "./ask.js";
import { PERSONAS, handleFor } from "./personas.js";
import { verifyReports } from "./verify.js";
import { pLimit } from "../util/limit.js";
const Tup = z.tuple([z.number().int().min(1), z.number().int().min(1)]);
export const PeerResponseSchema = z.object({
    unit: z.string().min(1),
    stance: z.enum(["agree", "rebut", "extend", "unresolved"]),
    responses: z
        .array(z.object({
        to: z.string().min(1),
        verdict: z.enum(["agree", "rebut", "cannot-check"]),
        reason: z.string().min(5),
        path: z.string().optional(),
        lines: Tup.optional(),
        quote: z.string().min(8).optional(),
    }))
        .max(8)
        .default([]),
    changed: z.string().default(""),
    dissent: z.array(z.string()).max(6).default([]),
    revisedAnswer: z.string().min(1),
});
export function peerSystem(unit) {
    const p = PERSONAS[unit.role];
    return `You are ${p.handle}, still ${p.title}, now reading what the other copies of yourself found.

${p.stance}
How you speak: ${p.voice}

You are talking to copies of the same model. That fact is the whole reason for the rules below:
- Their agreement is NOT evidence, and neither is yours. You are correlated: when two of you are wrong
  about the same thing you usually make the same mistake. Only a line of the file settles anything, so a
  point you cannot quote is a point you cannot make.
- Their disagreement is not insight either. Do not reject a well-evidenced finding because it is not how
  you would have said it, and do not rebut something merely to be seen working. An agent told to oppose
  will happily attack a correct answer; that has been measured, and it is not useful work.
- "Nothing here changed my mind" is a normal, respectable answer. Say it rather than manufacturing doubt.
- A rebuttal that carries path, lines and an exact quote is checked by the server, exactly like round one:
  whitespace aside, the quote must be there. If you cannot cite it, use verdict "cannot-check" and say why
  — that is honest, and it is recorded.
- "dissent" is for what you still believe is wrong even if you cannot prove it yet. It goes in the record
  for the owner to judge. It is never evidence, and it never overrides a quote.

Reply with a single JSON object, no prose:
{"unit":"<your unit id>","stance":"agree|rebut|extend|unresolved",
 "responses":[{"to":"<their unit id>","verdict":"agree|rebut|cannot-check","reason":"...","path":"...","lines":[1,1],"quote":"..."}],
 "changed":"what changed in your position and why, or 'nothing'",
 "dissent":["..."],"revisedAnswer":"your answer now, in one paragraph"}`;
}
export function peerUser(unit, peers, memoryBlock) {
    return [
        `YOUR UNIT: ${unit.id} as ${handleFor(unit.role)} (${unit.role})`,
        `Your objective: ${unit.objective}`,
        `Your questions: ${unit.mustAnswer.join(" | ")}`,
        memoryBlock ? `\n${memoryBlock}` : "",
        "",
        "=== WHAT THE OTHERS REPORTED (only findings the server confirmed by re-reading the file) ===",
        peers,
        "=== END ===",
        `Answer as ${unit.id}. Speak to each unit by its id.`,
    ]
        .filter(Boolean)
        .join("\n");
}
/** The verified-only briefing each worker gets about the others. */
export function peerBriefing(reports, verification, self) {
    const blocks = [];
    for (const r of reports) {
        if (r.unit === self)
            continue;
        const unit = r.unit;
        const verified = verification.claims.filter((c) => c.unit === unit && c.status === "verified");
        blocks.push([
            `--- ${unit} said (verdict ${r.verdict}):`,
            `    ${r.answer.replace(/\s+/g, " ").slice(0, 700)}`,
            ...verified.slice(0, 6).map((c) => `    confirmed at ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim.replace(/\s+/g, " ").slice(0, 180)}\n      quoted: ${c.quote.replace(/\s+/g, " ").slice(0, 180)}`),
            ...(r.unknowns.length ? [`    did not know: ${r.unknowns.join(" | ").slice(0, 300)}`] : []),
            ...(r.steps.length ? [`    proposes: ${r.steps.map((s) => `${s.path} (${s.risk})`).join(", ")}`] : []),
        ].join("\n"));
    }
    if (verification.rejected.length) {
        blocks.push([
            "--- claims that FAILED the gate (do not build on them, do not repeat them):",
            ...verification.rejected.slice(0, 6).map((c) => `    [${c.status}] ${c.unit} ${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 160)}`),
        ].join("\n"));
    }
    return blocks.join("\n\n");
}
export async function runPeerRound(input) {
    const t0 = Date.now();
    const responses = [];
    const failed = [];
    const limit = pLimit(Math.max(1, input.concurrency));
    await Promise.all(input.units.map((unit) => limit(async () => {
        if (!input.reports.some((r) => r.unit === unit.id)) {
            input.log(`  ${handleFor(unit.role)} (${unit.id}): nothing of its own to defend, skipped the conversation`);
            return;
        }
        try {
            const asked = await askJson({
                role: "worker",
                system: peerSystem(unit),
                user: peerUser(unit, peerBriefing(input.reports, input.verification, unit.id), input.memoryBlock),
                schema: PeerResponseSchema,
                maxTokens: 2200,
                attempts: 2,
            });
            responses.push({ ...asked.value, unit: unit.id });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failed.push({ unit: unit.id, error: message });
            input.log(`  ${handleFor(unit.role)} (${unit.id}): could not answer the others (${message.split("\n").slice(0, 2).join(" ")})`);
        }
    })));
    // Peer rebuttals that cite code go through the same gate as round one. Nothing about being second
    // round, or being a rebuttal, earns a claim any extra trust.
    const asReports = responses
        .filter((r) => r.unit)
        .map((r) => ({
        unit: r.unit,
        answer: r.revisedAnswer,
        findings: r.responses
            .filter((x) => x.path && x.quote)
            .map((x) => ({ claim: `${x.verdict} ${x.to}: ${x.reason}`, path: x.path, lines: x.lines, quote: x.quote, confidence: "medium" })),
        steps: [],
        unknowns: [],
        openQuestions: [],
        verdict: "ok",
    }));
    const verification = await verifyReports({ projectRoot: input.projectRoot, units: input.units, reports: asReports, cache: new Map() });
    const withQuotes = responses.flatMap((r) => r.responses.filter((x) => x.path && x.quote));
    const unevidenced = responses.flatMap((r) => r.responses).filter((x) => x.verdict === "rebut" && !(x.path && x.quote)).length;
    return { responses, failed, verification, evidenced: withQuotes.length, unevidenced, ms: Date.now() - t0 };
}
/**
 * The conversation as the dossier shows it: who said what to whom, and — separately, because it is a
 * different kind of thing — which rebuttals were ever checked against the code.
 */
export function renderConversation(round, units) {
    if (!round.responses.length && !round.failed.length)
        return ["(the conversation did not happen: too few workers reported in round one)"];
    const roleOf = (id) => units.find((u) => u.id === id)?.role ?? "explorer";
    const checked = new Map(round.verification.claims.map((c) => [c.claim, c.status]));
    const lines = [
        `${round.responses.length} of ${units.length} participants spoke; ${round.evidenced} point(s) were made with a quote (all re-read by the server), ${round.unevidenced} rebuttal(s) were made without one and stand as unproven.`,
        "",
    ];
    for (const r of round.responses) {
        lines.push(`${handleFor(roleOf(r.unit))} (${r.unit}) — ${r.stance.toUpperCase()}`);
        for (const x of r.responses) {
            const status = x.path && x.quote ? (checked.get(`${x.verdict} ${x.to}: ${x.reason}`) ?? "quote-not-found") : "no evidence offered";
            lines.push(`  ${x.verdict} → ${x.to}: ${x.reason.replace(/\s+/g, " ").slice(0, 220)}  [${status}]`);
            if (x.path && x.quote)
                lines.push(`      ${x.path}${x.lines ? `:${x.lines[0]}-${x.lines[1]}` : ""} \`${x.quote.replace(/\s+/g, " ").slice(0, 160)}\``);
        }
        if (r.changed && r.changed.trim().toLowerCase() !== "nothing")
            lines.push(`  changed its position: ${r.changed.replace(/\s+/g, " ").slice(0, 300)}`);
        for (const d of r.dissent)
            lines.push(`  still disagrees (unproven, recorded for the owner): ${d.replace(/\s+/g, " ").slice(0, 240)}`);
        lines.push("");
    }
    for (const f of round.failed)
        lines.push(`- ${f.unit} did not answer the others: ${f.error.split("\n")[0]}`);
    lines.push("These are copies of one model: their agreement is not independent evidence, and this section counts nothing that the server did not re-read.");
    return lines;
}
