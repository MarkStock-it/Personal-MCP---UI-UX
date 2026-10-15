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
// Stub host: answers sampling calls the way Cursor/Freebuff would.
client.setRequestHandler(CreateMessageRequestSchema, async () => ({
  role: "assistant",
  content: { type: "text", text: "ready (smoke sampling)" },
  model: "smoke-model",
}));
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
  ];
  check(`21 tools registered (${names.length} found)`, names.length === expected.length, names.join(","));
  check("all expected tools present", expected.every((n) => names.includes(n)));

  console.log("== resources + prompts (the playbook is addressable, not only callable) ==");
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  check("11 design:// resources registered", resources.length === 11, uris.join(","));
  check("one resource per playbook topic", ["motion", "scroll", "organic", "typography", "color", "layout", "floor", "rubric", "slop"].every((t) => uris.includes(`design://playbook/${t}`)));
  check("rubric sections resource exists", uris.includes("design://rubric/sections"));
  const readMotion = await client.readResource({ uri: "design://playbook/motion" });
  check("reading a resource returns its content", !!readMotion.contents?.[0]?.text?.includes("Motion"), readMotion.contents?.[0]?.text?.slice(0, 80));
  const { prompts } = await client.listPrompts();
  check("2 prompts registered", prompts.length === 2, prompts.map((p) => p.name).join(","));
  check("premium_pass + motion_review present", ["premium_pass", "motion_review"].every((p) => prompts.some((x) => x.name === p)));
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
} finally {
  await client.close().catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\nSMOKE FAIL: ${failures} check(s)` : "\nSMOKE PASS");
process.exit(failures ? 1 : 0);
