// Smoke test for design-mcp. Exercises the server over stdio with no API keys:
// Lists tools, runs providers_config, the brief workflow, and every graceful
// error path (no concepts, no jobs, no reports, no variations). Any real API
// call would fail here on missing keys, so none is attempted.
//
// Run: npm run build && npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (label, cond, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${extra ? ` -> ${extra}` : ""}`); }
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-smoke-"));
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(ROOT, "dist", "index.js")],
  env: { ...process.env, DESIGN_MCP_PROJECT_DIR: tmp },
  stderr: "ignore",
});
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: { sampling: {} } });

// The fixture repo the codebase layer indexes. Written before anything is called.
const FIXTURE = {
  "src/util.ts": [
    "export function normalise(input: string): string {",
    "  return input.trim().toLowerCase();",
    "}",
    "",
    "export const LIMIT = 40;",
    "",
    "export function truncate(input: string): string {",
    "  return input.slice(0, LIMIT);",
    "}",
  ].join("\n"),
  "src/leaky.ts": [
    'import { normalise } from "./util.js";',
    "",
    "export const clean = (raw: string) => normalise(raw);",
  ].join("\n"),
  // A tsconfig with the aliases every modern TS repo has, and one file importing through one. Without
  // resolution this import looks like a package named "@app/util" and the edge disappears from the graph.
  "tsconfig.json": [
    "{",
    '  "compilerOptions": {',
    '    "baseUrl": ".",',
    '    "paths": { "@app/*": ["src/*"], "@notes": ["notes.md"] },',
    '    "strict": true,',
    "  },",
    "}",
  ].join("\n"),
  "src/alias-user.ts": [
    'import { normalise } from "@app/util";',
    "",
    "export const viaAlias = (raw: string) => normalise(raw);",
  ].join("\n"),
  "notes.md": "# Fixture notes\n\nThe fixture exists so the index has something real to read. normalise() is the only cleaner in it.\n",
  // A skill the owner installed, in the project-local root the defaults look in. The smoke suite proves it
  // is discovered, readable, and that its text really lands in a worker's prompt when a unit is assigned it.
  ".claude/skills/make-it-fast/SKILL.md": [
    "---",
    "name: make-it-fast",
    "description: A fixture skill the smoke suite uses to prove skill text reaches a worker's prompt.",
    "---",
    "",
    "# Make it fast",
    "",
    "SKILL-BODY-MARKER: measure first, then optimise, then measure again.",
    "",
  ].join("\n"),
};
for (const [rel, text] of Object.entries(FIXTURE)) {
  await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
  await fs.writeFile(path.join(tmp, rel), text);
}

// A stub Ollama daemon. `/api/tags` answers the health check; `/api/generate` answers the delegated
// units. Its behaviour is policy-driven so the suite can run the same mission twice and get failure
// first, applied second — which is exactly what the one-retry-then-take-over rule is about.
const ollamaPolicy = { mode: "bad-import" }; // "bad-import" | "good"
const ollamaRequests = [];
// Good output: imports a real export of the fixture, compiles under strict, uses no new dependency.
const GOOD_HELPER = [
  'import { normalise } from "./util.js";',
  "",
  "export function normaliseAll(inputs: string[]): string {",
  "  return inputs.map((input) => normalise(input)).join(\" \");",
  "}",
].join("\n");
// Bad output: invents a module (`./deep-clean.js`) and an unused-name import (`scrubAll`) — exactly what
// the mechanical import/API check exists to reject without asking any model.
const BAD_HELPER = [
  'import { scrubAll } from "./deep-clean.js";',
  "",
  "export function normaliseAll(inputs: string[]): string {",
  "  return scrubAll(inputs).join(\" \");",
  "}",
].join("\n");
const ollamaServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    ollamaRequests.push({ url: req.url, body });
    const parsed = body ? JSON.parse(body) : {};
    if (req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "stub-coder:latest" }, { name: "qwen2.5-coder:7b" }] }));
      return;
    }
    if (req.url === "/api/generate") {
      res.setHeader("content-type", "application/json");
      const files = [{ path: "src/extra-cleaner.ts", content: ollamaPolicy.mode === "good" ? GOOD_HELPER : BAD_HELPER }];
      res.end(JSON.stringify({ response: JSON.stringify({ files }) }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
    void parsed;
  });
});
await new Promise((ok) => ollamaServer.listen(0, "127.0.0.1", ok));
const ollamaPort = ollamaServer.address().port;

// A stub host that answers the way Cursor/Freebuff would: it recognises a leader call, a worker call and
// a synthesis call, and it deliberately includes one invented quote so the server has something to reject.
const INVENTED_QUOTE = "const cache = new Map<string, string>();";
// A quote that really is in the file, attached to a claim it has nothing to do with: the thin-support case.
// Armed only for the second mission, so the first one stays a clean run.
const THIN_CLAIM = "the retry budget aborts after three attempts and the queue drains on shutdown";
let thinArmed = false;
// The closing paragraph with two sentences that contradict the mission's own record: one asserts the finding
// the gate deleted as a fact, one names a file that is not in the repository. Armed only for the two missions
// that exist to exercise the conclusion gate, so the first two stay clean runs.
let closingArmed = false;
// The conclusion repair answers by number, one sentence each way: the first is rewritten into wording that
// restates the rejection instead of asserting it, the second is given up with a reason.
const conclusionRepairAnswer = () => ({
  note: "rewrote the first against the record and gave the second up",
  fixed: [{ fixes: 1, text: "The claim that truncate() slices its input to a fixed limit was rejected by the server and is carried as unverified." }],
  dropped: [{ fixes: 2, why: "the file list has no src/cleaner-core.ts, so I cannot say where the rewrite lives" }],
});
// Every prompt the server sent, so the suite can prove what actually reached the models.
const seenPrompts = [];
const peerResponse = (unit) => ({
  unit,
  stance: "rebut",
  responses: [
    {
      to: "explore-util",
      verdict: "rebut",
      reason: "the limit is applied before the trim, so truncate() cannot overshoot",
      path: "src/util.ts",
      lines: [7, 7],
      quote: FIXTURE["src/util.ts"].split("\n")[6],
    },
    { to: "verify-util", verdict: "rebut", reason: "I believe there is a second cleaner somewhere but I could not find it in what I was given" },
  ],
  changed: "nothing",
  dissent: ["nothing in the file pins case folding to ASCII"],
  revisedAnswer: "Round two: I stand by my findings and add that the trim order matters.",
});
const workerReport = (unit) => ({
  unit,
  answer: `Report for ${unit}: normalise() trims and lowercases its input, and it is exported from src/util.ts.`,
  findings: [
    { claim: "normalise() is exported from src/util.ts", path: "src/util.ts", lines: [1, 1], quote: FIXTURE["src/util.ts"].split("\n")[0], confidence: "high" },
    { claim: "truncate() slices its input to a fixed limit", path: "src/util.ts", lines: [8, 8], quote: INVENTED_QUOTE, confidence: "low" },
    ...(thinArmed && unit === "ghost" ? [{ claim: THIN_CLAIM, path: "src/util.ts", lines: [5, 5], quote: FIXTURE["src/util.ts"].split("\n")[4], confidence: "medium" }] : []),
  ],
  // The work each unit proposes, so the edit gate has something real to check: one anchored edit, one
  // anchor that occurs three times with no line range to disambiguate it, one real anchor cited at stale
  // lines, and one edit in the file the leader invented.
  steps:
    unit === "explore-util"
      ? [
          { path: "src/util.ts", intent: "Reuse the exported cleaner instead of adding a second one", anchor: "export function normalise", lines: [1, 1], risk: "low" },
          { path: "src/util.ts", intent: "Tidy the shared limit constant", anchor: "export", risk: "medium" },
        ]
      : unit === "verify-util"
        ? [
            { path: "src/leaky.ts", intent: "Route this file through the one cleaner", anchor: "import { normalise } from", lines: [3, 3], risk: "medium" },
            { path: "src/leaky.ts", intent: "Rename the cleaner from the call site that uses it", anchor: "normalise", lines: [3, 3], risk: "low" },
          ]
        : [{ path: "src/does-not-exist.ts", intent: "Put the new cleaner in the file the leader invented", anchor: "export const cleaner", lines: [1, 1], risk: "high" }],
  unknowns: ["whether callers depend on the exact casing"],
  openQuestions: [],
  verdict: "ok",
});
// The repair pass, answered three different ways, because the three answers are not the same thing:
// explore-util re-cites its own claim against the line that says it, verify-util withdraws the claim and says
// the code does not make it, and ghost offers a different finding while never addressing the one it was asked
// about. Every branch of the pass is therefore exercised, and the suite can tell them apart by name.
const RECITED_CLAIM = "truncate() slices its input to a fixed limit";
const repairAnswer = (unit) => ({
  unit,
  note: "re-cited what I could and withdrew what the file does not say",
  findings:
    unit === "verify-util"
      ? []
      : [
          unit === "explore-util"
            ? { claim: RECITED_CLAIM, path: "src/util.ts", lines: [8, 8], quote: FIXTURE["src/util.ts"].split("\n")[7], confidence: "high" }
            : { claim: "the file exports a single limit constant that both functions read", path: "src/util.ts", lines: [5, 5], quote: FIXTURE["src/util.ts"].split("\n")[4], confidence: "medium" },
        ],
  dropped:
    unit === "verify-util"
      ? [{ claim: RECITED_CLAIM, why: "the file caps the slice at LIMIT but never says the limit is enforced anywhere else" }]
      : [],
});

client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
  const answer = (text) => ({ role: "assistant", content: { type: "text", text }, model: "smoke-model" });
  // MCP sampling sends each message's content as an array of parts, and the system prompt separately.
  const textOf = (m) =>
    Array.isArray(m?.content)
      ? m.content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n")
      : typeof m?.content?.text === "string"
        ? m.content.text
        : typeof m?.content === "string"
          ? m.content
          : "";
  const prompt = [req.params?.systemPrompt ?? "", ...(req.params?.messages ?? []).map(textOf)].join("\n");
  seenPrompts.push(prompt);
  const unit = prompt.match(/YOUR UNIT: ([a-z0-9-]+)/);
  // Round two and the repair pass both carry the same "YOUR UNIT:" line, so they are recognised first.
  // The edit repair pass comes first because it is the more specific call: both repair prompts say "REPAIR
  // PASS", and a host that answered the wrong one would fail the schema rather than the intent. Answered
  // three different ways for the same reason the citation repair is: the outcomes are not the same thing.
  // One source re-places its step against a real line, one withdraws it and says why, and one returns a step
  // that still does not land — which the gate must catch again.
  if (/AN EDIT THAT COULD NOT BE PLACED/.test(prompt)) {
    const who = prompt.match(/AN EDIT THAT COULD NOT BE PLACED — ([a-z0-9-]+|the closing plan)/)?.[1] ?? "";
    return answer(
      JSON.stringify(
        who === "explore-util"
          ? { note: "re-placed against the limit constant, which is really in the file", steps: [{ fixes: 1, path: "src/util.ts", intent: "Tidy the shared limit constant", anchor: "export const LIMIT", lines: [5, 5], risk: "medium" }], dropped: [] }
          : who === "verify-util"
            ? { note: "I cannot place this one honestly", steps: [], dropped: [{ fixes: 1, why: "the file I was given has no such import line; I would need the file that writes it" }] }
            : { note: "moved it to the caller", steps: [{ fixes: 1, path: "src/alias-user.ts", intent: "Put the cleaner in the caller instead", anchor: "export function viaAlias", lines: [1, 1], risk: "high" }], dropped: [] }
      )
    );
  }
  // The conclusion repair addresses the leader, not a unit, and its marker is its own: it is answered first
  // so a host cannot mistake it for a closing pass or for one of the other two repairs.
  if (/A CONCLUSION THE RECORD CONTRADICTS/.test(prompt)) return answer(JSON.stringify(conclusionRepairAnswer()));
  if (/REPAIR PASS/.test(prompt)) return answer(JSON.stringify(repairAnswer(unit?.[1] ?? "explore-util")));
  // The council spec review of LOCAL output: the audit ladder's last step, one call, pass/fail by decision.
  // The suite's deterministic failure path comes from the import check, so this review passes when it runs.
  // The prompt now names the model it is reviewing (stub-coder:latest here, which is not a cloud tag).
  if (/You review code a small local model \(stub-coder:latest\) wrote\./.test(prompt)) return answer(JSON.stringify({ decision: "pass", issues: [] }));
  if (/now reading what the other copies of yourself found/.test(prompt)) return answer(JSON.stringify(peerResponse(unit?.[1] ?? "explore-util")));
  if (unit) return answer(JSON.stringify(workerReport(unit[1])));
  // The LOCAL mission's plan: an implementer unit explicitly offered to the local model ("local": true)
  // plus one verifier, so the audit ladder and the verdict's other machinery both have something to do.
  if (/You are the LEADER/.test(prompt) && /normaliseAll/.test(prompt)) {
    return answer(
      JSON.stringify({
        restated: "Add a normaliseAll() helper beside the existing normalise() export.",
        risks: [],
        assumptions: [],
        unknowns: [],
        units: [
          { id: "write-helper", role: "implementer", objective: "Write the normaliseAll() helper for src/util.ts (LOCAL UNIT).", scope: ["src/util.ts"], mustAnswer: ["what does normaliseAll([' A ',' b ']) return?"], doneWhen: ["the helper is exported and the existing cleaner is reused", "normaliseAll([\" A \",\"b\"]) === \"a b\""], local: true },
          { id: "check-helper", role: "verifier", objective: "Try to falsify the claim that normalise() is the only place input is cleaned.", scope: ["src/leaky.ts"], mustAnswer: ["who else cleans input?"], doneWhen: [] },
        ],
      })
    );
  }
  if (/You are the LEADER/.test(prompt) && /"units"/.test(prompt)) {
    return answer(
      JSON.stringify({
        restated: "Make src/util.ts's normalise() the one place that cleans user input in this repo.",
        risks: ["other callers may rely on the current casing"],
        assumptions: ["the repo has no other input cleaner"],
        unknowns: ["what the deletion policy is for anonymous accounts"],
        units: [
          { id: "explore-util", role: "explorer", objective: "Report exactly what normalise() does today, and which files call it.", scope: ["src/util.ts"], mustAnswer: ["what does normalise(' Foo ') return?"], doneWhen: [], skill: "make-it-fast" },
          { id: "verify-util", role: "verifier", objective: "Try to falsify the claim that normalise() is the only place input is cleaned.", scope: ["src/leaky.ts"], mustAnswer: ["who else cleans input?"], doneWhen: [], skill: "a-skill-that-was-never-installed" },
          { id: "ghost", role: "architect", objective: "Design the change inside a file the leader invented from nothing.", scope: ["src/does-not-exist.ts"], mustAnswer: ["where would the edit go?"], doneWhen: [] },
        ],
      })
    );
  }
  if (/closing the mission/.test(prompt)) {
    return answer(
      JSON.stringify({
        answer: closingArmed
          ? "The leak is fixed, because truncate() slices its input to a fixed limit. The rewrite is already in src/cleaner-core.ts. The claim about the limit was rejected by the server and is carried as unverified."
          : "One exported cleaner exists (src/util.ts). The claim about truncate()'s limit was rejected by the server and is carried as unverified.",
        plan: [{ step: "Route new cleaning through the existing export", path: "src/util.ts", intent: "Reuse normalise() instead of adding a second cleaner", anchor: "export function normalise", lines: [1, 1], risk: "low" }],
        risks: [],
        unverified: ["whether truncate() slices to the limit it is written against"],
        firstAction: "Read src/util.ts around the exported function before editing.",
        definitionOfDone: ["npm test passes"],
      })
    );
  }
  return answer("ready (smoke sampling)");
});
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.map((c) => (c.text ?? "")).join("\n") };
};

try {
  console.log("== tools/list ==");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "brief_check", "brief_init", "concepts_generate", "concepts_review", "design_build", "design_critique", "design_report",
    "design_status", "design_test", "manual_answer", "manual_pending", "providers_config", "providers_test", "sequence_extract", "usage_report",
    // design playbook (offline knowledge + deterministic checks)
    "antislop_check", "critique_rubric", "design_playbook", "motion_pattern", "palette_check", "playbook_topics",
    // the codebase layer (ground truth, no model) and the collective
    "code_index", "code_digest", "code_context", "code_refs", "code_verify_cites", "code_verify_edits", "collective_plan", "collective_run", "collective_report", "collective_memory",
    // waking the collective, the owner's own skills, and which repo this session is actually on
    "collective_hello", "collective_install", "skills_list", "skills_read", "project_root",
    // the optional local-model delegation (off by default: zero Ollama calls until local_mode flips it on)
    "local_mode",
    // hands for the local model: config-gated, project-confined, diff-gated (off by default)
    "agent_run",
  ];
  // Computed, not typed: a hardcoded number in this label has already drifted from the list twice.
  check(`${expected.length} tools registered (${names.length} found)`, names.length === expected.length, names.join(","));
  check("all expected tools present", expected.every((n) => names.includes(n)));

  console.log("== resources + prompts (the playbook is addressable, not only callable) ==");
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  check("18 resources registered", resources.length === 18, uris.join(","));
  check("one resource per playbook topic", ["motion", "scroll", "organic", "typography", "color", "layout", "floor", "rubric", "slop"].every((t) => uris.includes(`design://playbook/${t}`)));
  check("rubric sections resource exists", uris.includes("design://rubric/sections"));
  check(
    "the codebase resources exist",
    ["code://digest", "code://map", "code://graph", "code://conventions", "code://focus", "code://memory", "code://skills"].every((u) => uris.includes(u)),
    uris.join(",")
  );
  const digestRes = await client.readResource({ uri: "code://digest" });
  check(
    "code://digest reads back a computed map of the project",
    !!digestRes.contents?.[0]?.text?.includes("src/util.ts") && !!digestRes.contents?.[0]?.text?.includes("1 export function normalise"),
    digestRes.contents?.[0]?.text?.slice(0, 200)
  );
  const readMotion = await client.readResource({ uri: "design://playbook/motion" });
  check("reading a resource returns its content", !!readMotion.contents?.[0]?.text?.includes("Motion"), readMotion.contents?.[0]?.text?.slice(0, 80));
  const { prompts } = await client.listPrompts();
  check("5 prompts registered", prompts.length === 5, prompts.map((p) => p.name).join(","));
  check(
    "premium_pass, motion_review, collective_mission, focus_contract and hello_collective present",
    ["premium_pass", "motion_review", "collective_mission", "focus_contract", "hello_collective"].every((p) => prompts.some((x) => x.name === p))
  );
  const gotPrompt = await client.getPrompt({ name: "premium_pass", arguments: { target: "a landing page" } });
  check("premium_pass embeds the rubric", !!gotPrompt.messages?.[0]?.content?.text?.includes("CRITIQUE RUBRIC"));

  console.log("== design playbook (offline knowledge, no keys) ==");
  const idx = await call("playbook_topics");
  check("playbook_topics lists every topic", !idx.error && ["motion", "scroll", "organic", "typography", "color", "layout", "floor", "rubric", "slop"].every((t) => idx.text.includes(t)), idx.text.slice(0, 120));
  const topic = await call("design_playbook", { topic: "motion" });
  check("design_playbook reads a topic", !topic.error && topic.text.includes("easing-by-role"), topic.text.slice(0, 100));
  const scroll = await call("design_playbook", { topic: "scroll" });
  check("the scroll topic covers techniques, cost and degradation", !scroll.error && ["scrub-sequence-canvas", "css-scroll-timelines", "scroll-scene-floor", "prefers-reduced-motion"].every((s) => scroll.text.includes(s)), scroll.text.slice(0, 120));
  const scrollEntry = await call("design_playbook", { entry: "scrub-sequence-canvas" });
  check("a scroll entry states the decoded-memory cost", !scrollEntry.error && /width × height × 4|MiB/.test(scrollEntry.text), scrollEntry.text.slice(0, 120));
  const byEntry = await call("design_playbook", { entry: "displacement-ripples" });
  check("design_playbook fetches an entry by id", !byEntry.error && byEntry.text.includes("Sources:"), byEntry.text.slice(0, 100));
  check("entries show their sources and licences", /\[.*\]/.test(byEntry.text) && /http/.test(byEntry.text));
  const byQuery = await call("design_playbook", { query: "soft palette contrast" });
  check("design_playbook searches several terms", !byQuery.error && /match\(es\)/.test(byQuery.text), byQuery.text.slice(0, 120));
  const noHit = await call("design_playbook", { query: "zzzz-nothing" });
  check("a search with no match explains itself without erroring", !noHit.error && noHit.text.includes("Nothing in the playbook matched"), noHit.text.slice(0, 120));
  const badEntry = await call("design_playbook", { entry: "nope" });
  check("an unknown entry id errors cleanly", badEntry.error && badEntry.text.includes("playbook_topics"));
  const pat = await call("motion_pattern", { need: "a group of cards should arrive together" });
  check("motion_pattern always returns the reduced-motion contract", !pat.error && pat.text.includes("reduced-motion-contract"), pat.text.slice(0, 120));
  const rubric = await call("critique_rubric");
  check("critique_rubric returns 11 weighted sections summing to 100", !rubric.error && /weights sum 100/.test(rubric.text) && (rubric.text.match(/\n## /g) || []).length === 11);
  const oneSection = await call("critique_rubric", { focus: "depth-and-layering", how: true });
  check(
    "critique_rubric can focus one section and add the how-to",
    !oneSection.error && oneSection.text.includes("# Depth and layering") && oneSection.text.includes("one-bold-idea") && !oneSection.text.includes("## First impression"),
    oneSection.text.slice(0, 120)
  );
  const badFocus = await call("critique_rubric", { focus: "nope" });
  check("an unknown rubric section errors cleanly", badFocus.error && badFocus.text.includes("Existing:"));

  console.log("== palette_check (deterministic contrast + softness) ==");
  const good = await call("palette_check", { colours: ["#F7F5FB", "#E9E6F3", "#2B2742", "#5B58C9"] });
  check("a working palette reports AA body contrast", !good.error && good.text.includes("AA body"), good.text.slice(0, 140));
  check("it classifies surfaces, inks and accents", !good.error && /surface/.test(good.text) && /ink\b/.test(good.text) && /accent/.test(good.text));
  const harsh = await call("palette_check", { colours: ["#F4FF00", "#0018FF"] });
  check("a harsh high-chroma pair is called out", !harsh.error && /harsh/i.test(harsh.text), harsh.text.slice(0, 160));
  const purple = await call("palette_check", { colours: ["#F7F5FB", "#8B5CF6"] });
  check("a violet in the purple band (hue 250-295) is flagged", !purple.error && /purple\/indigo/.test(purple.text), purple.text.slice(0, 160));
  // Tailwind's indigo-500 sits just below that band (hue ~239), so it must be caught by the harshness rule instead.
  const indigo = await call("palette_check", { colours: ["#F7F5FB", "#2B2742", "#6366F1"] });
  check("indigo-500 #6366F1 is caught as a harsh field", !indigo.error && /harsh/i.test(indigo.text), indigo.text.slice(0, 160));
  const notHex = await call("palette_check", { colours: ["#FFF", "rgb(1,2,3)"] });
  check("non-hex input errors cleanly", notHex.error && notHex.text.includes("#RRGGBB"));
  // A muted grey that is 4.34:1 on its own field must be reported as failing for body text.
  const muted = await call("palette_check", { colours: ["#E9E6F3", "#2B2742", "#6C6788"] });
  check("a muted grey below 4.5:1 is reported as not AA body", !muted.error && /#6C6788 on #E9E6F3: 4\.3\d:1 — AA large\/UI only/.test(muted.text), muted.text.slice(0, 200));
  const mutedFixed = await call("palette_check", { colours: ["#E9E6F3", "#2B2742", "#615C7D"] });
  check("darkening that grey past 4.5:1 clears it", !mutedFixed.error && !/Problems:\n  - /.test(mutedFixed.text), mutedFixed.text.slice(0, 200));
  // A tinted paper at 97% lightness is a decision, not the neutral near-white the warning targets.
  const tintedPaper = await call("palette_check", { colours: ["#F7F5FB", "#2B2742"] });
  check("a hue-biased paper is not flagged as pure white", !tintedPaper.error && !/near white|near-white/.test(tintedPaper.text), tintedPaper.text.slice(0, 200));
  const pure = await call("palette_check", { colours: ["#FFFFFF", "#000000"] });
  check("true white/black still flagged", !pure.error && /neutral near-white/.test(pure.text), pure.text.slice(0, 200));
  check("no meaningless accent-on-accent pairs are reported", !muted.error && !/#615C7D on #4F4CA8|#6C6788 on #615C7D/.test(muted.text));

  console.log("== antislop_check (source scanning) ==");
  const sloppy = await call("antislop_check", {
    text: [
      "h1 { font-family: Inter, sans-serif; background: linear-gradient(90deg,#6366f1,#a855f7); border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,.2); }",
      "<p>Welcome to our platform. Unlock the power of seamless workflows.</p>",
      "<div class='avatar'>Lorem ipsum</div>",
    ].join("\n"),
  });
  check("a slop snippet produces findings", !sloppy.error && /match\(es\)/.test(sloppy.text), sloppy.text.slice(0, 140));
  check("findings carry a line number and a better move", !sloppy.error && /line 1/.test(sloppy.text) && /instead:/.test(sloppy.text));
  check("banned typeface and cliche copy are both caught", !sloppy.error && /banned|font/i.test(sloppy.text) && /welcome|unlock|cliche|lorem/i.test(sloppy.text));
  await fs.writeFile(path.join(tmp, "clean.css"), ":root{--ink:#2B2742;--paper:#F7F5FB}\n.card{border-radius:.5rem}\n");
  const clean = await call("antislop_check", { path: "clean.css" });
  check("scanning a real file path works", !clean.error && clean.text.includes("clean.css"), clean.text.slice(0, 140));
  const noArgs = await call("antislop_check");
  check("antislop_check without text or path errors cleanly", noArgs.error && noArgs.text.includes("`text` or `path`"));
  const escape = await call("antislop_check", { path: "../../etc/hosts" });
  check("antislop_check cannot read outside the project", escape.error && escape.text.includes("inside the project"), escape.text.slice(0, 140));

  console.log("== providers_config (no API call) ==");
  const cfg = await call("providers_config");
  check("no error", !cfg.error);
  check("reports defaults source", cfg.text.includes("built-in defaults"));
  check("reports key status", /MISSING/.test(cfg.text));
  check("says which repo it is on, and where that came from", cfg.text.includes(`Project dir: ${tmp}`) && cfg.text.includes("Root from: DESIGN_MCP_PROJECT_DIR"), cfg.text.slice(0, 300));
  check("says whether this host can answer sampling at all", /sampling: supported/.test(cfg.text), cfg.text.slice(0, 400));

  console.log("== which repository (one install, any repo) ==");
  const here = await call("project_root");
  check("project_root names the pinned repo, and why it is that one", !here.error && here.text.includes(`Project: ${tmp}`) && here.text.includes("From: DESIGN_MCP_PROJECT_DIR"), here.text.slice(0, 300));
  const home = await call("project_root", { path: os.homedir() });
  check("a home folder is refused as a project, with the reason", home.error && /home folder or a drive root/.test(home.text), home.text.slice(0, 200));
  const stillHere = await call("code_index", { refresh: true });
  check("after that refusal the index still reads the fixture, not the home folder", !stillHere.error && /src\/util\.ts/.test(stillHere.text), stillHere.text.slice(0, 300));

  // A second repo, reached without restarting the server or editing its settings: this is the whole point
  // of the tool for someone who installed the server once and works in many folders.
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-other-repo-"));
  await fs.mkdir(path.join(other, "src"), { recursive: true });
  await fs.writeFile(path.join(other, "package.json"), JSON.stringify({ name: "other-repo", type: "module" }));
  await fs.writeFile(path.join(other, "src/only.ts"), 'export const onlyHere = (): string => "second repo";\n');
  const moved = await call("project_root", { path: other });
  check("project_root moves this session to another repo", !moved.error && moved.text.includes(`Project: ${other}`), moved.text.slice(0, 300));
  const otherIndex = await call("code_index");
  check("the index follows the move, with that repo's own files", otherIndex.text.includes("src/only.ts") && otherIndex.text.includes("onlyHere"), otherIndex.text.slice(0, 400));
  const backHere = await call("project_root", { path: tmp });
  check("and back, so the rest of the suite still runs on the fixture", !backHere.error && backHere.text.includes(`Project: ${tmp}`), backHere.text.slice(0, 200));
  // The same move through a tool that is already on any host's approved list: some MCP clients refuse a
  // tool that appeared after install, which must not mean "this repo cannot be indexed".
  const viaIndex = await call("code_index", { path: other });
  check("code_index { path } points the session at another repo too", !viaIndex.error && viaIndex.text.includes("src/only.ts") && viaIndex.text.includes("onlyHere"), viaIndex.text.slice(0, 300));
  const backAgain = await call("project_root", { path: tmp });
  check("and the fixture is the project again", !backAgain.error && backAgain.text.includes(`Project: ${tmp}`), backAgain.text.slice(0, 200));
  await fs.rm(other, { recursive: true, force: true });

  console.log("== brief workflow ==");
  const init = await call("brief_init");
  check("brief_init creates brief.md", !init.error && init.text.includes("Created"));
  await fs.access(path.join(tmp, "brief.md")).then(() => check("brief.md exists", true)).catch(() => check("brief.md exists", false));
  const init2 = await call("brief_init");
  check("brief_init never overwrites", !init2.error && init2.text.includes("already exists"));
  const thin = await call("brief_check");
  check("template brief reports missing sections", !thin.error && thin.text.includes("MISSING"));
  await fs.copyFile(path.join(ROOT, "brief.example.md"), path.join(tmp, "brief.md"));
  const full = await call("brief_check");
  check("example brief validates complete", !full.error && full.text.includes("complete"));

  console.log("== graceful error paths (nothing built yet) ==");
  const rev = await call("concepts_review");
  check("concepts_review without store errors cleanly", rev.error && rev.text.includes("concepts_generate"));
  const st = await call("design_status");
  check("design_status without jobs", !st.error && st.text.includes("No jobs found"));
  const rep = await call("design_report", { id: "a" });
  check("design_report without report errors cleanly", rep.error && rep.text.includes("No report"));
  const crit = await call("design_critique", { id: "a" });
  check("design_critique without variation errors cleanly", crit.error && crit.text.includes("No built variation"));
  const use = await call("usage_report");
  check("usage_report empty", !use.error && use.text.includes("No API calls yet"));
  console.log("== keyless providers (your own assistant, no keys) ==");
  const writeCfg = (provider) => fs.writeFile(path.join(tmp, "design-mcp.config.json"), JSON.stringify({ roles: { concept: { provider, model: "smoke" } } }));
  await writeCfg("session");
  const ses = await call("providers_test", { role: "concept" });
  check("session provider answers via host sampling", !ses.error && ses.text.includes("ready (smoke sampling)"), ses.text.slice(0, 160));
  await writeCfg("manual");
  const man1 = await call("providers_test", { role: "concept" });
  check("manual provider parks a prompt file", man1.error && man1.text.includes("manual_answer"), man1.text.slice(0, 160));
  const pend = await call("manual_pending");
  check("manual_pending lists it", !pend.error && pend.text.includes("unanswered"), pend.text.slice(0, 160));
  const pendFiles = await fs.readdir(path.join(tmp, ".design-mcp", "manual"));
  const pid = pendFiles.find((f) => f.startsWith("pending-")).slice("pending-".length, -".json".length);
  const ans = await call("manual_answer", { id: pid, text: "ready (smoke manual)" });
  check("manual_answer stores the reply", !ans.error, ans.text.slice(0, 160));
  const man2 = await call("providers_test", { role: "concept" });
  check("manual provider resumes with the stored answer", !man2.error && man2.text.includes("ready (smoke manual)"), man2.text.slice(0, 160));

  console.log("== the codebase layer (index, digest, packs, citations; no model involved) ==");
  const idxd = await call("code_index");
  check("code_index indexes the project", !idxd.error && idxd.text.includes("src/util.ts") && /files, \d+ lines/.test(idxd.text), idxd.text.slice(0, 200));
  check("the digest carries real symbols with real line spans", !idxd.error && /1 export function normalise\s+\(lines 1-3\)/.test(idxd.text), idxd.text.slice(0, 400));
  check("the digest names how the project is run and what it must obey", !idxd.error && /## How this project is built and run/.test(idxd.text) && /## The project's own rules/.test(idxd.text));
  check("the digest reports its own token cost against the budget", !idxd.error && /digest ~\d+ tokens \(budget \d+/.test(idxd.text));
  const idxAgain = await call("code_index");
  check("a second call reuses the cached index", !idxAgain.error && /index reused/.test(idxAgain.text), idxAgain.text.slice(0, 160));

  const ctx = await call("code_context", { query: "normalise the stored input" });
  check("code_context packs the file that defines the symbol", !ctx.error && ctx.text.includes("src/util.ts") && /^\s*1\|/m.test(ctx.text), ctx.text.slice(0, 300));
  check("packs carry the file's real line numbers", !ctx.error && /lines 1-\d+ of 9/.test(ctx.text), ctx.text.slice(0, 300));
  check("it follows one hop along the import graph", !ctx.error && ctx.text.includes("src/leaky.ts"), ctx.text.slice(0, 400));
  check("the pack states what it left out and why", !ctx.error && /Considered and left out/.test(ctx.text));
  const ctxNone = await call("code_context", { query: "zzzz-nomatch-zzzz" });
  check("an unmatched question says so instead of inventing", !ctxNone.error && /nothing in the index matched/.test(ctxNone.text), ctxNone.text.slice(0, 240));
  const ctxBudget = await call("code_context", { query: "normalise", budgetTokens: 500 });
  check("the pack respects its token budget", !ctxBudget.error && /of a 500-token budget/.test(ctxBudget.text), ctxBudget.text.slice(0, 160));

  const utilLines = FIXTURE["src/util.ts"].split("\n");
  const cites = await call("code_verify_cites", {
    claims: [
      { claim: "normalise returns a trimmed, lowercased string", path: "src/util.ts", lines: [1, 3], quote: utilLines[1] },
      { claim: "the same quote cited at the wrong lines", path: "src/util.ts", lines: [7, 7], quote: utilLines[1] },
      { claim: "normalise memoises", path: "src/util.ts", lines: [1, 1], quote: INVENTED_QUOTE },
      { claim: "read the system hosts file", path: "../../etc/hosts", quote: "localhost" },
    ],
  });
  check(
    "the citation gate separates verified, misplaced, invented and outside-project",
    !cites.error && /1 verified, 1 found-elsewhere, 1 quote-not-found, 1 outside-project/.test(cites.text),
    cites.text.slice(0, 300)
  );
  check("a misplaced quote is reported with where it really is", !cites.error && /lives near line 2, not 7-7/.test(cites.text), cites.text.slice(0, 500));
  check("the refusal to read outside the project is explicit", !cites.error && /outside the project: refused, not read/.test(cites.text));
  check("the gate tells you not to report unverified claims as fact", !cites.error && /Fix or drop anything that is not verified/.test(cites.text));
  // The second way a citation fails: the quote is really there and has nothing to do with the claim.
  const thinCite = await call("code_verify_cites", { claims: [{ claim: THIN_CLAIM, path: "src/util.ts", lines: [5, 5], quote: utilLines[4] }] });
  check(
    "a real quote that shares no wording with its claim is flagged, not rejected",
    !thinCite.error && /1 verified/.test(thinCite.text) && /VERIFIED BUT THIN/.test(thinCite.text),
    thinCite.text.slice(0, 500)
  );
  check("the flag explains itself and admits it is one-sided", /wording is not entailment/.test(thinCite.text) && /a citation is not support/.test(thinCite.text), thinCite.text.slice(0, 500));
  check("a quote that does share wording is not flagged as thin", !/VERIFIED BUT THIN/.test(cites.text), cites.text.slice(0, 400));
  const allGood = await call("code_verify_cites", { claims: [{ path: "src/util.ts", lines: [5, 5], quote: "export const LIMIT = 40;" }] });
  check("a fully verified set says so", !allGood.error && /Every claim checked out/.test(allGood.text), allGood.text.slice(0, 160));

  console.log("== the edit gate (where a change lands, checked before anyone makes it) ==");
  const editCheck = await call("code_verify_edits", {
    edits: [
      { path: "src/util.ts", anchor: "export function truncate", lines: [7, 8], intent: "reuse the existing slicer" },
      { path: "src/leaky.js", anchor: "normalise", intent: "a path with the wrong extension" },
      { path: "src/leaky.ts", anchor: "normalise", lines: [3, 3], intent: "rename the cleaner" },
      { path: "src/util.ts", anchor: "LIMIT", intent: "an anchor with no line range to pin it down" },
      { path: "../../etc/hosts", anchor: "localhost", intent: "an edit outside the project" },
    ],
  });
  check(
    "the edit gate answers where each edit lands, against the file as it is now",
    !editCheck.error && /5 edit\(s\) checked/.test(editCheck.text) && /2 anchored, 1 anchor-ambiguous, 1 no-such-file, 1 outside-project/.test(editCheck.text),
    editCheck.text.slice(0, 400)
  );
  check("a path that does not exist gets a suggestion from the index", !editCheck.error && /the closest path in the index is src\/leaky\.ts/.test(editCheck.text), editCheck.text.slice(0, 900));
  check("an anchor used but not declared here points at the declaration and what a rename would sweep", !editCheck.error && /is declared in src\/util\.ts:1, so this edit sits at a use site and a rename would have to sweep 2 importer/.test(editCheck.text), editCheck.text.slice(0, 1400));
  check("an anchor that occurs twice with no line range is not treated as placed", !editCheck.error && /occurs 2 times in this file/.test(editCheck.text) && /— anchor-ambiguous/.test(editCheck.text));
  check("it refuses to read outside the project, and says so", !editCheck.error && /refused: nothing outside the project is checked/.test(editCheck.text));
  check("it records the snapshot each line number belongs to", !editCheck.error && /sha256 [0-9a-f]{16} when this was checked/.test(editCheck.text));
  check("the impact line comes from the index's edges, not from the intent's wording", !editCheck.error && /impact: 2 indexed file\(s\) import this one/.test(editCheck.text));
  check("it says plainly that it does not apply the change or judge it", !editCheck.error && /It does not apply the change, it does not parse the result/.test(editCheck.text) && /the honest move is to re-check rather than to guess/.test(editCheck.text));
  check("every status explains itself", !editCheck.error && /anchored: the file exists and the anchor/.test(editCheck.text) && /anchor-ambiguous: the anchor text appears several times/.test(editCheck.text));
  check("an edit that cannot be applied is named as one, not softened", !editCheck.error && /Do not apply the edits above that cannot be applied as described/.test(editCheck.text));

  console.log("== references (who declares a name, and who uses it) ==");
  const refs = await call("code_refs", { name: "normalise" });
  check("it separates the declaration from the uses", !refs.error && /1 declaration\(s\), 5 use\(s\) quoted across 4 file\(s\)/.test(refs.text), refs.text.slice(0, 400));
  check("a mention in a document is labelled as a mention, not counted as a call", !refs.error && /notes\.md \(prose file: a mention, not a call/.test(refs.text), refs.text.slice(0, 1600));
  check("the declaration carries its file, line, kind and export status", !refs.error && /src\/util\.ts:1 — exported function/.test(refs.text), refs.text.slice(0, 600));
  check("every use is quoted with its own line number", !refs.error && /- src\/leaky\.ts\n\s+1: import \{ normalise \} from/.test(refs.text) && /3: export const clean = \(raw: string\) => normalise\(raw\);/.test(refs.text), refs.text.slice(0, 1200));
  check("a use reached through a tsconfig alias is found too", !refs.error && /src\/alias-user\.ts/.test(refs.text));
  check("the scan admits it is text, not a type checker", !refs.error && /Text scan, not a type checker/.test(refs.text) && /reached dynamically is invisible/.test(refs.text));
  const refsScoped = await call("code_refs", { name: "normalise", paths: ["src/leaky.ts"] });
  check("it can be aimed at one surface", !refsScoped.error && /2 use\(s\) quoted across 1 file\(s\)/.test(refsScoped.text) && /scanned the rename surface only/.test(refsScoped.text), refsScoped.text.slice(0, 400));
  const refsNoDecl = await call("code_refs", { name: "trim" });
  check("a name that is used but never declared says so instead of guessing at a definition", !refsNoDecl.error && /No indexed file declares/.test(refsNoDecl.text), refsNoDecl.text.slice(0, 500));
  const refsMissing = await call("code_refs", { name: "zzzNeverHere" });
  check("a name nothing mentions is reported as absent, not as an error", !refsMissing.error && /Nothing in the indexed files mentions/.test(refsMissing.text) && /does not exist in this project/.test(refsMissing.text), refsMissing.text.slice(0, 400));

  console.log("== path aliases (tsconfig `paths` are internal edges, not packages) ==");
  const ctxAlias = await call("code_context", { query: "viaAlias normalise" });
  const graph = await client.readResource({ uri: "code://graph" });
  const graphText = graph.contents?.[0]?.text ?? "";
  check(
    "an import through a tsconfig alias is an internal edge, not a package",
    /- src\/util\.ts\n\s+imports: \(none\)\n\s+imported by: .*src\/alias-user\.ts/.test(graphText) && /aliases in force:.*@app\/\* → src\/\*/.test(graphText),
    graphText.slice(0, 700)
  );
  check("the aliased file is packed for a question about what it exports", !ctxAlias.error && ctxAlias.text.includes("src/alias-user.ts"), ctxAlias.text.slice(0, 700));
  const idxAlias = await call("code_index");
  check("the digest names the aliases it resolved", !idxAlias.error && /Path aliases the project declared/.test(idxAlias.text) && /@app\/\* → src\/\*/.test(idxAlias.text), idxAlias.text.slice(0, 700));
  check("an aliased import is not counted as a third-party package", !idxAlias.error && !/@app\/util/.test(idxAlias.text), idxAlias.text.slice(0, 900));

  console.log("== the collective (leader, parallel workers, checked quotes, dossier) ==");
  const plan = await call("collective_plan", { mission: "Make normalise() the single place user input is cleaned." });
  check("the leader splits the mission into units with roles", !plan.error && /explore-util \[explorer\]/.test(plan.text) && /verify-util \[verifier\]/.test(plan.text), plan.text.slice(0, 300));
  check("units carry concrete questions and the files they own", !plan.error && /must answer: what does normalise/.test(plan.text) && /owns: src\/util\.ts/.test(plan.text));
  check("a file the leader invented is flagged before anything runs", !plan.error && /src\/does-not-exist\.ts \(DOES NOT EXIST\)/.test(plan.text), plan.text.slice(0, 600));
  check("the plan admits its unknowns instead of hiding them", !plan.error && /Admitted unknowns:/.test(plan.text));
  check("the leader's own cost is reported", !plan.error && /over a ~\d+-token digest of \d+ files/.test(plan.text));

  const run = await call("collective_run", { mission: "Make normalise() the single place user input is cleaned." });
  check("collective_run hands back a job immediately", !run.error && /Mission started \(job c-/.test(run.text), run.text.slice(0, 240));
  let status = "";
  for (let i = 0; i < 80; i++) {
    const st = await call("design_status");
    status = st.text;
    if (/DONE|FAILED/.test(st.text)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("the mission finishes and reports its own tally", /DONE/.test(status) && /verified [1-9]\d* claim\(s\), rejected [1-9]\d*/.test(status), status.slice(0, 400));
  check("the dossier shows the leader worked from a digest, not the files", /leader saw a ~\d+-token digest, workers ~\d+ tokens of real source/.test(status), status.slice(0, 400));
  check("the invented claim is rejected by name in the dossier", /## Rejected: cited but not found in the file/.test(status) && /quote-not-found/.test(status));
  check("an invented quote never reaches the reader as evidence", !status.includes(INVENTED_QUOTE), status.slice(0, 200));
  check("the rejected claim is quarantined below the evidence", status.indexOf("## Rejected") > status.indexOf("## Evidence") && /truncate\(\) slices its input/.test(status.slice(status.indexOf("## Rejected"))));
  check("the closing pass ran and its conclusions are separated from the evidence", /## What the collective concluded/.test(status) && /was rejected by the server/.test(status));
  check("the leader's own unverified list is carried into the dossier", /## Unverified \(claimed, but not checkable from the source we read\)/.test(status) && /truncate/.test(status.slice(status.indexOf("## Unverified"))));
  check("the leader's invented file is reported as a warning, not used", status.includes("scoped files that do not exist"), status.slice(0, 800));
  check("the run states what it did not check", /## What this does NOT check/.test(status) && /Nothing here ran the project's own gates/.test(status));
  const dossiers = await fs.readdir(path.join(tmp, ".design-mcp", "collective")).catch(() => []);
  check("the dossier is written to disk", dossiers.some((f) => f.endsWith(".md")), dossiers.join(","));
  const listed = await call("collective_report");
  check("collective_report lists what is on disk", !listed.error && /dossier\(s\) in \.design-mcp\/collective/.test(listed.text), listed.text.slice(0, 200));
  const dossierId = dossiers.find((f) => f.endsWith(".md"))?.replace(/\.md$/, "");
  const dossier = await call("collective_report", { id: dossierId });
  check("a dossier can be read back by id", !dossier.error && dossier.text.includes("## Evidence") && dossier.text.includes("## Method and cost"), dossier.text.slice(0, 200));
  const unknownDossier = await call("collective_report", { id: "nope" });
  check("an unknown mission id errors cleanly", unknownDossier.error && unknownDossier.text.includes("No mission dossier"));

  console.log("== the collective's voices, its conversation, and what it remembers ==");
  check("each unit is given a seat and a voice", /Scout \(explore-util\)/.test(status) && /Thorn \(verify-util\)/.test(status), status.slice(0, 400));
  check("round two happened and is in the dossier", /## The conversation \(round two\)/.test(status), status.slice(0, 300));
  check("a rebuttal carrying a quote is checked like anything else", /rebut → explore-util: .*\[verified\]/.test(status), status.slice(0, 800));
  check("a rebuttal with no quote is marked unproven, not treated as doubt", /\[no evidence offered\]/.test(status) && /stand as unproven/.test(status));
  check("unproven disagreement is kept for the owner", /## They do not all agree/.test(status) && /case folding to ASCII/.test(status));
  check("the dossier refuses to treat agreement between copies as evidence", /Agreement between copies of one model is not independent evidence/.test(status));
  check("the conversation explains what the models are", /these are copies of one model/i.test(status));

  console.log("== the verdict, and the one repair pass (what the run counts, and what it fixed) ==");
  check(
    "the job result carries the verdict, so a poller sees it without opening the dossier",
    /verdict PARTIAL \(5 verified, 3 rejected, 2 repaired, 3\/3 units usable, 2 edit\(s\) that cannot be applied as described\)/.test(status),
    status.slice(0, 240)
  );
  check("the dossier checks the edits it proposes, before anyone applies them", /## The edits, checked before anyone applies them/.test(status) && /8 edit\(s\) checked/.test(status), status.slice(status.indexOf("## The edits"), status.indexOf("## The edits") + 500));
  check("an edit at a call site names the other call sites, not just the file", /where it is used: src\/(alias-user|leaky)\.ts:\d+/.test(status), status.slice(status.indexOf("## The edits"), status.indexOf("## The edits") + 3000));
  check(
    "an invented file, a stale citation and an ambiguous anchor are told apart",
    /- 2 cannot be applied as described, 0 have a real anchor with stale line numbers, 0 are anchored to nothing\./.test(status) && /### src\/does-not-exist\.ts — no-such-file/.test(status),
    status.slice(status.indexOf("## The edits"), status.indexOf("## The edits") + 2500)
  );
  check(
    "the summary counts only what is still true at the end, and says so",
    /That counts only what is still true at the end: 1 of the steps above was re-placed by the repair pass, and 1 was given up by their own author with a reason; each is marked where it appears in this list/.test(status),
    status.slice(status.indexOf("## The edits"), status.indexOf("## The edits") + 700)
  );

  console.log("== the edit repair pass (a step the gate could not place gets one second chance) ==");
  check("the pass is reported, with what it settled", /## The edit repair pass \(one second chance for a step that could not be placed\)/.test(status) && /3 source\(s\) got their own unplaceable steps back/.test(status) && /1 step\(s\) came back placed, 1 withdrawn with a reason, 1 still not placeable/.test(status), status.slice(status.indexOf("## The edit repair"), status.indexOf("## The edit repair") + 700));
  check("a re-placed step is marked as superseding the one that failed, and as coming from the pass", /superseded by the repair pass \(fixed\)/.test(status) && /came back from the repair pass/.test(status));
  check("a source that gives a step up is recorded with its reason, not silently dropped", /verify-util withdrew: Route this file through the one cleaner — the file I was given has no such import line/.test(status), status.slice(status.indexOf("## The edit repair"), status.indexOf("## The edit repair") + 1400));
  check(
    "a returned step that still does not land is reported as still unplaceable, not accepted",
    /1 still not placeable/.test(status) && /### src\/alias-user\.ts — anchor-not-found · from ghost \(architect\) · came back from the repair pass/.test(status),
    status.slice(status.indexOf("### src/alias-user.ts"), status.indexOf("### src/alias-user.ts") + 300)
  );
  check("nothing that already landed is re-sent to the repair pass", seenPrompts.filter((p) => /AN EDIT THAT COULD NOT BE PLACED/.test(p)).every((p) => !/Reuse the exported cleaner instead of adding a second one/.test(p)), `edit-repair prompts: ${seenPrompts.filter((p) => /AN EDIT THAT COULD NOT BE PLACED/.test(p)).length}`);
  check("the repair prompt carries the server's own reason and the number to answer", seenPrompts.some((p) => /AN EDIT THAT COULD NOT BE PLACED/.test(p) && /1\. \[anchor-ambiguous\]/.test(p) && /the anchor occurs 3 times in this file/.test(p)), `prompts captured: ${seenPrompts.length}`);
  check("the repair prompt is told which of its steps already placed, so silence is not a rewrite order", seenPrompts.some((p) => /placed correctly and are NOT below/.test(p)));
  check("the repair prompt forbids inventing a file to save a step", seenPrompts.some((p) => /Do not invent a file to save a step/.test(p)));
  check("a real anchor cited at the wrong lines says where it really is", /the anchor is real but lives at line 1, not 3-3/.test(status));
  check("an anchor that occurs three times is not treated as placed", /occurs 3 times in this file/.test(status) && /— anchor-ambiguous/.test(status));
  check("the closing plan's own steps are gated and marked on the plan line", /\[edit gate: the anchor is in src\/util\.ts as cited, 2 file\(s\) import it\]/.test(status), status.slice(0, 1500));
  check("the verdict counts the edits instead of letting them ride along", /- Proposed edits: 8 checked against the file as it is now — 2 cannot be applied as described/.test(status) && /One repair pass settled 1 of them by re-placing the step and 1 by the author giving it up with a reason/.test(status), status.slice(0, 1200));
  check("and the job result says how the edit repair went", /edit repair: one pass, 3 model call\(s\)\. 1 step\(s\) that could not be placed came back placed and re-verified; 1 were withdrawn by their own author with a reason/.test(status), status.slice(status.indexOf("## Method and cost"), status.indexOf("## Method and cost") + 2500));
  check("the edit gate states its own boundary in the dossier", /does not apply the change, does not parse the result, and cannot tell a correct change from a wrong one/.test(status));
  check("the dossier opens with the verdict, counted from the gate's results", /## Verdict \(counted from the gate's results, not written by a model\)/.test(status), status.slice(0, 500));
  check("the verdict's evidence count is the mission's own tally, not a second story", /- Evidence: 5 quote\(s\) re-read from the files and matched where they were cited/.test(status) && /verified 5 claim\(s\)/.test(status), status.slice(status.indexOf("## Verdict"), status.indexOf("## Verdict") + 900));
  check("the verdict separates a citation that is still wrong from one that was settled", /- Not evidence: 3 finding\(s\) the gate rejected; 1 still wrong at the end, 1 withdrawn by their own worker/.test(status), status.slice(0, 900));
  check("the verdict names who was meant to falsify the mission, and that they showed up", /- Falsification: Thorn \(verify-util\) reported, with 1 verified counter-observation\(s\)/.test(status), status.slice(0, 900));
  check("the verdict refuses to be a judgement, and says the gates were not run", /Grade: PARTIAL — a count of what survived the gate, not a judgement of the answer/.test(status) && /did not execute the project's own gates/.test(status));
  check("the repair pass is reported, with the server's own reason for the rejection", /## The repair pass \(one second chance, for a citation the gate rejected\)/.test(status) && /3 unit\(s\) got their own rejected findings back/.test(status) && /2 finding\(s\) came back verified, 0 are still not verifiable/.test(status), status.slice(0, 1400));
  check("re-citing the same claim is told apart from substituting a different finding", /Scout \(explore-util\): 1 sent back → 1 re-cited under the same claim, 0 replaced by a different finding, 0 withdrawn, 0 left unaddressed/.test(status), status.slice(0, 1600));
  check("a withdrawn claim keeps the worker's reason", /Thorn \(verify-util\): 1 sent back → 0 re-cited under the same claim, 0 replaced by a different finding, 1 withdrawn, 0 left unaddressed/.test(status) && /verify-util withdrew: truncate\(\) slices its input to a fixed limit — the file caps the slice at LIMIT/.test(status), status.slice(0, 2000));
  check("a finding the worker never addressed is counted, not smoothed over", /\(ghost\): 1 sent back → 0 re-cited under the same claim, 1 replaced by a different finding, 0 withdrawn, 1 left unaddressed/.test(status), status.slice(status.indexOf("## The repair pass"), status.indexOf("## The conversation")));
  check("a repaired claim is marked in the evidence as re-verified, not merely trusted", /truncate\(\) slices its input to a fixed limit \(repaired and re-verified\)/.test(status), status.slice(status.indexOf("## Evidence"), status.indexOf("## Evidence") + 1200));
  check("the attempt that failed first is still on the record next to the fix", /\[quote-not-found\] explore-util src\/util\.ts/.test(status) && /a first attempt that failed is still listed as rejected above/.test(status));
  check("the repair prompt gets the rejected finding and the server's own verdict on it", seenPrompts.some((p) => /THE FINDINGS THE SERVER REJECTED/.test(p) && /you quoted:/.test(p) && /the server says: not found in that file/.test(p)), `prompts captured: ${seenPrompts.length}; repair: ${seenPrompts.filter((p) => /REPAIR PASS/.test(p)).length}; ${JSON.stringify((() => { const p = seenPrompts.find((x) => /REPAIR PASS/.test(x)) ?? ""; const at = p.indexOf("THE FINDINGS"); return at < 0 ? p.slice(-800) : p.slice(at, at + 700); })())}`);
  check("the repair prompt forbids weakening a claim into something nothing could contradict", seenPrompts.some((p) => /You may not weaken it into something/.test(p)));
  check("a finding that already passed is never sent back for repair", !seenPrompts.some((p) => /REPAIR PASS/.test(p) && /normalise\(\) is exported from src\/util\.ts/.test(p)));
  check("the support flag is stated as one-sided, so shared wording is not proof either", /The support label is one-sided/.test(status));

  const memList = await call("collective_memory");
  check("memory records what the mission established, with its provenance", !memList.error && /\[established ×\d+\] src\/util\.ts:\d+-\d+: /.test(memList.text), memList.text.slice(0, 300));
  check("memory records what the gate rejected, so nobody repeats it", !memList.error && /\[rejected/.test(memList.text), memList.text.slice(0, 300));
  check("memory says it is a hint list, never a citation", !memList.error && /never a citation/.test(memList.text));
  const ruling = await call("collective_memory", { action: "ruling", text: "never let the newsletter double-send" });
  check("the owner can record a ruling", !ruling.error && /Recorded as a ruling/.test(ruling.text), ruling.text.slice(0, 200));
  const badRuling = await call("collective_memory", { action: "ruling", text: "no" });
  check("a ruling that is not a decision is refused", badRuling.error && badRuling.text.includes("needs `text`"));

  seenPrompts.length = 0;
  thinArmed = true; // the second mission carries one quote that is real but does not back its claim
  const run2 = await call("collective_run", { mission: "Check the cleaning path again.", workers: 2 });
  let status2 = "";
  for (let i = 0; i < 80; i++) {
    const st = await call("design_status");
    status2 = st.text;
    if (/DONE|FAILED/.test(st.text)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("a second mission runs", /DONE/.test(status2), status2.slice(0, 240));
  check("the ruling reaches the leader and the workers", seenPrompts.some((p) => p.includes("never let the newsletter double-send")), `prompts captured: ${seenPrompts.length}`);
  check("memory is handed over as hints, not as evidence", seenPrompts.some((p) => p.includes("hints, not instructions")) && seenPrompts.some((p) => /re-read the code before relying on any of them/.test(p)));
  check(
    "past missions reach the leader as history, not as evidence",
    seenPrompts.some((p) => p.includes("HOW THIS OWNER HAS WORKED IN THIS REPO") && p.includes("Missions run here:") && p.includes("never evidence about the code")),
    `prompts captured: ${seenPrompts.length}`
  );
  check("the second dossier reports what it was given", /were given to this run as hints/.test(status2), status2.slice(0, 400));
  check("an entry confirmed again is recorded as reinforced, not as new", /nothing new, but \d+ earlier entr/.test(status2), status2.slice(0, 400));
  check("memory records nothing the evidence does not back, and says what it left out", /1 verified claim\(s\) were kept out of memory: the quote is real but shares no wording/.test(status2), status2.slice(0, 2500));
  check("a rejection the repair pass re-cited is not filed as a false belief", /1 rejection\(s\) were re-cited correctly by the repair pass/.test(status2), status2.slice(0, 2500));
  check("a verified quote that does not visibly back its claim is labelled, not trusted", /## Verified, but the quote does not visibly back the claim/.test(status2) && /THIN SUPPORT: the quote shares no wording with the claim/.test(status2), status2.slice(0, 2000));
  check("the verdict counts weak support instead of grading the run on the totals alone", /Weak support: 1 verified quote\(s\) share no wording/.test(status2) && /Grade: PARTIAL/.test(status2), status2.slice(0, 900));

  // Change the code a memory entry quotes: it must retire itself rather than be recited from now on.
  await fs.writeFile(path.join(tmp, "src/util.ts"), FIXTURE["src/util.ts"].split("\n").slice(1).join("\n"));
  const stale = await call("collective_memory");
  check("memory whose code has changed is retired, not repeated", !stale.error && /Stale — the quoted code is gone or changed/.test(stale.text) && /kept out of every prompt/.test(stale.text), stale.text.slice(0, 500));
  check("a retired entry says why", !stale.error && /the quoted code is no longer in that file/.test(stale.text), stale.text.slice(0, 600));
  const forgotten = await call("collective_memory", { action: "forget" });
  check("memory can be erased on request", !forgotten.error && /Erased \d+ memory/.test(forgotten.text), forgotten.text.slice(0, 160));
  const afterForget = await call("collective_memory");
  check("an empty memory says so instead of inventing", !afterForget.error && /0 memory entries/.test(afterForget.text), afterForget.text.slice(0, 200));

  console.log("== the owner's skills (found, read, and pasted into a worker when a unit is assigned one) ==");
  const skills = await call("skills_list");
  check("skills_list finds the installed skill and its own description", !skills.error && /make-it-fast — A fixture skill\b/.test(skills.text), skills.text.slice(0, 400));
  // Path separators are a platform detail, not a behaviour: Windows returns `.claude\\skills\\...`, and the
  // assertion is that the skill's own directory is named, so normalise before looking for it.
  check("it says where each skill lives and what goes with it", !skills.error && /SKILL\.md/.test(skills.text) && skills.text.replace(/\\/g, "/").includes(".claude/skills/make-it-fast"), skills.text.slice(0, 400));
  const skillsQuery = await call("skills_list", { query: "fixture" });
  check("a filtered listing reports the match count", !skillsQuery.error && /matching "fixture" \(1\)/.test(skillsQuery.text), skillsQuery.text.slice(0, 200));
  const noSkills = await call("skills_list", { roots: ["nowhere-at-all"] });
  check("a root with nothing in it explains how to point at your skills", !noSkills.error && /Point `skills.roots`/.test(noSkills.text), noSkills.text.slice(0, 200));
  const skillText = await call("skills_read", { name: "make-it-fast" });
  check("skills_read returns the skill in full, with the file it read", !skillText.error && skillText.text.includes("SKILL-BODY-MARKER") && /read in full from .*SKILL\.md/.test(skillText.text), skillText.text.slice(0, 300));
  check("a skill is labelled as instructions, never as evidence about the code", !skillText.error && /not evidence about this repository/.test(skillText.text) && /cite the code, not the skill/.test(skillText.text));
  const looseName = await call("skills_read", { name: "fast" });
  check("a partial name finds the skill instead of failing", !looseName.error && looseName.text.includes("SKILL-BODY-MARKER"));
  const noSuch = await call("skills_read", { name: "zzz" });
  check("an unknown skill names what is installed and where it looked", !noSuch.error && /No skill matching "zzz"/.test(noSuch.text) && /Roots searched:/.test(noSuch.text), noSuch.text.slice(0, 300));
  const skillsRes = await client.readResource({ uri: "code://skills" });
  check("code://skills reads back the same index", !!skillsRes.contents?.[0]?.text?.includes("make-it-fast"), skillsRes.contents?.[0]?.text?.slice(0, 200));
  check("a skill the leader assigned reached that worker's prompt", seenPrompts.some((p) => p.includes("SKILL-BODY-MARKER")), `prompts captured: ${seenPrompts.length}`);
  check("the skill in the prompt is framed as how to work, not as a fact", seenPrompts.some((p) => p.includes("it is not evidence about this") && p.includes("the source wins")));
  check("a skill was not pasted into units that were not given one", seenPrompts.filter((p) => p.includes("SKILL-BODY-MARKER")).length < seenPrompts.filter((p) => p.includes("YOUR UNIT: ")).length);
  check("the dossier records which unit followed which skill", /followed the skill "make-it-fast"/.test(status2) && /make-it-fast → explore-util/.test(status2), status2.slice(0, 600));
  check("the dossier keeps skills away from the evidence", /A skill is how to work, never what is true/.test(status2));
  check("a skill that cannot be found is a warning, not a silent no-op", /"a-skill-that-was-never-installed", which is not under the configured roots/.test(status2), status2.slice(0, 900));

  console.log("== Hello collective (the session greeting, and making it automatic) ==");
  const hello = await call("collective_hello");
  check("the greeting wakes the crew with a roll call", !hello.error && /Keystone \(leader\)/.test(hello.text) && /Scout \(explorer\)/.test(hello.text) && /Judge \(critic\)/.test(hello.text), hello.text.slice(0, 400));
  check("it names the repo and its size from the index", !hello.error && /\d+ files, \d+ lines, root /.test(hello.text));
  check("it reports the state of the working tree", !hello.error && /git: (not a git repository|.*)/.test(hello.text), hello.text.slice(0, 400));
  check("it says what the collective already knows here", !hello.error && /## What the collective already knows about this repo/.test(hello.text));
  check(
    "and what the missions here taught it about the work",
    !hello.error && /## What I know about you and this work/.test(hello.text) && /\d+ missions? in this repo since \d{4}-\d{2}-\d{2}/.test(hello.text),
    hello.text.slice(0, 900)
  );
  check("it names the open missions on disk", !hello.error && /## Open work/.test(hello.text) && /m-[a-z0-9]+ — /.test(hello.text), hello.text.slice(0, 600));
  check("it hands back the verdict each mission counted for itself", !hello.error && /· verdict (STRONG|PARTIAL|THIN|NOTHING)/.test(hello.text), hello.text.slice(0, 900));
  check("it lists the owner's skills", !hello.error && /## Your skills/.test(hello.text) && /make-it-fast/.test(hello.text));
  check("it carries a digest computed from the files", !hello.error && /## Digest — this repo in ~\d+ tokens/.test(hello.text) && /src\/util\.ts/.test(hello.text) && /notes\.md/.test(hello.text), hello.text.slice(0, 600));
  check("it costs nothing: no model call, and it says so", !hello.error && /\(\d+ ms, no model call, no API key\.\)/.test(hello.text));
  check("it tells the assistant not to describe the repo from memory", !hello.error && /never from memory of this repo|Do not invent work and do not describe this repo from memory/.test(hello.text));
  check("it honours a focus when the owner named one", !(await call("collective_hello", { focus: "the unknown-dossier error" })).error);
  const helloFocus = await call("collective_hello", { focus: "the unknown-dossier error", budgetTokens: 400 });
  check("a focus is carried into the greeting and the digest budget is respected", !helloFocus.error && /The owner's focus: the unknown-dossier error/.test(helloFocus.text) && /in ~\d+ tokens/.test(helloFocus.text), helloFocus.text.slice(0, 300));
  const helloNoSkills = await call("collective_hello", { skills: false });
  check("the skills scan can be skipped without breaking the greeting", !helloNoSkills.error && /skills scan is off/.test(helloNoSkills.text));
  const helloPrompt = await client.getPrompt({ name: "hello_collective", arguments: { focus: "the newsletter" } });
  const helloPromptText = helloPrompt.messages?.[0]?.content?.text ?? "";
  check("the hello_collective prompt starts with the owner's words and calls the tool", /Hello collective\./.test(helloPromptText) && /Call `collective_hello`/.test(helloPromptText));
  check("it forbids answering this repo from memory", /Do not describe this repository from memory/.test(helloPromptText));

  console.log("== collective_install (the session block, and undoing it) ==");
  await fs.writeFile(path.join(tmp, "AGENTS.md"), "# Fixture notes\n\nA hand-written line this repo already had.\n");
  const beforeInstall = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
  const shown = await call("collective_install", { action: "show" });
  check("action=show previews without writing", !shown.error && /Preview only \(action=show\): nothing was written/.test(shown.text), shown.text.slice(0, 300));
  check("the preview says what install would do, and the file is untouched", !shown.error && /the block was appended/.test(shown.text) && (await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8")) === beforeInstall, shown.text.slice(0, 300));
  const installed = await call("collective_install");
  const agents = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
  check("install adds the block to the repo's instruction file", !installed.error && /the block was appended/.test(installed.text), installed.text.slice(0, 300));
  check("it tells the host to call collective_hello at session start", agents.includes("collective_hello") && agents.includes("Hello collective."));
  check("the hand-written text above it is untouched", agents.includes("A hand-written line this repo already had.") && agents.startsWith(beforeInstall));
  check("it explains what it cannot do: a server may not speak first", !installed.error && /does not make the server speak first/.test(installed.text) && /removing the block restores the file/.test(installed.text));
  const reinstalled = await call("collective_install");
  const agentsAgain = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
  check("installing twice writes nothing the second time", !reinstalled.error && /already up to date/.test(reinstalled.text), reinstalled.text.slice(0, 240));
  check("the file is byte-identical after the second install", agentsAgain === agents);
  const removed = await call("collective_install", { action: "remove" });
  const afterRemove = await fs.readFile(path.join(tmp, "AGENTS.md"), "utf8");
  check("remove takes exactly the block back out", !removed.error && /the block was removed/.test(removed.text) && !afterRemove.includes("design-mcp:collective:start"));
  check("the repo's own text survives the removal", afterRemove.includes("A hand-written line this repo already had."), afterRemove.slice(0, 200));
  const freshInstall = await call("collective_install", { create: false, targets: ["NOPE.md"] });
  check("it will not invent a file when told not to", !freshInstall.error && /Nothing changed/.test(freshInstall.text), freshInstall.text.slice(0, 240));

  console.log("== collective_install: one file per host, and the gaps named ==");
  await fs.rm(path.join(tmp, "AGENTS.md"), { force: true });
  const fresh = await call("collective_install");
  check("with no instruction file at all it creates exactly one, AGENTS.md", !fresh.error && /AGENTS\.md: created/.test(fresh.text) && !/CLAUDE\.md: created/.test(fresh.text), fresh.text.slice(0, 400));
  check("it names the hosts it does not reach, with the file each one reads", /Claude Code reads CLAUDE\.md/.test(fresh.text) && /reads GEMINI\.md/.test(fresh.text), fresh.text);
  check("it does not call Copilot or Windsurf uncovered, since both read AGENTS.md", !/copilot-instructions\.md\. Pass targets/.test(fresh.text) && !/windsurfrules\. Pass targets/.test(fresh.text), fresh.text);

  await fs.writeFile(path.join(tmp, "GEMINI.md"), "# Fixture Gemini context\n\nA line Gemini's own file had.\n");
  const withGemini = await call("collective_install");
  const gemini = await fs.readFile(path.join(tmp, "GEMINI.md"), "utf8");
  check("a repo with GEMINI.md gets the block there too", !withGemini.error && /GEMINI\.md: the block was appended/.test(withGemini.text) && gemini.includes("design-mcp:collective:start") && gemini.includes("A line Gemini's own file had."), withGemini.text.slice(0, 400));
  check("it says which host reads each file it wrote", /read by Gemini CLI/.test(withGemini.text) && /read by Codex, Cursor, GitHub Copilot, Windsurf, Freebuff/.test(withGemini.text), withGemini.text.slice(0, 500));
  check("once Gemini is covered it is no longer named as a gap", !/reads GEMINI\.md\. Pass targets/.test(withGemini.text));

  await fs.writeFile(path.join(tmp, "CLAUDE.md"), "# Fixture Claude notes\n\nA line Claude's own file had.\n");
  const withClaude = await call("collective_install");
  const claude = await fs.readFile(path.join(tmp, "CLAUDE.md"), "utf8");
  check("a repo with CLAUDE.md gets the block there as well as in AGENTS.md", !withClaude.error && /CLAUDE\.md: the block was appended/.test(withClaude.text) && /AGENTS\.md: already up to date/.test(withClaude.text) && claude.includes("design-mcp:collective:start"), withClaude.text.slice(0, 400));
  check("it explains the Claude Code shadowing so nobody deletes one of the two", /Claude Code's default reads the CLAUDE file instead of AGENTS\.md/.test(withClaude.text));
  check("nothing is written outside the markers", claude.startsWith("# Fixture Claude notes\n\nA line Claude's own file had.\n"), claude.slice(0, 200));

  await fs.rm(path.join(tmp, "CLAUDE.md"), { force: true });
  await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".claude", "CLAUDE.md"), "# Nested Claude notes\n\nKept.\n");
  const nested = await call("collective_install");
  check(".claude/CLAUDE.md is used when there is no root CLAUDE.md", !nested.error && /\.claude\/CLAUDE\.md: the block was appended/.test(nested.text), nested.text.slice(0, 400));
  check("and it does not create a second CLAUDE.md beside it", await fs.access(path.join(tmp, "CLAUDE.md")).then(() => false, () => true));

  const removedAll = await call("collective_install", { action: "remove" });
  check("remove cleans every file it wrote, in every family", !removedAll.error && !(await fs.readFile(path.join(tmp, "GEMINI.md"), "utf8")).includes("design-mcp:collective:start") && !(await fs.readFile(path.join(tmp, ".claude", "CLAUDE.md"), "utf8")).includes("design-mcp:collective:start"), removedAll.text.slice(0, 400));
  check("each host's own text survives the removal", (await fs.readFile(path.join(tmp, "GEMINI.md"), "utf8")).includes("A line Gemini's own file had.") && (await fs.readFile(path.join(tmp, ".claude", "CLAUDE.md"), "utf8")).includes("Kept."));
  check("AGENTS.md, which only ever held the block, is gone", await fs.access(path.join(tmp, "AGENTS.md")).then(() => false, () => true));
  check("it says the rule directories were left alone on purpose", /Rule directories are left alone/.test(removedAll.text));

  const focusPrompt = await client.getPrompt({ name: "focus_contract", arguments: { task: "the cleaning change" } });
  const focusText = focusPrompt.messages?.[0]?.content?.text ?? "";
  check("the focus contract is about this repository only", focusText.includes("this repository only") && focusText.includes("the cleaning change"));
  check("the focus contract names the real commands and rule files", focusText.includes("notes.md") && /commands:/.test(focusText), focusText.slice(0, 300));
  check("the focus contract demands proof, not claims", /Prove it by running it/.test(focusText) && /code_verify_cites/.test(focusText));
  check("it tells the assistant to check where an edit lands before making it", /check where it lands/.test(focusText) && /code_verify_edits/.test(focusText), focusText.slice(0, 2000));
  console.log("== the edit repair pass can be switched off, and says so ==");
  // A flag nobody has watched work is a claim, not a feature. The fixture's source has been changed under it
  // by now (the memory test dropped a line), which is the honest way to see this: without the pass, a step that
  // cannot be placed stays unplaceable and is reported as such. The closing paragraph is armed here too, so
  // the same run shows what the conclusion gate does when nobody is allowed to repair it.
  closingArmed = true;
  await fs.writeFile(path.join(tmp, "design-mcp.config.json"), JSON.stringify({ collective: { editRepair: false, conclusionRepair: false } }, null, 2));
  const run3 = await call("collective_run", { mission: "Check the cleaning path once more.", workers: 2 });
  check("a mission starts with the pass switched off in the config", !run3.error && /Mission started \(job c-/.test(run3.text), run3.text.slice(0, 200));
  let status3 = "";
  for (let i = 0; i < 80; i++) {
    const st = await call("design_status");
    status3 = st.text;
    if (/DONE|FAILED/.test(st.text)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await fs.rm(path.join(tmp, "design-mcp.config.json"), { force: true });
  check("off means off, and the dossier says no pass ran", /DONE/.test(status3) && /edit repair: no pass ran \(every step that was checked could be placed, or `collective\.editRepair` is off\)/.test(status3), status3.slice(0, 300));
  check("and an unplaceable step is still reported rather than quietly dropped", /## The edits, checked before anyone applies them/.test(status3) && /cannot be applied as described/.test(status3) && !/## The edit repair pass \(one second chance/.test(status3), status3.slice(status3.indexOf("## The edits"), status3.indexOf("## The edits") + 400));
  check(
    "the closing paragraph is checked against the record even when nobody may repair it",
    /## The conclusion, checked against the mission's own record/.test(status3) && /2 sentence\(s\) contradict the record:/.test(status3) && /\[reintroduced-rejection: repeats a finding the gate deleted\] answer/.test(status3),
    status3.slice(status3.indexOf("## The conclusion,"), status3.indexOf("## The conclusion,") + 700)
  );
  check("and the sentence that names a file which does not exist is told apart from it", /\[unknown-file: names a file that is not in this repository\] answer/.test(status3) && /no file of that name is in this repository/.test(status3), status3.slice(status3.indexOf("## The conclusion,"), status3.indexOf("## The conclusion,") + 1200));
  check(
    "with the pass off, both sentences still stand and the dossier says no pass ran",
    /- conclusion: 2 sentence\(s\) of the closing paragraph contradicted this mission's own record/.test(status3) && /2 still contradict it at the end/.test(status3) && /- conclusion repair: no pass ran \(no sentence contradicted the record, or `collective\.conclusionRepair` is off\)/.test(status3) && !/## The conclusion repair pass/.test(status3),
    status3.slice(status3.indexOf("## Method and cost"), status3.indexOf("## Method and cost") + 2400)
  );
  check(
    "the verdict counts them, keeps the grade off STRONG, and the headline carries them",
    /- Closing paragraph: 2 sentence\(s\) asserted something this mission's own record contradicts/.test(status3) && /2 still stand, which is why this run is not graded STRONG/.test(status3) && /2 sentence\(s\) in the closing paragraph the record contradicts/.test(status3),
    status3.slice(0, 400)
  );
  check("and the paragraph itself is left exactly as the leader wrote it", /The leak is fixed, because truncate\(\) slices its input to a fixed limit\./.test(status3.slice(status3.indexOf("## What the collective concluded"), status3.indexOf("## First action"))));

  console.log("== the conclusion repair pass (one second chance for a sentence the record contradicts) ==");
  // Same mission, with the config file gone: both passes are back on, and this is the one that answers the
  // closing paragraph. The stub rewrites the first sentence so it restates the rejection instead of asserting
  // it, and gives the second up with a reason — the two honest outcomes, told apart by name.
  await fs.rm(path.join(tmp, "design-mcp.config.json"), { force: true });
  seenPrompts.length = 0;
  const run4 = await call("collective_run", { mission: "Close the loop on the cleaning change.", workers: 2 });
  check("a fourth mission starts with both passes on by default", !run4.error && /Mission started \(job c-/.test(run4.text), run4.text.slice(0, 200));
  let status4 = "";
  for (let i = 0; i < 80; i++) {
    const st = await call("design_status");
    status4 = st.text;
    if (/DONE|FAILED/.test(st.text)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("the dossier keeps the sentences that contradicted the record, with the reason for each", /2 sentence\(s\) contradict the record:/.test(status4) && /the record says: the mission's own gate rejected this finding \(quote-not-found\)/.test(status4), status4.slice(status4.indexOf("## The conclusion,"), status4.indexOf("## The conclusion,") + 900));
  check(
    "the pass reports one sentence rewritten and one given up, by number",
    /## The conclusion repair pass \(one second chance for a sentence the record contradicts\)/.test(status4) && /2 flagged sentence\(s\) back/.test(status4) && /1 were rewritten without contradicting the record, 1 were given up with a reason, 0 left unaddressed/.test(status4),
    status4.slice(status4.indexOf("## The conclusion repair"), status4.indexOf("## The conclusion repair") + 700)
  );
  check("the sentence the leader gave up is named with its reason, not silently dropped", /the leader gave up a sentence: "The rewrite is already in src\/cleaner-core\.ts\." — the file list has no src\/cleaner-core\.ts/.test(status4), status4.slice(status4.indexOf("## The conclusion repair"), status4.indexOf("## The conclusion repair") + 1200));
  check(
    "the conclusion the owner reads is the repaired one, and no longer asserts the deleted finding",
    (() => {
      const section = status4.slice(status4.indexOf("## What the collective concluded"), status4.indexOf("## First action"));
      return /The claim that truncate\(\) slices its input to a fixed limit was rejected by the server and is carried as unverified\./.test(section) && !/The leak is fixed, because/.test(section) && !/cleaner-core/.test(section);
    })(),
    status4.slice(status4.indexOf("## What the collective concluded"), status4.indexOf("## What the collective concluded") + 600)
  );
  check("the pass says what the rewrite was checked against, so the wording is not a promise", /Every rewrite went back through the same check at the same standard/.test(status4));
  check(
    "the method lines say how the conclusion fared, and what is left of it",
    /- conclusion: 2 sentence\(s\) of the closing paragraph contradicted this mission's own record/.test(status4) && /- conclusion repair: one pass, 1 model call\(s\)\. 1 sentence\(s\) were rewritten and re-checked against the record; 1 were given up by the leader with a reason/.test(status4),
    status4.slice(status4.indexOf("## Method and cost"), status4.indexOf("## Method and cost") + 2600)
  );
  check(
    "the verdict counts the settled sentences without treating them as a judgement",
    /- Closing paragraph: 2 sentence\(s\) asserted something this mission's own record contradicts/.test(status4) && /One repair pass settled 1 of them by rewriting the sentence and 1 by the leader giving it up with a reason/.test(status4) && !/still stand, which is why/.test(status4),
    status4.slice(0, 500)
  );
  check(
    "a settled sentence no longer rides in the headline a poller reads",
    (() => {
      const header = status4.split("\n").find((l) => /^verdict /.test(l)) ?? "";
      return header.length > 0 && !/closing paragraph the record contradicts/.test(header);
    })(),
    status4.split("\n").find((l) => /^verdict /.test(l)) ?? "(no headline)"
  );
  check(
    "the repair prompt carries the record's own words and the number of each sentence",
    seenPrompts.some((p) => /A CONCLUSION THE RECORD CONTRADICTS/.test(p) && /1\. \[reintroduced-rejection\] answer — you wrote: "The leak is fixed/.test(p) && /the record says: the mission's own gate rejected this finding \(quote-not-found\)/.test(p) && /2\. \[unknown-file\] answer/.test(p)),
    `prompts captured: ${seenPrompts.length}; conclusion: ${seenPrompts.filter((p) => /A CONCLUSION THE RECORD CONTRADICTS/.test(p)).length}`
  );
  check(
    "and it hands over the real file list, so a file that is not in it is a rule it can follow",
    seenPrompts.some((p) => /A CONCLUSION THE RECORD CONTRADICTS/.test(p) && /=== THE FILES THIS REPOSITORY HAS/.test(p) && /\bsrc\/util\.ts\b/.test(p)),
    seenPrompts.find((p) => /A CONCLUSION THE RECORD CONTRADICTS/.test(p))?.slice(-500) ?? "(no conclusion prompt)"
  );
  check(
    "the prompt says the pass answers only what it was handed, and gives one move for each",
    seenPrompts.some((p) => /A CONCLUSION THE RECORD CONTRADICTS/.test(p) && /Answer ONLY the numbered sentences below/.test(p) && /Do not rewrite the rest of the conclusion/.test(p) && /give it up with a reason/.test(p))
  );
  check(
    "and the dossier says the same thing about what was not touched",
    /Nothing else in the conclusion was touched/.test(status4) && /a repair answers the sentences it was handed, by number/.test(status4)
  );

  console.log("== local delegation (Ollama, off by default) ==");
  // The memory-staleness test above deliberately truncated src/util.ts so one of its entries had to
  // retire. The local missions run their audit against real exports, so the fixture goes back first —
  // this is test setup restoring its own fixture, not the server repairing anything.
  await fs.writeFile(path.join(tmp, "src", "util.ts"), FIXTURE["src/util.ts"]);
  const lmOff = await call("local_mode");
  check("the status says the mode is off and who set it that way", !lmOff.error && /local mode: off \(config default/.test(lmOff.text), lmOff.text.slice(0, 300));
  check("and that the config, not a runtime flip, decided this", !lmOff.error && /config default; flip it with local_mode/.test(lmOff.text));
  // Config written BEFORE these checks (this is also where the default roles assertion at the top is safe:
  // it already ran). Local points at a closed port first, so the flip-on health check can be seen refusing.
  const configPath = path.join(tmp, "design-mcp.config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ local: { enabled: false, host: "http://127.0.0.1:9", model: "stub-coder:latest" } }, null, 2)
  );
  const flipBroken = await call("local_mode", { set: "on" });
  check("flipping on without a reachable Ollama refuses, with the reason", flipBroken.error && /Local mode stays off/.test(flipBroken.text) && /unreachable/.test(flipBroken.text), flipBroken.text.slice(0, 300));
  check("the refusal tells the owner the exact next move", flipBroken.error && /ollama serve|ollama pull/.test(flipBroken.text), flipBroken.text.slice(0, 400));

  await fs.writeFile(configPath, JSON.stringify({ local: { enabled: false, host: `http://127.0.0.1:${ollamaPort}`, model: "stub-coder:latest" } }, null, 2));
  const flipOk = await call("local_mode", { set: "on", model: "stub-coder:latest" });
  check("a healthy flip-on turns the mode on", !flipOk.error && /Local mode is ON \(stub-coder:latest\)/.test(flipOk.text), flipOk.text.slice(0, 300));
  check("the flip records that Ollama answered and the model is present", !flipOk.error && /Ollama answered and the model is present/.test(flipOk.text));
  const lmOn = await call("local_mode");
  check("the status now says ON and names the runtime flip", !lmOn.error && /local mode: ON \(set with local_mode/.test(lmOn.text), lmOn.text.slice(0, 400));

  // Mission one: the local model writes an invented import. The mechanical check rejects it, the retry
  // is handed the concrete reason and fails the same way, so the council takes the unit over.
  ollamaPolicy.mode = "bad-import";
  const runL1 = await call("collective_run", { mission: "Use the local coder model to draft the normaliseAll helper.", workers: 2 });
  check("the local mission starts", !runL1.error && /Mission started/.test(runL1.text), runL1.text.slice(0, 200));
  let statusL1 = "";
  for (let i = 0; i < 100; i++) {
    const st = await call("design_status");
    statusL1 = st.text;
    if (/DONE|FAILED/.test(st.text)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("the local mission completes even though the local model failed", /DONE/.test(statusL1), statusL1.slice(0, 300));
  check("the dossier has a local delegation section", /## Local delegation \(Ollama\)/.test(statusL1), statusL1.slice(0, 200));
  check("the failed write is named as rejected-and-taken-over, not softened", /rejected-and-taken-over/.test(statusL1) && /council takes (?:this|the) unit over/.test(statusL1), statusL1.slice(statusL1.indexOf("## Local delegation"), statusL1.indexOf("## Local delegation") + 700));
  check("the invented import is the concrete reject the audit gave", /normaliseAll|extra-cleaner|deep-clean/.test(statusL1.slice(statusL1.indexOf("## Local delegation"), statusL1.indexOf("## Local delegation") + 1500)) || /deep-clean/.test(statusL1), statusL1.slice(statusL1.indexOf("## Local delegation"), statusL1.indexOf("## Local delegation") + 1500));
  check("the one retry is visible: two attempts, both recorded", /attempt 1 \(the raw local output/.test(statusL1) && /attempt 2 \(the raw local output/.test(statusL1), statusL1.slice(statusL1.indexOf("## Local delegation"), statusL1.indexOf("## Local delegation") + 2200));
  check("the takeover prompt tells the council to redo the unit from real source", seenPrompts.some((p) => /THE LOCAL MODEL TRIED THIS UNIT FIRST AND DID NOT PASS/.test(p) && /Do not copy any of its code; the audit already deleted it/.test(p)), `local takeover prompts: ${seenPrompts.filter((p) => /THE LOCAL MODEL TRIED/.test(p)).length}`);
  const leftoverAfterFail = await fs.stat(path.join(tmp, "src", "extra-cleaner.ts")).catch(() => null);
  check("the failed write is gone from disk: the snapshot revert leaves nothing behind", leftoverAfterFail === null);
  check("the counters count one delegated, one audit-rejected", /1 delegated · 0 audit-passed · 1 audit-rejected/.test((await call("local_mode")).text), (await call("local_mode")).text.slice(0, 500));

  // Mission two: the local model writes clean code. The ladder passes everything and the file stays.
  ollamaPolicy.mode = "good";
  const runL2 = await call("collective_run", { mission: "Take the normaliseAll helper from the local model and keep it.", workers: 2 });
  check("the second local mission starts", !runL2.error && /Mission started/.test(runL2.text), runL2.text.slice(0, 200));
  let statusL2 = "";
  for (let i = 0; i < 100; i++) {
    const st = await call("design_status");
    statusL2 = st.text;
    if (/DONE|FAILED/.test(st.text)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("the applied outcome is named", /applied|applied-with-retry/.test(statusL2.slice(statusL2.indexOf("## Local delegation"), statusL2.indexOf("## Local delegation") + 700)), statusL2.slice(statusL2.indexOf("## Local delegation"), statusL2.indexOf("## Local delegation") + 700));
  const kept = await fs.readFile(path.join(tmp, "src", "extra-cleaner.ts"), "utf8").catch(() => "");
  check("the audited file is on disk with the local model's content, kept", kept === GOOD_HELPER || /normaliseAll/.test(kept), kept.slice(0, 200));
  check("the write is marked kept in the dossier", /extra-cleaner\.ts \(kept/.test(statusL2), statusL2.slice(statusL2.indexOf("## Local delegation"), statusL2.indexOf("## Local delegation") + 800));
  check("the reason says the whole ladder ran, in order", /deterministic checks, import check, then the council spec review/.test(statusL2), statusL2.slice(statusL2.indexOf("## Local delegation"), statusL2.indexOf("## Local delegation") + 900));
  const lmAfter = await call("local_mode");
  check("lifetime counters: 2 delegated, 1 audit-passed, 1 audit-rejected", !lmAfter.error && /2 delegated · 1 audit-passed · 1 audit-rejected/.test(lmAfter.text), lmAfter.text.slice(0, 500));
  // The request the stub actually received: the per-request values are the config's, not hardcoded ones.
  const lastLocal = JSON.parse(ollamaRequests.filter((r) => r.url === "/api/generate").at(-1).body);
  check("each request carries the configured model and keep_alive", lastLocal.model === "stub-coder:latest" && lastLocal.keep_alive === "5m", JSON.stringify(lastLocal).slice(0, 200));
  check("each request carries num_ctx, temperature and num_thread from the config", lastLocal.options.num_ctx === 8192 && lastLocal.options.temperature === 0.1 && lastLocal.options.num_thread === 5, JSON.stringify(lastLocal.options)) ;
  check("the leader's local routing rule reached the plan prompt", seenPrompts.some((p) => /optional local delegation/.test(p) && /When in doubt keep it/.test(p)), seenPrompts.find((p) => /optional local delegation/.test(p))?.slice(0, 200));

  const flipOff = await call("local_mode", { set: "off" });
  check("flipping off announces the immediate stop", !flipOff.error && /Local mode is OFF/.test(flipOff.text) && /aborted/.test(flipOff.text), flipOff.text.slice(0, 300));
  const lmAfterOff = await call("local_mode");
  check("the status returns to off, recorded as a runtime decision", !lmAfterOff.error && /local mode: off \(set with local_mode/.test(lmAfterOff.text), lmAfterOff.text.slice(0, 300));

  console.log("== agent_run: off by default, and the refusal carries the fix ==");
  const agentStatus = await call("agent_run");
  check("agent_run reports itself OFF without a model call", !agentStatus.error && /agent_run is OFF/.test(agentStatus.text), agentStatus.text.slice(0, 200));
  check("...and names the config key to change", /agent\.enabled/.test(agentStatus.text));
  check("...and says writes are read-only until a directory is named", /read-only until you name a directory/.test(agentStatus.text));
  check("the lifetime counters start at zero and are shown", /0 run\(s\)/.test(agentStatus.text));
  const agentRefused = await call("agent_run", { task: "add a helper to the fixture and run its tests" });
  check("a run is refused before anything is sent", agentRefused.error && /agent_run is OFF/.test(agentRefused.text), agentRefused.text.slice(0, 220));
  // The same rule the Hands section states: no argument enables it. The schema has no such field, and the
  // server reads only the config file, so a caller that names one is ignored rather than obeyed.
  const agentSneaky = await call("agent_run", { task: "add a helper to the fixture", enabled: true });
  check("...and a caller cannot enable it by asking", agentSneaky.error && /agent_run is OFF/.test(agentSneaky.text), agentSneaky.text.slice(0, 220));

  const missionPrompt = await client.getPrompt({ name: "collective_mission", arguments: { mission: "ship the cleaning change" } });
  check("the mission prompt carries the whole protocol", /Run it as the collective/.test(missionPrompt.messages?.[0]?.content?.text ?? "") && /CITATION CONTRACT/.test(missionPrompt.messages[0].content.text));
} finally {
  await client.close().catch(() => {});
  if (process.env.KEEP_TMP) console.error(`KEEP_TMP: tmp kept at ${tmp}`);
  else await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\nSMOKE FAIL: ${failures} check(s)` : "\nSMOKE PASS");
process.exit(failures ? 1 : 0);
