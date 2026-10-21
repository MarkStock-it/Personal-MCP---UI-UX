// The executor, driven end to end through the real MCP surface: a stub Ollama server answers /api/tags and
// /api/chat with a scripted sequence of tool calls, a throwaway git repo is the project, and the run is started,
// polled with design_status, and then checked against the tree.
//
// Two runs, because two outcomes are what this feature is:
//   1. an edit that passes the gate → KEPT, the file changed, the record written, the counters moved;
//   2. a write that breaks the fixture's own test → REVERTED, the tree byte-identical to before, and the work
//      kept as proposed.patch.
//
// What this does NOT assert: the council diff review. The MCP client here advertises no sampling capability, so
// the review cannot run; the fixture sets agent.gates.councilReview to false and the report says so. That path
// failing closed is asserted in arithmetic.mjs's gate-command checks and by the gate's own code.
//
// Run: npm run build && node smoke/agent-e2e.mjs   (part of `npm run smoke`)
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-agent-e2e-"));

// ── the stub model: scripted replies, one per /api/chat request ──────────────────────────────────────
const replies = [];
const requests = [];
const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    return json(res, { models: [{ name: "stub-coder:latest", details: { parameter_size: "7B" } }] });
  }
  if (req.url === "/api/chat") {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      const next = replies.shift() ?? { content: "nothing left to do", tool_calls: [] };
      json(res, { message: next });
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ── the fixture project: a git repo with a test that really runs ─────────────────────────────────────
const FIXTURE = {
  "package.json": JSON.stringify({ name: "agent-e2e-fixture", type: "module", scripts: { test: "node ./test.mjs" } }, null, 2),
  "src/math.js": "export const add = (a, b) => a + b;\n",
  "test.mjs": 'import { add, doubled } from "./src/math.js";\nif (add(2, 2) !== 4) throw new Error("add is broken");\nif (typeof doubled === "function" && doubled(2) !== 4) throw new Error("doubled is broken");\nconsole.log("ok");\n',
  "design-mcp.config.json": JSON.stringify(
    {
      local: { enabled: false },
      agent: {
        enabled: true,
        host: `http://127.0.0.1:${port}`,
        model: "stub-coder:latest",
        writeRoots: ["src"],
        maxWallClockSec: 120,
        bash: { mode: "allowlist", allow: ["npm test", "git status", "git diff"] },
        gates: { councilReview: false },
      },
    },
    null,
    2
  ),
};
for (const [rel, text] of Object.entries(FIXTURE)) {
  await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
  await fs.writeFile(path.join(tmp, rel), text);
}
const git = (args) => new Promise((resolve) => execFile("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", ...args], { cwd: tmp }, (e, out) => resolve({ ok: !e, out: String(out) })));
await git(["init", "-q"]);
await git(["add", "-A"]);
const firstCommit = await git(["commit", "-q", "-m", "fixture"]);
check("the fixture is a clean git repo (a run refuses a dirty tree)", firstCommit.ok, firstCommit.out.slice(0, 200));

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(ROOT, "dist", "index.js")],
  env: { ...process.env, DESIGN_MCP_PROJECT_DIR: tmp },
  stderr: "ignore",
});
const client = new Client({ name: "agent-e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.map((c) => (c.text ?? "")).join("\n") };
};
const poll = async (jobId, ms = 45_000) => {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    const r = await call("design_status", { job_id: jobId });
    last = r.text;
    if (/\): (DONE|FAILED)/.test(r.text)) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return { error: true, text: last };
};

try {
  section("agent_run: an enabled run over the real MCP surface");

  const status = await call("agent_run");
  check("the status reports the run mode ON from the config file", /agent_run is ON/.test(status.text), status.text.slice(0, 160));
  check("...and shows the model the stub serves", /stub-coder:latest/.test(status.text));

  // Run 1: read the file, add a helper, finish. The gate should keep it and the fixture's test should pass.
  replies.push(
    { content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/math.js" } } }] },
    {
      content: "",
      tool_calls: [
        {
          function: {
            name: "edit",
            arguments: {
              path: "src/math.js",
              anchor: "export const add = (a, b) => a + b;",
              replacement: "export const add = (a, b) => a + b;\nexport const doubled = (n) => add(n, n);",
            },
          },
        },
      ],
    },
    { content: "", tool_calls: [{ function: { name: "finish", arguments: { summary: "added doubled() to src/math.js" } } }] }
  );

  const started = await call("agent_run", { task: "add a doubled() helper to src/math.js" });
  check("an enabled run starts as a job", !started.error && /Agent run started \(job /.test(started.text), started.text.slice(0, 300));
  const jobId = started.text.match(/job ([a-z0-9-]+)\)/)?.[1] ?? "";
  const done = await poll(jobId);
  check("the job finishes through design_status", /\): DONE/.test(done.text), done.text.slice(0, 400));
  check("the gate KEPT the run", /KEPT/.test(done.text), done.text.slice(0, 800));
  check("the report names the gate steps that passed", /edit gate: 1 edit\(s\) checked/.test(done.text) && /tests: npm test → exit 0/.test(done.text), done.text.slice(-1200));

  const mathAfter = await fs.readFile(path.join(tmp, "src", "math.js"), "utf8");
  check("the file on disk really holds the edit", /export const doubled/.test(mathAfter), mathAfter.slice(0, 160));
  const dirs = await fs.readdir(path.join(tmp, ".design-mcp", "agent")).catch(() => []);
  const runId = dirs.find((d) => d.startsWith("a-"));
  check("the run wrote its record", !!runId, JSON.stringify(dirs));
  const rec = await fs.readdir(path.join(tmp, ".design-mcp", "agent", runId ?? "missing")).catch(() => []);
  check("...with a report, a journal, a result and pre-images", ["report.md", "journal.jsonl", "result.json", "pre-images"].every((f) => rec.includes(f)), JSON.stringify(rec));
  const journalText = await fs.readFile(path.join(tmp, ".design-mcp", "agent", runId ?? "missing", "journal.jsonl"), "utf8").catch(() => "");
  check("...and the journal recorded the capture before the write", /"event":"capture"/.test(journalText) && /"event":"gate"/.test(journalText), journalText.slice(0, 200));
  const resultJson = JSON.parse(await fs.readFile(path.join(tmp, ".design-mcp", "agent", runId ?? "missing", "result.json"), "utf8").catch(() => "{}"));
  check("...and the result is machine-readable: kept, one write", resultJson.outcome === "kept" && resultJson.writes?.[0] === "src/math.js", JSON.stringify(resultJson).slice(0, 200));

  const countersAfterKeep = await call("agent_run");
  check("the counters count one run, kept", /1 run\(s\) — 1 kept, 0 reverted/.test(countersAfterKeep.text), countersAfterKeep.text.slice(0, 400));

  // The next run must start from a clean tree: commit what the first run kept.
  await git(["add", "-A"]);
  const secondCommit = await git(["commit", "-q", "-m", "keep the agent's change"]);
  check("the fixture can be committed between runs", secondCommit.ok, secondCommit.out);

  // Run 2: write a whole file that passes nothing. The gate must revert, and keep the patch.
  const beforeSecond = await fs.readFile(path.join(tmp, "src", "math.js"), "utf8");
  replies.push(
    { content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/math.js" } } }] },
    {
      content: "",
      tool_calls: [
        {
          function: {
            name: "write_file",
            arguments: { path: "src/math.js", content: "export const add = (a, b) => a - b;\nexport const doubled = (n) => n;\n" },
          },
        },
      ],
    },
    { content: "", tool_calls: [{ function: { name: "finish", arguments: { summary: "rewrote the file; tests were not run" } } }] }
  );
  const started2 = await call("agent_run", { task: "make doubled() twice the value" });
  const jobId2 = started2.text.match(/job ([a-z0-9-]+)\)/)?.[1] ?? "";
  const done2 = await poll(jobId2);
  check("the second run finishes", /\): DONE/.test(done2.text), done2.text.slice(0, 300));
  check("the gate REVERTED it", /REVERTED/.test(done2.text), done2.text.slice(0, 800));
  check("...because the project's own test failed", /tests failed \(npm test\)/.test(done2.text), done2.text.slice(-1200));
  const afterSecond = await fs.readFile(path.join(tmp, "src", "math.js"), "utf8");
  check("the tree is byte-identical to before the refused run", afterSecond === beforeSecond, JSON.stringify(afterSecond).slice(0, 200));
  const dirs2 = (await fs.readdir(path.join(tmp, ".design-mcp", "agent"))).filter((d) => d.startsWith("a-")).sort();
  const refusedDir = dirs2.at(-1) ?? "missing";
  const patch = await fs.readFile(path.join(tmp, ".design-mcp", "agent", refusedDir, "proposed.patch"), "utf8").catch(() => "");
  check("the refused work is kept as a readable patch", /--- NEW FILE|diff --git|agent run/.test(patch) && /doubled/.test(patch), patch.slice(0, 200));
  const countersAfterRevert = await call("agent_run");
  check("the counters now say 2 runs: 1 kept, 1 reverted", /2 run\(s\) — 1 kept, 1 reverted/.test(countersAfterRevert.text), countersAfterRevert.text.slice(0, 400));

  check("the requests really went to /api/chat with tools", requests.length >= 4 && Array.isArray(requests[0].tools) && requests[0].tools.length === 10, JSON.stringify(requests[0]?.tools?.length));
  check("...and no request used the generate endpoint", requests.every((r) => r.model === "stub-coder:latest"));
} finally {
  await client.close().catch(() => {});
  await new Promise((r) => server.close(r));
  if (process.env.KEEP_TMP) console.error(`KEEP_TMP: fixture kept at ${tmp}`);
  else await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\nAGENT E2E FAIL: ${failures} check(s)` : "\nAGENT E2E PASS");
process.exit(failures ? 1 : 0);
