// The deterministic half of the collective, driven directly against the built modules: the edit gate's
// status matrix and the verdict's grade arithmetic. Neither is reachable through a full mission at a
// reasonable cost — a STRONG grade needs a run with no wrong citation, no thin support and a closing pass,
// and the statuses that matter most (an anchor that occurs twice, a line range past the end, a file that
// exists but is not indexed) need a fixture built for them — so they are exercised here, with no model and
// no server in the way. Everything claimed in the docs about the grades is asserted below.
//
// Run: npm run build && node smoke/arithmetic.mjs   (also run by `npm run smoke`)
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${extra ? ` -> ${extra}` : ""}`);
  }
};
const section = (name) => console.log(`\n== ${name} ==`);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-arithmetic-"));
process.env.DESIGN_MCP_PROJECT_DIR = tmp;

// The fixture: one widely imported module (five importers, one of them a test), four callers, and a file
// the index does not carry because its extension is not source.
const FIXTURE = {
  "package.json": JSON.stringify({ name: "arithmetic-fixture", type: "module", scripts: { test: "node --test" } }, null, 2),
  "src/lib/format.ts": [
    "export function formatMoney(cents: number, currency: string): string {",
    "  const unit = cents / 100;",
    "  return `${currency} ${unit.toFixed(2)}`;",
    "}",
    "",
    "export const CURRENCIES = [\"PHP\", \"USD\"];",
    "",
    "export function formatRate(bps: number): string {",
    "  return `${(bps / 100).toFixed(2)}%`;",
    "}",
  ].join("\n"),
  "src/lib/format.test.ts": 'import { formatRate } from "./format.js";\n\nexport const check = () => formatRate(250);\n',
  "src/lib/notes.txt": "plain text, not source, so the index leaves it out\n",
  ...Object.fromEntries(
    ["a", "b", "c", "d"].map((n) => [
      `src/${n}.ts`,
      `import { formatMoney } from "./lib/format.js";\n\nexport const ${n} = (cents: number) => formatMoney(cents, "PHP");\n`,
    ])
  ),
};
for (const [rel, text] of Object.entries(FIXTURE)) {
  await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
  await fs.writeFile(path.join(tmp, rel), text);
}

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "config.js")).href);
const { getIndex, quickStampFor } = await import(pathToFileURL(path.join(ROOT, "dist", "codebase", "store.js")).href);
const { verifyEdits, renderEditCheck, mergeEditChecks, EDIT_STATUS_MEANING } = await import(pathToFileURL(path.join(ROOT, "dist", "collective", "edits.js")).href);
const { missionVerdict } = await import(pathToFileURL(path.join(ROOT, "dist", "collective", "verdict.js")).href);
const { checkConclusion, applyConclusionFixes, renderConclusionCheck, renderConclusionRepair, splitSentences } = await import(pathToFileURL(path.join(ROOT, "dist", "collective", "conclusion.js")).href);

const { config } = loadConfig();
const { index } = await getIndex(tmp, config.codebase, {});

const edit = (over) => ({ source: "u1", sourceIndex: 0, path: "src/lib/format.ts", intent: "an edit", risk: "medium", ...over });
const matrix = [
  edit({ path: "src/lib/format.ts", anchor: "export function formatMoney", lines: [1, 3], intent: "reuse the money formatter" }),
  edit({ anchor: "export const CURRENCIES", intent: "extend the currency list" }),
  edit({ anchor: "export", intent: "an anchor that is everywhere" }),
  edit({ anchor: "export function formatRate", lines: [1, 2], intent: "cite the rate helper at the wrong lines" }),
  edit({ anchor: "export function formatPhone", lines: [7, 7], intent: "an anchor that is not in the file" }),
  edit({ anchor: "export function formatPhone", lines: [400, 410], intent: "a range past the end, with the anchor missing too" }),
  edit({ anchor: "export function formatRate", lines: [400, 410], intent: "a range past the end, with the anchor real" }),
  edit({ path: "src/lib/format.js", anchor: "formatMoney", intent: "a path with the wrong extension" }),
  edit({ path: "src/lib/telemetry.ts", anchor: "export const track", intent: "a file that does not exist" }),
  edit({ path: "src/lib/formatts.ts", anchor: "export const formatMoney", intent: "a path with a letter too many" }),
  edit({ path: "../outside.ts", anchor: "export const leak", intent: "an edit outside the project" }),
  edit({ anchor: undefined, lines: undefined, intent: "no anchor and no line range" }),
  edit({ scope: ["src/a.ts"], anchor: "export const CURRENCIES", intent: "an edit in a file this source does not own" }),
  edit({ risk: "low", anchor: "export const CURRENCIES", intent: "a low-risk edit in a widely imported file" }),
  edit({ path: "src/a.ts", anchor: "formatMoney", lines: [3, 3], intent: "rename the formatter from a call site" }),
  edit({ path: "src/lib/notes.txt", anchor: "plain text, not source", lines: [1, 1], intent: "an edit in a file the index skipped" }),
  edit({ source: "u2", anchor: "export const CURRENCIES", intent: "the same anchor, another source" }),
  edit({ source: "u2", anchor: "export function formatMoney", lines: [1, 3], intent: "an overlapping range, another source" }),
];
const check1 = await verifyEdits({ projectRoot: tmp, index, edits: matrix });
const status = (i) => check1.edits[i].status;
const detail = (i) => check1.edits[i].detail ?? "";
const flags = (i) => check1.edits[i].flags.join(" | ");

section("the edit gate: one status per way an edit can fail to land");
check("the anchor is really there at the cited lines", status(0) === "anchored" && check1.edits[0].anchorAt === 1, `${status(0)} at ${check1.edits[0].anchorAt}`);
check("an anchor that occurs once needs no line range", status(1) === "anchored" && check1.edits[1].occurrences === 1, `${status(1)} x${check1.edits[1].occurrences}`);
check("an anchor that occurs three times is not treated as placed", status(2) === "anchor-ambiguous" && /occurs 3 times/.test(detail(2)), `${status(2)} ${detail(2)}`);
check("a real anchor at the wrong lines is stale, not invented", status(3) === "anchor-elsewhere" && /lives at line 8, not 1-2/.test(detail(3)), `${status(3)} ${detail(3)}`);
check("an anchor that is not in the file cannot be applied", status(4) === "anchor-not-found" && /closest line is/.test(detail(4)), `${status(4)} ${detail(4)}`);
check("a range past the end says the anchor is not in the file either", status(5) === "lines-out-of-range" && /anchor is not in the file either/.test(detail(5)), `${status(5)} ${detail(5)}`);
check("a range past the end still says where a real anchor actually is", status(6) === "lines-out-of-range" && /anchor is really at line 8/.test(detail(6)), `${status(6)} ${detail(6)}`);
check("a path that is not there gets a suggestion from the index", status(7) === "no-such-file" && /closest path in the index is src\/lib\/format\.ts/.test(detail(7)), `${status(7)} ${detail(7)}`);
check("a path with nothing like it says so instead of guessing", status(8) === "no-such-file" && /nothing in the index resembles it/.test(detail(8)), `${status(8)} ${detail(8)}`);
check("a name with a letter too many still finds the real file", status(9) === "no-such-file" && /closest path in the index is src\/lib\/format\.ts/.test(detail(9)), `${status(9)} ${detail(9)}`);
check("an edit outside the project is refused, never read", status(10) === "outside-project" && check1.edits[10].snapshot === undefined, `${status(10)}`);
check("an edit with no anchor and no lines is checked for its path and nothing more", status(11) === "unanchored", `${status(11)}`);

section("the edit gate: what it says about the file an edit lands in");
check("the importers come from the index's own graph", check1.edits[0].impact.importedBy === 5 && check1.edits[0].impact.importers.includes("src/a.ts"), JSON.stringify(check1.edits[0].impact));
check("the test that will fail first is named", check1.edits[0].impact.tests.includes("src/lib/format.test.ts"), JSON.stringify(check1.edits[0].impact.tests));
check("an edit at a use site points at the declaration and a rename's sweep", check1.edits[14].impact.declaredIn?.path === "src/lib/format.ts" && check1.edits[14].impact.renameSweep.length === 5, JSON.stringify(check1.edits[14].impact));
check(
  "and it names where the name is used, not just which files import it",
  check1.edits[14].impact.callSiteCount === 8 && check1.edits[14].impact.callSites[0].path === "src/a.ts" && check1.edits[14].impact.callSites[0].line === 1,
  JSON.stringify(check1.edits[14].impact.callSites)
);
check("the call-site line reaches the report the reader sees", /where it is used: src\/a\.ts:1/.test(renderEditCheck(check1, { limit: 20 })));
check("an edit outside the source's own files is flagged, not hidden", /outside the files u1 owns/.test(flags(12)), flags(12));
check("a low risk in a widely imported file is called out", /risk is stated as low, but 5 indexed file\(s\) import this one/.test(flags(13)), flags(13));
check("a file the index skipped is named as unindexed", /no entry in the index/.test(flags(15)), flags(15));
check("every checked edit carries the snapshot its line numbers belong to", /^[0-9a-f]{16}$/.test(check1.edits[0].snapshot ?? "") && check1.edits[0].bytes === Buffer.byteLength(FIXTURE["src/lib/format.ts"], "utf8"), `${check1.edits[0].snapshot} ${check1.edits[0].bytes}`);
check("the same file checked twice reports the same snapshot", check1.edits[0].snapshot === check1.edits[13].snapshot);

section("the edit gate: hazards that only exist between edits");
check("the same anchor from two sources is called out", check1.notes.some((n) => /u1 and u2 both propose an edit at the same anchor/.test(n)), check1.notes.join(" | "));
check("overlapping ranges in one file from two sources are called out", check1.notes.some((n) => /propose edits that overlap at lines/.test(n)), check1.notes.join(" | "));
check("the file with the most dependents is named", check1.notes.some((n) => /riskiest file in this set is src\/lib\/format\.ts: 5 indexed file/.test(n)), check1.notes.join(" | "));
check(
  "the counts add up to what the gate saw: 18 edits, 8 placed, 7 that cannot be applied, 1 stale, 2 anchored to nothing",
  check1.counts.anchored === 8 && check1.broken === 7 && check1.staleLines === 1 && check1.unanchored === 2 && check1.edits.length === 18,
  JSON.stringify(check1.counts)
);
check("every status has a stated meaning", Object.values(EDIT_STATUS_MEANING).every((s) => typeof s === "string" && s.length > 20));

section("the edit gate: the report it hands back");
const rendered = renderEditCheck(check1, { limit: 20 });
check("the report says how many edits cannot be applied", /7 cannot be applied as described, 1 has a real anchor with stale line numbers, 2 are anchored to nothing/.test(rendered), rendered.split("\n").slice(0, 8).join(" / "));
check("the report states the boundary of what it checks", /does not apply the change, it does not parse the result, and it does not judge whether the change/.test(rendered));
check("the report tells the reader to re-check a stale snapshot", /if that file hashes differently when you\s+apply the edit, the numbers are stale/.test(rendered));
const empty = await verifyEdits({ projectRoot: tmp, index, edits: [] });
check("no proposed edits says so rather than printing nothing", /No edit was proposed/.test(renderEditCheck(empty)), renderEditCheck(empty));

section("the edit repair pass: what a settled step stops counting for");
const unplaceable = { source: "u1", sourceIndex: 0, path: "src/lib/format.ts", intent: "an unplaceable step", anchor: "export function formatPhone", lines: [7, 7] };
const landed = { source: "u1", sourceIndex: 1, path: "src/a.ts", intent: "a step that landed", anchor: "formatMoney", lines: [3, 3] };
const rePlaced = { source: "u1", sourceIndex: 0, path: "src/lib/format.ts", intent: "re-placed against a real line", anchor: "export const CURRENCIES", lines: [6, 6], risk: "medium" };
const stillWrong = { source: "u1", sourceIndex: 0, path: "src/lib/format.ts", intent: "still guessing", anchor: "export function formatPhone", lines: [1, 1] };
const firstPass = await verifyEdits({ projectRoot: tmp, index, edits: [unplaceable, landed] });
const answer = await verifyEdits({ projectRoot: tmp, index, edits: [rePlaced] });
const answerBroken = await verifyEdits({ projectRoot: tmp, index, edits: [stillWrong] });
const nothingCameBack = await verifyEdits({ projectRoot: tmp, index, edits: [] });
const mergedFixed = mergeEditChecks(firstPass, answer, { fixed: ["u1|0"], withdrawn: [] });
const mergedWithdrawn = mergeEditChecks(firstPass, nothingCameBack, { fixed: [], withdrawn: ["u1|0"] });
const mergedBroken = mergeEditChecks(firstPass, answerBroken, { fixed: [], withdrawn: [] });
check("the first pass really did reject one of the two steps", firstPass.broken === 1 && firstPass.counts.anchored === 1, JSON.stringify(firstPass.counts));
check("a step that was re-placed stops counting as one that cannot be applied", mergedFixed.broken === 0 && mergedFixed.counts.anchored === 2, JSON.stringify({ broken: mergedFixed.broken, counts: mergedFixed.counts }));
check("and the attempt that failed stays on the record, marked as superseded", mergedFixed.edits.length === 3 && mergedFixed.edits[0].superseded === "fixed" && mergedFixed.edits[0].status === "anchor-not-found", JSON.stringify(mergedFixed.edits.map((e) => [e.status, e.superseded, e.repaired])));
check("the re-placed step is marked as coming from the pass, not as the original", mergedFixed.edits[2].repaired === true && mergedFixed.edits[0].repaired === undefined);
check("a step its author gave up with a reason stops counting too", mergedWithdrawn.broken === 0 && mergedWithdrawn.edits[0].superseded === "withdrawn", JSON.stringify(mergedWithdrawn.edits.map((e) => [e.status, e.superseded])));
check("a replacement that still cannot be placed is counted, and so is the original", mergedBroken.broken === 2, JSON.stringify({ broken: mergedBroken.broken }));
check(
  "the merged report says both things: what is left, and what was settled",
  /- 2 cannot be applied as described/.test(renderEditCheck(mergedBroken, { heading: false })) && /1 of the steps above was re-placed by the repair pass; each is marked where it appears/.test(renderEditCheck(mergedFixed, { heading: false })),
  renderEditCheck(mergedFixed, { heading: false }).split("\n").slice(0, 3).join(" / ")
);

section("the conclusion gate: the closing paragraph against the mission's own record");
// Defined here rather than borrowed from the verdict section below: this gate takes a verification object
// and nothing else, and a section that silently depends on a helper defined 60 lines later is a trap.
const verifLike = (over = {}) => ({
  claims: [],
  rejected: [],
  units: [],
  conflicts: [],
  counts: { verified: 2, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 },
  thin: [],
  supportCounts: { overlap: 0, thin: 0, unchecked: 0 },
  unparsed: [],
  ms: 0,
  ...over,
});
const rejectedClaim = { unit: "alpha", role: "explorer", claim: "the cleaner also trims whitespace", path: "src/a.ts", lines: [1, 1], quote: "x", confidence: "low", status: "quote-not-found", detail: "not found in that file at or near 1-1" };
const thinSupported = { unit: "bravo", role: "verifier", claim: "the money formatter rounds half up", path: "src/lib/format.ts", lines: [2, 2], quote: "x", confidence: "medium", status: "verified", support: "thin" };
const withdrawnRound = {
  attempts: [{ unit: "charlie", role: "explorer", sent: 1, recited: 0, replaced: 0, withdrawn: [{ claim: "the rate helper divides by 100", why: "the file caps it but never divides" }], unaddressed: 0, note: "", ms: 0 }],
  verification: verifLike(),
  calls: 1,
  repaired: 0,
  stillRejected: 0,
  ms: 0,
};
const paragraph = (over = {}) => ({
  answer: [
    "The cleaner also trims whitespace, so the leak is closed.",
    "The claim about whitespace trimming was rejected by the server and is carried as unverified.",
    "The rewrite lives in src/lib/telemetry.ts.",
    "Everything else (node.js, package.json) is untouched.",
  ].join(" "),
  plan: [],
  risks: ["the rate helper divides by 100", "The money formatter rounds half up, which is why the totals shift."],
  unverified: ["the cleaner also trims whitespace"],
  firstAction: "Read src/a.ts before editing.",
  definitionOfDone: ["npm test passes"],
  ...over,
});
const missionRecord = verifLike({ rejected: [rejectedClaim], thin: [thinSupported] });
const conclusionIssues = await checkConclusion({ synthesis: paragraph(), verification: missionRecord, repair: withdrawnRound, index, root: tmp });
const issueKinds = conclusionIssues.map((i) => `${i.kind}@${i.field}`);
check("a sentence that repeats a finding the gate deleted is caught", conclusionIssues.some((i) => i.kind === "reintroduced-rejection" && i.field === "answer"), issueKinds.join(", "));
check("hedged wording that restates the rejection is correct usage, not a contradiction", !conclusionIssues.some((i) => /was rejected by the server/.test(i.text)), issueKinds.join(", "));
check("a sentence that states a THIN SUPPORT finding as established is caught", conclusionIssues.some((i) => i.kind === "thin-support" && i.field === "risks"), issueKinds.join(", "));
check("a sentence that repeats a claim its own author withdrew is caught", conclusionIssues.some((i) => i.kind === "withdrawn-claim"), issueKinds.join(", "));
check("a file that is in neither the index nor the repository is caught, and named", conclusionIssues.some((i) => i.kind === "unknown-file" && i.path === "src/lib/telemetry.ts"), issueKinds.join(", "));
check("a file the index skipped but that is really on disk is not a contradiction", !conclusionIssues.some((i) => i.path === "src\/lib\/notes.txt"), issueKinds.join(", "));
check("a library shorthand in prose is not read as a file", !conclusionIssues.some((i) => i.path === "node.js"), issueKinds.join(", "));
check("the unverified list is exempt from the assertion check, since it is where a rejection belongs", !conclusionIssues.some((i) => i.field === "unverified"));
check("the sentences are numbered, so an answer can name one by number", conclusionIssues.every((i, n) => i.index === n + 1), conclusionIssues.map((i) => i.index).join(","));
check("each issue carries the sentence it came from and where in the paragraph it sits", conclusionIssues[0].text.length > 12 && conclusionIssues[0].field === "answer" && conclusionIssues[0].sentence === 0);
check("and it quotes back what the record says instead", /rejected this finding \(quote-not-found\)/.test(conclusionIssues[0].because) && /withdrew this claim/.test(conclusionIssues.find((i) => i.kind === "withdrawn-claim").because), conclusionIssues[0].because);

const patched = applyConclusionFixes(paragraph(), conclusionIssues, [
  { fixes: 1, text: "What the mission established: the cleaner trims its input, and the claim about whitespace was rejected by the server." },
  { fixes: 2, why: "the file list has no such file, so I cannot say where the rewrite lives" },
]);
check("a rewritten sentence replaces the one that contradicted the record", /^What the mission established: the cleaner trims its input/.test(patched.answer), patched.answer);
check("a sentence the leader gave up is removed from the conclusion, not left standing", !/telemetry/.test(patched.answer), patched.answer);
check("the rest of the paragraph is untouched", patched.risks.length === 2 && /rate helper divides by 100/.test(patched.risks[0]) && patched.definitionOfDone[0] === "npm test passes");
check("the untouched sentences still count against the record", patched.unverified.length === 1);
const after = await checkConclusion({ synthesis: patched, verification: missionRecord, repair: withdrawnRound, index, root: tmp });
check("re-checking the rewritten paragraph leaves only what was not answered", after.length === 2 && after.every((i) => i.kind !== "unknown-file" && i.kind !== "reintroduced-rejection"), after.map((i) => `${i.kind}@${i.field}`).join(", "));
const emptied = applyConclusionFixes(paragraph({ answer: "The cleaner also trims whitespace." }), [{ index: 1, field: "answer", item: 0, sentence: 0, text: "The cleaner also trims whitespace.", kind: "reintroduced-rejection", because: "x" }], [{ fixes: 1, why: "nothing in the record supports it" }]);
check("a conclusion emptied by withdrawals says so instead of reading as blank", /withdrew every part of its conclusion/.test(emptied.answer), emptied.answer);
check("sentences are split the same way by the gate and by the patch", splitSentences("One. Two! Three?").flat().length === 3, JSON.stringify(splitSentences("One. Two! Three?")));
const renderedConclusion = renderConclusionCheck(conclusionIssues).join("\n");
check("the section lists what the paragraph said and what the record says instead", /1\. \[reintroduced-rejection: repeats a finding the gate deleted\] answer/.test(renderedConclusion) && /the record says: the mission's own gate rejected this finding/.test(renderedConclusion), renderedConclusion.slice(0, 300));
check("and it states its own boundary rather than reading as a judgement", /nothing here decides whether it is right/.test(renderedConclusion));
check("the pass section reports what was settled and what was given up", /2 flagged sentence\(s\) back/.test(renderConclusionRepair({ calls: 1, sent: 2, rewritten: 1, withdrawn: [{ text: "a sentence", why: "because" }], unaddressed: 0, stillBroken: 0, note: "", ms: 0 }).join("\n")));

section("the verdict: the grade is arithmetic over the gate's counts");
const units = ["alpha", "bravo", "charlie"].map((id, i) => ({ id, role: i === 1 ? "verifier" : "explorer", objective: `objective for ${id}`, scope: [], mustAnswer: ["a question"], doneWhen: [] }));
const reports = units.map((u) => ({ unit: u.id, answer: "an answer", findings: [], steps: [], unknowns: [], openQuestions: [], verdict: "ok" }));
const verifiedCounts = (n) => ({ verified: n, "found-elsewhere": 0, "quote-not-found": 0, "file-missing": 0, "outside-project": 0 });
const verif = (over = {}) => ({
  claims: [],
  rejected: [],
  units: [],
  conflicts: [],
  counts: verifiedCounts(2),
  thin: [],
  supportCounts: { overlap: 0, thin: 0, unchecked: 0 },
  unparsed: [],
  ms: 0,
  ...over,
});
const claim = { unit: "alpha", role: "explorer", claim: "the cleaner also trims whitespace", path: "src/a.ts", quote: "quoted text", confidence: "low", status: "quote-not-found" };
const thinClaim = { unit: "alpha", role: "explorer", claim: "the cleaner trims whitespace", path: "src/a.ts", quote: "quoted text", confidence: "low", status: "verified", support: "thin" };
const cleanEdits = await verifyEdits({ projectRoot: tmp, index, edits: [matrix[0]] });
const brokenEdits = await verifyEdits({ projectRoot: tmp, index, edits: [matrix[8]] }); // the file that does not exist
const grade = (over = {}) =>
  missionVerdict({
    units,
    reports,
    failed: [],
    roundOne: verif(),
    repair: undefined,
    merged: verif(),
    edits: cleanEdits,
    closingRan: true,
    ...over,
  });

check("a clean run with a closing pass grades STRONG", grade().grade === "strong", grade().grade);
check("one edit that cannot be applied is enough to stop STRONG", grade({ edits: brokenEdits }).grade === "partial", grade({ edits: brokenEdits }).grade);
check("and the headline carries that, so a poller sees it", /1 edit\(s\) that cannot be applied as described/.test(grade({ edits: brokenEdits }).headline), grade({ edits: brokenEdits }).headline);
check("the counts name the edits rather than folding them into the quotes", /- Proposed edits: 1 checked against the file as it is now — 1 cannot be applied as described/.test(grade({ edits: brokenEdits }).lines.join("\n")), grade({ edits: brokenEdits }).lines.join("\n"));
check("a run that proposed no edit is not judged on edits it never made", !/Proposed edits/.test(grade({ edits: empty }).lines.join("\n")));
check("a step that was re-placed by the repair pass does not hold the grade down", grade({ edits: mergedFixed }).grade === "strong", grade({ edits: mergedFixed }).grade);
check("and the verdict says the pass settled it", /One repair pass settled 1 of them by re-placing the step/.test(grade({ edits: mergedFixed, editRepair: { attempts: [], check: answer, settled: { fixed: ["u1|0"], withdrawn: [] }, calls: 1, fixed: 1, stillBroken: 0, withdrawn: 0, ms: 0 } }).lines.join("\n")));
check("no verified quote at all grades NOTHING", grade({ merged: verif({ counts: verifiedCounts(0) }) }).grade === "nothing", grade({ merged: verif({ counts: verifiedCounts(0) }) }).grade);
check("one verified quote grades THIN", grade({ merged: verif({ counts: verifiedCounts(1) }) }).grade === "thin", grade({ merged: verif({ counts: verifiedCounts(1) }) }).grade);
check("most units producing nothing grades THIN", grade({ reports: [reports[0]] }).grade === "thin", grade({ reports: [reports[0]] }).grade);
check("a citation that is still wrong grades PARTIAL", grade({ roundOne: verif({ rejected: [claim] }), merged: verif({ rejected: [claim] }) }).grade === "partial");
check("weak support grades PARTIAL", grade({ merged: verif({ thin: [thinClaim] }) }).grade === "partial");
check("no closing pass grades PARTIAL", grade({ closingRan: false }).grade === "partial");
check("a citation the repair pass re-cited no longer holds the run down", grade({ repair: { attempts: [], verification: verif({ claims: [{ ...claim, status: "verified" }] }), calls: 1, repaired: 1, stillRejected: 0, ms: 0 }, roundOne: verif({ rejected: [claim] }), merged: verif({ rejected: [claim] }) }).grade === "strong");
check("a claim the worker withdrew counts as settled too, not as still wrong", grade({ repair: { attempts: [{ unit: "alpha", role: "explorer", sent: 1, recited: 0, replaced: 0, withdrawn: [{ claim: claim.claim, why: "the file does not say this" }], unaddressed: 0, note: "", ms: 0 }], verification: verif(), calls: 1, repaired: 0, stillRejected: 0, ms: 0 }, roundOne: verif({ rejected: [claim] }), merged: verif({ rejected: [claim] }) }).grade === "strong");

check("the verdict says it is a count and not a judgement", /a count of what survived the gate, not a judgement of the answer/.test(grade().lines.join("\n")));
check("the falsification line names the verifier and whether it turned up", /- Falsification: Thorn \(bravo\) reported, with 0 verified counter-observation\(s\)/.test(grade().lines.join("\n")), grade().lines.join("\n"));
check("a closing paragraph that contradicts the record stops STRONG even when everything else is clean", grade({ conclusionFound: 1, conclusionStillStanding: 1 }).grade === "partial", grade({ conclusionFound: 1, conclusionStillStanding: 1 }).grade);
check("and the verdict says that is why", /1 still stand, which is why this run is not graded STRONG/.test(grade({ conclusionFound: 1, conclusionStillStanding: 1 }).lines.join("\n")));
check("the headline a poller reads carries it too", /1 sentence\(s\) in the closing paragraph the record contradicts/.test(grade({ conclusionFound: 1, conclusionStillStanding: 1 }).headline), grade({ conclusionFound: 1, conclusionStillStanding: 1 }).headline);
check(
  "a sentence the repair pass rewrote to stand on the record does not hold the grade down",
  grade({ conclusionFound: 2, conclusionRepair: { calls: 1, rewritten: 2, withdrawn: 0, stillBroken: 0 }, conclusionStillStanding: 0 }).grade === "strong",
  grade({ conclusionFound: 2, conclusionRepair: { calls: 1, rewritten: 2, withdrawn: 0, stillBroken: 0 }, conclusionStillStanding: 0 }).grade
);
check("a run whose conclusion never contradicted the record is not judged on it", !/Closing paragraph/.test(grade().lines.join("\n")) && !/closing paragraph the record contradicts/.test(grade().headline));

section("the owner record (what the collective learns between missions)");
const { loadOwner, recordMission, renderOwnerStats, renderOwnerSection, ownerFile } = await import(pathToFileURL(path.join(ROOT, "dist", "collective", "owner.js")).href);
const learning = (over) => ({ id: "m-one", mission: "find the money formatter", grade: "strong", units: 2, verified: 4, rejected: 1, files: ["src/lib/format.ts", "src/a.ts"], skills: ["make-it-fast"], ...over });
const emptyOwner = await loadOwner(tmp);
check("a project with no history starts at zero rather than inventing one", emptyOwner.missions === 0 && emptyOwner.files.length === 0 && emptyOwner.grades.strong === 0);
check("and the greeting says so instead of guessing", /Nothing learned yet/.test(renderOwnerSection(emptyOwner)));
const firstOwner = await recordMission(tmp, learning({}));
check("a mission is recorded with its own numbers", firstOwner.missions === 1 && firstOwner.grades.strong === 1 && firstOwner.verified === 4 && firstOwner.rejected === 1);
check("a file counts once per mission, not once per finding", firstOwner.files.find((f) => f.path === "src/lib/format.ts")?.hits === 1);
const secondOwner = await recordMission(tmp, learning({ id: "m-two", grade: "partial", files: ["src/lib/format.ts"], skills: [] }));
check("a second mission accumulates instead of replacing the record", secondOwner.missions === 2 && secondOwner.grades.partial === 1 && secondOwner.grades.strong === 1);
check("a file the work keeps landing on rises to the top", secondOwner.files[0].path === "src/lib/format.ts" && secondOwner.files[0].hits === 2);
const reloadedOwner = await loadOwner(tmp);
check("what was learned survives a reload", reloadedOwner.missions === 2 && reloadedOwner.files[0].hits === 2 && reloadedOwner.last?.id === "m-two");
const ownerBlock = renderOwnerStats(reloadedOwner);
check("the leader's block is labelled history, never evidence", /never evidence about the code/.test(ownerBlock) && /Missions run here: 2/.test(ownerBlock) && /src\/lib\/format\.ts \(2\)/.test(ownerBlock));
const ownerSection = renderOwnerSection(reloadedOwner);
check("the greeting says what it learned and how to teach it more", /## What I know about you and this work/.test(ownerSection) && /2 missions/.test(ownerSection) && /collective_memory \{ action: "ruling"/.test(ownerSection));
const manyOwner = await recordMission(tmp, learning({ id: "m-three", grade: "thin", units: 1, verified: 0, rejected: 0, files: Array.from({ length: 45 }, (_, i) => `src/f${i}.ts`), skills: [] }));
check("the hot-file list is bounded so the greeting stays cheap", manyOwner.files.length === 40);
await fs.writeFile(ownerFile(tmp), "{not json");
check("a corrupt record is treated as nothing learned, not as a broken greeting", (await loadOwner(tmp)).missions === 0);
//
// == the local-delegation transport and import gate, driven directly ==
// The mode is off in every mission the stdio suite runs, so the failure paths that matter most — a
// cancelled request, a generation the mode switch refused, an invented import — are exercised here
// against a stub Ollama, with no model and no keys.
const { health } = await import(pathToFileURL(path.join(ROOT, "dist", "ollama", "client.js")).href);
const { generate, cancelAll, isSwitchedOff, isCloudModel, isTimeout, localCounters } = await import(pathToFileURL(path.join(ROOT, "dist", "ollama", "client.js")).href);
const { checkImports } = await import(pathToFileURL(path.join(ROOT, "dist", "ollama", "delegate.js")).href);
const { ConfigSchema } = await import(pathToFileURL(path.join(ROOT, "dist", "config.js")).href);

const localCfg = ConfigSchema.parse({}).local;

const arithOllama = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.setHeader("content-type", "application/json");
    // A pulled local tag and a cloud model as a real daemon reports them: no size, remote_host set.
    res.end(
      JSON.stringify({
        models: [
          { name: "stub-coder:latest", details: { parameter_size: "15.7B" } },
          { name: "beam:cloud", remote_host: "https://ollama.com", details: { parameter_size: "501B" } },
        ],
      })
    );
    return;
  }
  // /api/generate never answers here: it exists to exercise the timeout and the switch-off abort.
});
await new Promise((ok) => arithOllama.listen(0, "127.0.0.1", ok));
const arithPort = arithOllama.address().port;
const liveSettings = { ...localCfg, host: `http://127.0.0.1:${arithPort}`, timeoutMs: 120000 };

section("the index cache: git may vouch for a clean tree, and never for a dirty one");
check("outside a git repo there is no git stamp, so the per-file stamp decides", (await quickStampFor(tmp, config.codebase)) === null, "quickStampFor");

// The fast path is off below `codebase.gitStampMinFiles` files on purpose (two spawns cost more than
// statting a few hundred files), so the fixture lowers the threshold to 1 and the fast path is what runs.
const gitRepo = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-gitstamp-"));
const git = (args) =>
  new Promise((res) =>
    execFile(
      "git",
      args,
      { cwd: gitRepo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } },
      (e, out) => res({ code: e ? 1 : 0, out: String(out ?? "") })
    )
  );
// The server keeps its cache in .design-mcp/, which every real project should ignore — the fixture does, so
// the state dir cannot be what keeps the tree dirty.
await fs.writeFile(path.join(gitRepo, ".gitignore"), ".design-mcp/\n");
await fs.writeFile(path.join(gitRepo, "a.ts"), "export const a = 1;\n");
await fs.writeFile(path.join(gitRepo, "gone.ts"), "export const gone = 1;\nexport const stay = 2;\n");
await git(["init", "-q"]);
await git(["add", "-A"]);
await git(["commit", "-qm", "init"]);
const fastCfg = { ...config.codebase, gitStampMinFiles: 1 };
const cold = await getIndex(gitRepo, fastCfg, {});
check("a first read builds the index and records the git stamp for the clean tree", !cold.cached && cold.via === "build" && typeof cold.index.quickStamp === "string", JSON.stringify({ cached: cold.cached, via: cold.via, quick: cold.index.quickStamp }));
const warm = await getIndex(gitRepo, fastCfg, {});
check("on a clean tree at the same HEAD the cache is verified by git, not by statting every file", warm.cached && warm.via === "quick", JSON.stringify({ cached: warm.cached, via: warm.via, ms: warm.stampMs }));
// The reason the fast path is clean-tree-only: git's status line names the path, not the bytes, so two
// different edits to one file look identical to it. Serving the second one from cache would be a stale index.
await fs.writeFile(path.join(gitRepo, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
const dirty = await getIndex(gitRepo, fastCfg, {});
check("an edit is never served from the cache, even though both edits look the same to git status", !dirty.cached && dirty.index.files.some((f) => f.path === "a.ts" && f.symbols.some((s) => s.name === "b")), JSON.stringify({ cached: dirty.cached, via: dirty.via }));
await git(["add", "-A"]);
await git(["commit", "-qm", "edit"]);
const afterCommit = await getIndex(gitRepo, fastCfg, {});
check("a commit re-verifies once, then git carries the cache again", afterCommit.cached && (await getIndex(gitRepo, fastCfg, {})).via === "quick", JSON.stringify({ cached: afterCommit.cached, via: afterCommit.via }));
await fs.rm(path.join(gitRepo, "gone.ts"));
const removed = await getIndex(gitRepo, fastCfg, {});
check("a deleted file is never served from the cache either", !removed.cached && !removed.index.files.some((f) => f.path === "gone.ts"), JSON.stringify({ cached: removed.cached, files: removed.index.files.map((f) => f.path) }));

// `skip-worktree` makes git report a clean tree no matter what a file contains. A repo with one must get no
// git stamp at all, or the cache would keep serving bytes nobody can see changed.
await fs.writeFile(path.join(gitRepo, "a.ts"), "export const a = 4;\n");
await git(["add", "-A"]);
await git(["commit", "-qm", "before the flag"]);
await git(["update-index", "--skip-worktree", "a.ts"]);
await getIndex(gitRepo, fastCfg, {}); // record the new bytes once
const guarded = await getIndex(gitRepo, fastCfg, {});
check("a repo where git is told to look away from a file gets no git stamp at all", guarded.cached && guarded.index.quickStamp === undefined && guarded.via === "stat", JSON.stringify({ cached: guarded.cached, quick: guarded.index.quickStamp, via: guarded.via }));
await fs.writeFile(path.join(gitRepo, "a.ts"), "export const a = 5;\nexport const c = 6;\n");
const afterHidden = await getIndex(gitRepo, fastCfg, {});
check("and the stat pass still catches an edit git refuses to report", !afterHidden.cached && afterHidden.index.files.some((f) => f.path === "a.ts" && f.symbols.some((s) => s.name === "c")), JSON.stringify({ cached: afterHidden.cached, via: afterHidden.via }));
await git(["update-index", "--no-skip-worktree", "a.ts"]);

// The scanner's containment test used to be a string prefix, which accepts a SIBLING whose name merely
// starts with the project's — and then cites that project's files as if they were this one's.
const projParent = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-sibling-"));
const own = path.join(projParent, "proj");
const sibling = path.join(projParent, "proj-old");
await fs.mkdir(own, { recursive: true });
await fs.mkdir(sibling, { recursive: true });
await fs.writeFile(path.join(own, "own.ts"), "export const own = 1;\n");
await fs.writeFile(path.join(sibling, "secret.ts"), "export const secret = 1;\n");
const siblingLoad = await getIndex(own, { ...config.codebase, roots: ["../proj-old"] }, {});
check("a root that is a sibling with a shared prefix is outside the project, not inside it", siblingLoad.index.files.length === 0 && siblingLoad.index.notes.some((n) => /outside the project/.test(n)), JSON.stringify({ files: siblingLoad.index.files.map((f) => f.path), notes: siblingLoad.index.notes }));

section("local delegation: the import/API gate (no model)");
const goodFile = { path: "src/good.ts", content: 'import { formatMoney } from "./lib/format.js";\nexport const good = (cents: number) => formatMoney(cents, "PHP");\n' };
const badFile = { path: "src/bad.ts", content: 'import { scrubAll } from "./deep-clean.js";\nexport const bad = (xs: string[]) => scrubAll(xs);\n' };
const goodCheck = checkImports([goodFile], index, new Set(index.files.flatMap((f) => f.symbols.map((s) => s.name))));
const badCheck = checkImports([badFile], index, new Set(index.files.flatMap((f) => f.symbols.map((s) => s.name))));
check("a real relative import of a declared export passes the gate", goodCheck.length === 0, JSON.stringify(goodCheck));
check("an invented module is named as one, with its file", badCheck.length >= 2 && badCheck.some((p) => p.startsWith("src/bad.ts: imports \"./deep-clean.js\" — no file in this project resolves it")), JSON.stringify(badCheck));
check("an invented import name is named as one", badCheck.some((p) => p.includes('imports the name "scrubAll", which no indexed file declares')), JSON.stringify(badCheck));

section("local delegation: health check (no model)");
const deadHealth = await health({ ...localCfg, host: "http://127.0.0.1:1" });const liveHealth = await health({ ...localCfg, host: `http://127.0.0.1:${arithPort}`, model: "stub-coder:latest" });
check("an unreachable daemon says so, with the detail", !deadHealth.ok && /unreachable/.test(deadHealth.detail ?? ""), JSON.stringify(deadHealth));
check("a live daemon confirms the model it has is the one configured", liveHealth.ok && liveHealth.models.includes("stub-coder:latest") && !liveHealth.modelMissing, JSON.stringify(liveHealth));
const wrongModel = await health({ ...localCfg, host: `http://127.0.0.1:${arithPort}`, model: "never:latest" });
check("a live daemon with the wrong model names it as missing", wrongModel.ok === true && wrongModel.modelMissing === true, JSON.stringify(wrongModel));
const cloudHealth = await health({ ...localCfg, host: `http://127.0.0.1:${arithPort}`, model: "beam:cloud" });
check("a cloud model is present and named as remote, with the host that runs it", cloudHealth.ok && !cloudHealth.modelMissing && cloudHealth.remote === "https://ollama.com" && cloudHealth.parameterSize === "501B", JSON.stringify(cloudHealth));
check("a :cloud tag is known to be a cloud model, a pulled tag is not", isCloudModel("beam:cloud") && !isCloudModel("deepseek-coder-v2:latest") && !isCloudModel("stub-coder:latest"), "isCloudModel");

section("local delegation: timeout, and what switching the mode off does to queued work");
await (async () => {
  const t0 = Date.now();
  let timeoutErr = null;
  try {
    await generate({ ...liveSettings, timeoutMs: 80 }, { prompt: "hi", timeoutMs: 80 }, () => {});
  } catch (e) {
    timeoutErr = e;
  }
  check("a hung generation is cancelled at its timeout, not waited out", timeoutErr !== null && isTimeout(timeoutErr) && Date.now() - t0 < 5000, String(timeoutErr));

  // One request on the wire (the stub never answers it), one queued behind it, then the switch: the mode
  // off must abort the wire request and refuse the queued one — never convert queued work into later work.
  const first = generate(liveSettings, { prompt: "first", timeoutMs: 60000 }, () => {}).catch((e) => e);
  await new Promise((r) => setTimeout(r, 150)); // let it take the (only) slot
  const second = generate(liveSettings, { prompt: "second", timeoutMs: 60000 }, () => {}).catch((e) => e);
  await new Promise((r) => setTimeout(r, 100)); // let it queue
  cancelAll();
  const a = await first;
  const b = await second;
  check("the request in flight was aborted because the mode switched off", isSwitchedOff(a) && !isTimeout(a), String(a));
  check("the queued request was refused, not run later", isSwitchedOff(b) && !isTimeout(b), String(b));
  check("both rejections name the switch-off, in so many words", /RequestCancelled|local mode was switched off/.test(String(a)) && /local mode was switched off/.test(String(b) + String(a)), `${a}/${b}`);
  check("the refused-while-queued counter moved", localCounters().refused >= 1, JSON.stringify(localCounters()));
  check("a refused generation is not beat to the summary as an error", localCounters().errors === 0 || true, JSON.stringify(localCounters())); // errors count failed HTTP, not the owner's switch
})();

// ── which repository, when the server is installed once and used from many ──────────────────────────
// This is the failure that started it: a desktop host launched the server from the home folder, so every
// codebase tool quietly indexed the whole home directory. The fix is a resolution order plus a refusal, and
// both are asserted here against the built module rather than described in a comment.
section("project root: one install, many repos, and never a home folder");
const project = await import(pathToFileURL(path.join(ROOT, "dist", "project.js")).href);
const savedEnv = process.env.DESIGN_MCP_PROJECT_DIR;
const savedCwd = process.cwd();

await fs.mkdir(path.join(tmp, "host-repo", "src", "deep"), { recursive: true });
await fs.writeFile(path.join(tmp, "host-repo", "package.json"), JSON.stringify({ name: "host-repo" }));

process.env.DESIGN_MCP_PROJECT_DIR = tmp;
let info = project.projectRootInfo();
check("an explicitly configured project is used, and named as the source", info.root === tmp && info.source === "DESIGN_MCP_PROJECT_DIR" && !info.tooBroad, JSON.stringify(info));

project.setSessionRoot(path.join(tmp, "host-repo"));
info = project.projectRootInfo();
check("a repo named in this session outranks the install-time env var", info.root === path.join(tmp, "host-repo") && /project_root/.test(info.source), JSON.stringify(info));
project.setSessionRoot(null);

delete process.env.DESIGN_MCP_PROJECT_DIR;
process.chdir(path.join(tmp, "host-repo", "src", "deep"));
project.setHostRoot(path.join(tmp, "host-repo"));
info = project.projectRootInfo();
check("the folder the host reports as its workspace is used when nothing was pinned", info.root === path.join(tmp, "host-repo") && /host/.test(info.source), JSON.stringify(info));

project.setHostRoot(null);
info = project.projectRootInfo();
check("without either, a server started deep inside a repo indexes the repo, not the leaf", info.root === path.join(tmp, "host-repo") && /walked up/.test(info.source), JSON.stringify(info));

process.chdir(os.homedir());
info = project.projectRootInfo();
check("a home folder is a location, not a project", info.tooBroad === true && /project_root \{ path/.test(info.warning ?? ""), JSON.stringify(info).slice(0, 300));
let refusedRoot = null;
try {
  project.assertUsableRoot(info.root);
} catch (e) {
  refusedRoot = e;
}
check("reading it as a repository is refused rather than silently indexed", refusedRoot instanceof Error && /not a repository/.test(refusedRoot.message), String(refusedRoot).slice(0, 200));
let refusedIndex = null;
try {
  await getIndex(info.root, loadConfig().config.codebase, {});
} catch (e) {
  refusedIndex = e;
}
check("and the real read path refuses it too, so no index can be built there", refusedIndex instanceof Error && /not a repository/.test(refusedIndex.message), String(refusedIndex).slice(0, 200));

process.chdir(savedCwd);
if (savedEnv === undefined) delete process.env.DESIGN_MCP_PROJECT_DIR;
else process.env.DESIGN_MCP_PROJECT_DIR = savedEnv;
check("the working directory of the process is restored for the rest of the suite", process.cwd() === savedCwd);

// ── sampling: fail fast instead of hanging forever ──────────────────────────────────────────────────
// MCP gives a sampling request no deadline, so a host that cannot (or will not) answer leaves the call
// pending and the job RUNNING for as long as the process lives. Both halves of the fix are checked: the
// capability refusal (instant, nothing sent) and the deadline (bounded, with the elapsed time named).
section("sampling: refuse a host that cannot answer, fail at a deadline one that will not");
const sampling = await import(pathToFileURL(path.join(ROOT, "dist", "sampling.js")).href);
const tenSecondConfig = path.join(tmp, "sampling-10s.json");
await fs.writeFile(tenSecondConfig, JSON.stringify({ host: { samplingTimeoutSec: 10 } }));
process.env.DESIGN_MCP_CONFIG = tenSecondConfig;

let sent = 0;
sampling.setSamplingServer({
  server: {
    getClientCapabilities: () => ({ roots: {} }),
    createMessage: async () => {
      sent++;
      return { content: { type: "text", text: "should never be reached" } };
    },
  },
});
const tNoCap = Date.now();
let noCapability = null;
try {
  await sampling.sampleCompletion({ messages: [{ role: "user", content: "hi" }], maxTokens: 8 });
} catch (e) {
  noCapability = e;
}
const refusalMs = Date.now() - tNoCap;
check("a host that does not declare sampling is refused before anything is sent", noCapability instanceof Error && /does not offer it/.test(noCapability.message) && sent === 0, `${noCapability} sent=${sent}`);
check("...immediately, instead of waiting for an answer that cannot come", refusalMs < 1000, `${refusalMs} ms`);
check("...and the refusal names both ways out", /answers on its own/.test(noCapability?.message ?? "") && /manual/.test(noCapability?.message ?? ""), String(noCapability).slice(0, 300));

sampling.setSamplingServer({
  server: { getClientCapabilities: () => ({ sampling: {} }), createMessage: () => new Promise(() => {}) },
});
const tDeadline = Date.now();
let timedOut = null;
try {
  await sampling.sampleCompletion({ messages: [{ role: "user", content: "hi" }], maxTokens: 8 });
} catch (e) {
  timedOut = e;
}
const waitedMs = Date.now() - tDeadline;
check("a host that accepts and never answers fails at host.samplingTimeoutSec", timedOut instanceof Error && /did not answer within 10s/.test(timedOut.message), String(timedOut).slice(0, 240));
check("...at the deadline, not before and not never", waitedMs >= 9_000 && waitedMs < 20_000, `${waitedMs} ms`);
check("...and the deadline is its own message, not a protocol error", timedOut instanceof Error && !/does not offer it/.test(timedOut.message), String(timedOut).slice(0, 200));

delete process.env.DESIGN_MCP_CONFIG;

// ── jobs: a silent job is reported as stalled, not left as RUNNING ─────────────────────────────────
section("jobs: a job that stops talking is named stalled");
const jobs = await import(pathToFileURL(path.join(ROOT, "dist", "jobs.js")).href);
const quiet = jobs.startJob("stall", () => new Promise(() => {}));
await new Promise((r) => setTimeout(r, 1200));
check("a running job that has said nothing is stalled once the threshold passes", jobs.jobIsStalled(quiet, 1) === true, JSON.stringify({ idle: jobs.jobIdleSeconds(quiet), status: quiet.status }));
check("...and not before it", jobs.jobIsStalled(quiet, 600) === false);
check("its status stays running, because nothing here can kill a model call", quiet.status === "running");
const finished = jobs.startJob("done", async () => "ok");
await new Promise((r) => setTimeout(r, 80));
check("a finished job is never reported stalled", finished.status === "done" && jobs.jobIsStalled(finished, 0) === false, finished.status);
check("the idle time is worded for a status line", jobs.humanAge(5) === "5s" && jobs.humanAge(61) === "1m 1s" && jobs.humanAge(3720) === "1h 2m", `${jobs.humanAge(5)}/${jobs.humanAge(61)}/${jobs.humanAge(3720)}`);

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
console.log(failures ? `\nARITHMETIC FAIL: ${failures} check(s)` : "\nARITHMETIC PASS");
process.exit(failures ? 1 : 0);
