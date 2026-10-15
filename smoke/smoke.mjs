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
  "notes.md": "# Fixture notes\n\nThe fixture exists so the index has something real to read.\n",
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

// A stub host that answers the way Cursor/Freebuff would: it recognises a leader call, a worker call and
// a synthesis call, and it deliberately includes one invented quote so the server has something to reject.
const INVENTED_QUOTE = "const cache = new Map<string, string>();";
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
    { claim: "normalise() memoises its results", path: "src/util.ts", lines: [9, 9], quote: INVENTED_QUOTE, confidence: "low" },
  ],
  steps: [],
  unknowns: ["whether callers depend on the exact casing"],
  openQuestions: [],
  verdict: "ok",
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
  // Round two carries the same "YOUR UNIT:" line, so it has to be recognised first.
  if (/now reading what the other copies of yourself found/.test(prompt)) return answer(JSON.stringify(peerResponse(unit?.[1] ?? "explore-util")));
  if (unit) return answer(JSON.stringify(workerReport(unit[1])));
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
        answer: "One exported cleaner exists (src/util.ts). The claim that it memoises its results was rejected by the server and is carried as unverified.",
        plan: [{ step: "Route new cleaning through the existing export", path: "src/util.ts", intent: "Reuse normalise() instead of adding a second cleaner", risk: "low" }],
        risks: [],
        unverified: ["whether normalise() memoises its results"],
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
    "code_index", "code_digest", "code_context", "code_verify_cites", "collective_plan", "collective_run", "collective_report", "collective_memory",
    // waking the collective, and the owner's own skills
    "collective_hello", "collective_install", "skills_list", "skills_read",
  ];
  check(`33 tools registered (${names.length} found)`, names.length === expected.length, names.join(","));
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
  const allGood = await call("code_verify_cites", { claims: [{ path: "src/util.ts", lines: [5, 5], quote: "export const LIMIT = 40;" }] });
  check("a fully verified set says so", !allGood.error && /Every claim checked out/.test(allGood.text), allGood.text.slice(0, 160));

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
  check("the rejected claim is quarantined below the evidence", status.indexOf("## Rejected") > status.indexOf("## Evidence") && /memoises its results/.test(status.slice(status.indexOf("## Rejected"))));
  check("the closing pass ran and its conclusions are separated from the evidence", /## What the collective concluded/.test(status) && /was rejected by the server/.test(status));
  check("the leader's own unverified list is carried into the dossier", /## Unverified \(claimed, but not checkable from the source we read\)/.test(status) && /memoises/.test(status.slice(status.indexOf("## Unverified"))));
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

  const memList = await call("collective_memory");
  check("memory records what the mission established, with its provenance", !memList.error && /\[established ×\d+\] src\/util\.ts:\d+-\d+: /.test(memList.text), memList.text.slice(0, 300));
  check("memory records what the gate rejected, so nobody repeats it", !memList.error && /\[rejected/.test(memList.text), memList.text.slice(0, 300));
  check("memory says it is a hint list, never a citation", !memList.error && /never a citation/.test(memList.text));
  const ruling = await call("collective_memory", { action: "ruling", text: "never let the newsletter double-send" });
  check("the owner can record a ruling", !ruling.error && /Recorded as a ruling/.test(ruling.text), ruling.text.slice(0, 200));
  const badRuling = await call("collective_memory", { action: "ruling", text: "no" });
  check("a ruling that is not a decision is refused", badRuling.error && badRuling.text.includes("needs `text`"));

  seenPrompts.length = 0;
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
  check("the second dossier reports what it was given", /were given to this run as hints/.test(status2), status2.slice(0, 400));
  check("an entry confirmed again is recorded as reinforced, not as new", /nothing new, but \d+ earlier entr/.test(status2), status2.slice(0, 400));

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
  check("it says where each skill lives and what goes with it", !skills.error && /SKILL\.md/.test(skills.text) && skills.text.includes(".claude/skills/make-it-fast"), skills.text.slice(0, 400));
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
  check("it names the open missions on disk", !hello.error && /## Open work/.test(hello.text) && /m-[a-z0-9]+ — /.test(hello.text), hello.text.slice(0, 600));
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

  const focusPrompt = await client.getPrompt({ name: "focus_contract", arguments: { task: "the cleaning change" } });
  const focusText = focusPrompt.messages?.[0]?.content?.text ?? "";
  check("the focus contract is about this repository only", focusText.includes("this repository only") && focusText.includes("the cleaning change"));
  check("the focus contract names the real commands and rule files", focusText.includes("notes.md") && /commands:/.test(focusText), focusText.slice(0, 300));
  check("the focus contract demands proof, not claims", /Prove it by running it/.test(focusText) && /code_verify_cites/.test(focusText));
  const missionPrompt = await client.getPrompt({ name: "collective_mission", arguments: { mission: "ship the cleaning change" } });
  check("the mission prompt carries the whole protocol", /Run it as the collective/.test(missionPrompt.messages?.[0]?.content?.text ?? "") && /CITATION CONTRACT/.test(missionPrompt.messages[0].content.text));
} finally {
  await client.close().catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\nSMOKE FAIL: ${failures} check(s)` : "\nSMOKE PASS");
process.exit(failures ? 1 : 0);
