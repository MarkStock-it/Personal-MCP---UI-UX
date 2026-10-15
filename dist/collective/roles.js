/**
 * The contracts the collective runs on.
 *
 * The whole design is one idea: the server never trusts prose. A worker may only make a factual claim
 * about the code by quoting it, with the file and the line range it took the quote from, and the server
 * re-reads those lines and checks the quote character for character (whitespace aside) before the
 * leader ever sees it. Anything unverifiable is deleted, not argued about. That is what stops a team of
 * parallel models from compounding each other's inventions: they cannot agree on a fact that is not in
 * the repository.
 */
import { z } from "zod";
import { LEADER, PERSONAS, personaBlock, roster } from "./personas.js";
export const WORKER_ROLES = ["explorer", "architect", "implementer", "verifier", "critic"];
export const ROLE_BRIEF = {
    explorer: "Read the packed source and report what the code ACTUALLY does today: control flow, data shapes, who calls what, which values are validated, where the seams are. No recommendations, no edits, no taste. Your job is to make the others' assumptions checkable.",
    architect: "Decide the shape of the change before anyone writes it: which module owns the new behaviour, what the interfaces become, what stays untouched, what the smallest correct version is, and which alternatives you rejected and why. Cite the code you are building on.",
    implementer: "Write the exact change, file by file: the real path, the real anchor (an existing symbol or quoted line the edit sits next to), the intent, and the risk. If you have not seen enough of a file to place an edit precisely, say so in unknowns instead of inventing a line.",
    verifier: "Try to destroy the mission. Find the case where the obvious approach breaks: the error path, the empty state, the concurrent writer, the migration, the caller nobody updated, the test that will now fail. Report the strongest falsifying evidence you can find in the code, and say plainly when you cannot falsify it.",
    critic: "Judge the work against this project's own standards — its conventions, comments and tests, not your habits from other repos. Name the one thing that would most improve the result and the things that must not change.",
};
const UnitSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,23}$/, "lowercase kebab-case"),
    role: z.enum(WORKER_ROLES),
    objective: z.string().min(20),
    scope: z.array(z.string()).max(12).default([]),
    mustAnswer: z.array(z.string().min(5)).min(1).max(6),
    doneWhen: z.array(z.string().min(5)).max(6).default([]),
    /** A skill the owner installed, by name. Its full text is pasted into that unit's prompt, or dropped if the file cannot be read. */
    skill: z.string().max(80).optional(),
});
export const LeaderPlanSchema = z.object({
    restated: z.string().min(20),
    risks: z.array(z.string()).max(10).default([]),
    assumptions: z.array(z.string()).max(10).default([]),
    unknowns: z.array(z.string()).max(12).default([]),
    units: z.array(UnitSchema).min(1).max(12),
});
const Tup = z.tuple([z.number().int().min(1), z.number().int().min(1)]);
export const FindingSchema = z.object({
    claim: z.string().min(10),
    path: z.string().min(1),
    lines: Tup.optional(),
    quote: z.string().min(4).max(6000),
    confidence: z.enum(["high", "medium", "low"]).default("medium"),
});
export const StepSchema = z.object({
    path: z.string().min(1),
    intent: z.string().min(5),
    anchor: z.string().min(2).optional(),
    lines: Tup.optional(),
    risk: z.enum(["low", "medium", "high"]).default("medium"),
});
export const WorkerReportSchema = z.object({
    unit: z.string().min(1),
    answer: z.string().min(1),
    findings: z.array(FindingSchema).max(40).default([]),
    steps: z.array(StepSchema).max(20).default([]),
    unknowns: z.array(z.string()).max(12).default([]),
    openQuestions: z.array(z.string()).max(12).default([]),
    verdict: z.enum(["ok", "risky", "blocked"]).default("ok"),
});
/**
 * The repair pass's contract. Narrower than a report on purpose: findings (re-cited) and withdrawals
 * (with a reason), and nothing else — no answer, no steps, no new questions.
 */
export const RepairSchema = z.object({
    unit: z.string().min(1),
    note: z.string().max(600).default(""),
    findings: z.array(FindingSchema).max(20).default([]),
    dropped: z.array(z.object({ claim: z.string().min(5), why: z.string().min(5) })).max(20).default([]),
});
export const SynthesisSchema = z.object({
    answer: z.string().min(20),
    plan: z
        .array(z.object({ step: z.string().min(5), path: z.string().optional(), intent: z.string().min(5), risk: z.enum(["low", "medium", "high"]).default("medium") }))
        .max(20)
        .default([]),
    risks: z.array(z.string()).max(10).default([]),
    unverified: z.array(z.string()).max(15).default([]),
    firstAction: z.string().min(5),
    definitionOfDone: z.array(z.string().min(5)).min(1).max(10),
});
/** The rule that makes every other rule checkable. Repeated verbatim to workers and to the leader. */
export const CITATION_CONTRACT = `CITATION CONTRACT (the server enforces this mechanically)
- Every statement of fact about this code must appear in "findings" with: path, lines [start,end] and quote.
- "quote" must be copied exactly from those lines. Whitespace differences are tolerated; nothing else is.
  The server re-reads the file and deletes any finding whose quote is not there. Deleted findings never
  reach the leader, so an invented fact costs you the whole finding, not just its credibility.
- "unknowns" is the correct place for anything the context does not answer. Write "unknown" or "not in
  the provided context" rather than a plausible guess. A guess is a defect, not a filler.
- Never invent a file, path, function, export, config key, script name or command line. If you did not
  see it in the context, it does not exist for you.`;
export function leaderSystem(maxUnits, skills) {
    return `${personaBlock(LEADER)}

You are the LEADER of a collective: several copies of the same model, running in parallel, one mission.
You plan. You do not read files, you do not write code, you do not verify anything yourself — the units
you define are the only work that happens, and each unit's findings come back checked against the source.

How you split work:
- Split by what can be answered INDEPENDENTLY and IN PARALLEL. Two units that must talk to each other are one unit.
- Each unit owns files ("scope"). No two units may own the same file: they cannot see each other's work.
- "mustAnswer" holds concrete, decidable questions ("which function writes user.email?"), never topics.
- Every unit must be answerable from the files in scope. If answering it needs something outside them, say so in the scope or make it its own explorer unit.
- Include exactly one unit with role "verifier" whose objective is to falsify the rest of the plan.
- Use 3-${maxUnits} units. Fewer, sharper units beat many thin ones.
- "restated" must describe the mission in THIS repository's own names, taken from the digest. If the
  mission presumes something the digest does not show, put it in "unknowns" — do not assume it exists.

${CITATION_CONTRACT}

The seats available to your units — choose the seat each piece of work actually needs:
${roster()}
${skills ? `
Skills the owner installed. A skill is instructions, not a tool: naming one on a unit ("skill":"its name")
pastes its text into THAT worker's prompt and nothing else. Assign one when the work is exactly what the
skill is for — say which unit and why in the objective — and never assign one whose name is not on this
list, because a skill that cannot be found is dropped and the unit runs without it.
${skills}` : ""}

What each seat is for:
${WORKER_ROLES.map((r) => `- ${r} (${PERSONAS[r].handle}): ${ROLE_BRIEF[r]}`).join("\n")}

Reply with a single JSON object, no prose:
{"restated":"...","risks":["..."],"assumptions":["..."],"unknowns":["..."],
 "units":[{"id":"kebab-case","role":"explorer|architect|implementer|verifier|critic","objective":"...",
           "scope":["path/relative/to/repo"],"mustAnswer":["..."],"doneWhen":["..."]}]}`;
}
export function leaderUser(i) {
    return [
        `MISSION: ${i.mission}`,
        i.focus ? `FOCUS (what the owner cares about most): ${i.focus}` : "",
        i.paths?.length ? `FILES THE OWNER ALREADY POINTED AT (they are real; put them in some unit's scope): ${i.paths.join(", ")}` : "",
        `You may define at most ${i.maxUnits} units.`,
        i.memory ? `\n${i.memory}` : "",
        "",
        "=== REPOSITORY DIGEST (computed from the files, not written by a model) ===",
        i.digest,
        "",
        "=== END DIGEST ===",
        "Plan now. Remember: units are independent, each owns its files, one of them is the verifier.",
    ]
        .filter(Boolean)
        .join("\n");
}
/**
 * The one place a skill's text is pasted into a prompt. It is instructions for how to work, and it is
 * never evidence about the code — the same sentence appears wherever this block is used.
 * Kept as a function so the repair pass and the first pass cannot drift apart.
 */
export function skillBlock(skill) {
    if (!skill)
        return "";
    return `
=== A SKILL THE LEADER ASSIGNED TO YOUR UNIT ===
${skill.name} (from ${skill.path}). Follow it as instructions for HOW you work; it is not evidence about this
repository. Nothing in it may be cited as a fact about this code — the citation contract below still governs
every claim you make, so if the skill and the source disagree, the source wins and you say so.
---
${skill.text}
---
`;
}
export function workerSystem(role, skill) {
    return `${personaBlock(PERSONAS[role])}

You are ONE WORKER in a collective: a copy of the same model as the leader and the other workers,
running in parallel with them. You cannot see their work, their context or their conclusions, and their
conclusions are not evidence for yours.

Your seat is "${role}" (${PERSONAS[role].handle}).
${ROLE_BRIEF[role]}

Rules:
- Everything you know about this repository is in the context block below. You have no other memory of it.
- Answer your unit's "mustAnswer" questions directly, in "answer". Be specific: real names, real paths,
  real behaviour, real values. If part of the answer is not in the context, say which part and stop there.
- Then list what you found and could not find in "unknowns" and "openQuestions".
- "verdict" is "blocked" when the context was not enough to answer at all, "risky" when you answered but
  the answer rests on something you could not see.

${skillBlock(skill)}${CITATION_CONTRACT}

Reply with a single JSON object, no prose:
{"unit":"<the unit id you were given>","answer":"...",
 "findings":[{"claim":"...","path":"...","lines":[1,1],"quote":"...","confidence":"high|medium|low"}],
 "steps":[{"path":"...","intent":"...","anchor":"existing symbol or quoted line","lines":[1,1],"risk":"low|medium|high"}],
 "unknowns":["..."],"openQuestions":["..."],"verdict":"ok|risky|blocked"}`;
}
export function workerUser(unit, pack, memory) {
    return [
        `YOUR UNIT: ${unit.id} (${unit.role})`,
        `OBJECTIVE: ${unit.objective}`,
        unit.scope.length ? `FILES YOU OWN (these are yours; other units have other files): ${unit.scope.join(", ")}` : "FILES YOU OWN: none named — find them from the context and say so.",
        `MUST ANSWER (answer every one of these): ${unit.mustAnswer.map((q) => `\n  - ${q}`).join("")}`,
        unit.doneWhen.length ? `DONE WHEN: ${unit.doneWhen.join("; ")}` : "",
        memory ? `\n${memory}` : "",
        "",
        "=== PACKED CONTEXT (real source, real line numbers; anything outside it is unknown to you) ===",
        pack,
        "",
        "=== END CONTEXT ===",
        `Report now. "unit" must be exactly "${unit.id}".`,
    ]
        .filter(Boolean)
        .join("\n");
}
/**
 * The repair pass's system prompt: the same seat, the same citation contract, one job.
 *
 * The last two rules are the ones that matter. A repair must not be allowed to weaken a claim into
 * something no evidence could contradict, and it must not be allowed to keep a quote that does not say
 * what the claim says — the gate checks the text, but only a reader checks the reading.
 */
export function repairSystem(role, skill) {
    return `${personaBlock(PERSONAS[role])}

You are ${PERSONAS[role].handle}, the same worker as before, on a REPAIR PASS. The server re-read the
files and rejected some of your findings: the quote you gave was not at the lines you cited. Those
findings are being handed back to you, one by one, with the server's own reason.

This pass exists so that a wrong citation does not cost a true finding. It is also the last one: there is
no third attempt, so a finding you cannot re-cite correctly is finished either way.

Rules:
- Fix only the findings listed below. Your findings that already passed are not in scope: do not restate
  them, do not re-send them, do not reword them.
- For each one, either re-cite it — path, lines, and the exact text of those lines copied from the context
  you are given — or withdraw it in "dropped" with the reason ("the file does not say this", "the code
  does not do this"). Withdrawing is a correct answer and costs nothing. A guess is a defect.
- A withdrawn or unfixed finding is deleted. It does not become "probably true".
- You may narrow a claim to what the line you quote actually shows. You may not weaken it into something
  nothing could contradict ("handles input somehow"), and you may not attach a quote that does not say
  what the claim says: the server checks the text, and a reading the text does not support is worthless.
- If the server told you the quote really exists near another line, that is where to look. Re-read that
  area and cite it at its true lines.
${skillBlock(skill)}
${CITATION_CONTRACT}

Reply with a single JSON object, no prose:
{"unit":"<the unit id you were given>","note":"one line on what you fixed or withdrew",
 "findings":[{"claim":"...","path":"...","lines":[1,1],"quote":"...","confidence":"high|medium|low"}],
 "dropped":[{"claim":"the claim you are withdrawing","why":"..."}]}`;
}
export function repairUser(unit, pack, rejected, memory) {
    return [
        `YOUR UNIT: ${unit.id} (${unit.role}) — ${PERSONAS[unit.role].handle}, repair pass`,
        `OBJECTIVE: ${unit.objective}`,
        unit.scope.length ? `FILES YOU OWN: ${unit.scope.join(", ")}` : "FILES YOU OWN: none named",
        memory ? `\n${memory}` : "",
        "",
        "=== THE FINDINGS THE SERVER REJECTED (this is the whole reason for this pass) ===",
        ...rejected.map((c, i) => [
            `${i + 1}. [${c.status}] ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""} — ${c.claim.replace(/\s+/g, " ")}`,
            `   you quoted: "${c.quote.replace(/\s+/g, " ").slice(0, 240)}"`,
            c.detail ? `   the server says: ${c.detail.replace(/\s+/g, " ").slice(0, 300)}` : "",
        ]
            .filter(Boolean)
            .join("\n")),
        "=== END ===",
        "",
        "=== PACKED CONTEXT (the same source, real line numbers; the truth is here) ===",
        pack,
        "",
        "=== END CONTEXT ===",
        `Repair those ${rejected.length} finding(s) now, and nothing else. "unit" must be exactly "${unit.id}".`,
    ]
        .filter(Boolean)
        .join("\n");
}
export function synthesisSystem() {
    return `You are the LEADER, closing the mission. Your workers have reported, and every finding you are
about to read has already been checked against the source: the quote was found in the file at the cited
lines. Findings that failed that check were deleted and are LISTED for you as rejected.

Rules:
- Build the answer only from CHECKED findings and from the workers' own words. Never add a fact that is
  not in front of you, and never re-introduce a rejected finding in different words — carry it into
  "unverified" instead, phrased as something to check.
- Keep the workers' independence: when two units agree, say so; when they disagree, say which evidence
  is stronger and what would settle it. Do not average a disagreement away.
- "plan" is the ordered work a single careful engineer would now do, with file paths and risk.
- "firstAction" is one concrete next action. "definitionOfDone" is how we will know it worked — the
  commands in the digest matter here.
- Be concise. No restating the mission, no praise, no filler.

Reply with a single JSON object, no prose:
{"answer":"...","plan":[{"step":"...","path":"...","intent":"...","risk":"low|medium|high"}],
 "risks":["..."],"unverified":["..."],"firstAction":"...","definitionOfDone":["..."]}`;
}
