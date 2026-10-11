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
  const expected = ["brief_check", "brief_init", "concepts_generate", "concepts_review", "design_build", "design_critique", "design_report", "design_status", "design_test", "manual_answer", "manual_pending", "providers_config", "providers_test", "usage_report"];
  check(`14 tools registered (${names.length} found)`, names.length === expected.length, names.join(","));
  check("all expected tools present", expected.every((n) => names.includes(n)));

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
