// Drive a long MCP tool call in ONE persistent session, answering manual
// prompts from a handler script until the job completes.
//
//   DESIGN_MCP_PROJECT_DIR=/path/to/site node smoke/drive.mjs <tool> '[json]' <answer-script>
//
// The answer script receives the pending JSON path on argv[1] and must print
// the reply text to stdout (or nothing + exit 1 to stop and leave the prompt
// parked). Polls design_status until the job finishes, then prints the result.
//
// Example: DESIGN_MCP_PROJECT_DIR=/tmp/x node smoke/drive.mjs design_build '{}' ./answer-build.sh
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [tool, argsJson, answerer] = process.argv.slice(2);
if (!tool || !answerer) {
  console.error("usage: DESIGN_MCP_PROJECT_DIR=<dir> node smoke/drive.mjs <tool> '[json]' <answer-script>");
  process.exit(1);
}
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(ROOT, "dist", "index.js")],
  // One-session manual mode: the server waits on parked prompts (up to 1h
  // each) instead of failing, so they can be answered from another tool.
  env: answerer === "wait" ? { ...process.env, DESIGN_MCP_MANUAL_WAIT_MS: "3600000" } : process.env,
  stderr: "ignore",
});
const client = new Client({ name: "drive", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.map((c) => (c.text ?? "")).join("\n") };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let jobId = null;

try {
  const first = await call(tool, argsJson ? JSON.parse(argsJson) : {});
  console.log(first.text.split("\n").slice(0, 4).join("\n"));
  const m = first.text.match(/job ([a-z0-9-]+)/i);
  if (m) jobId = m[1];

  for (let round = 0; round < 40; round++) {
    await sleep(15000);
    const st = await call("design_status", jobId ? { job_id: jobId } : {});
    const tail = st.text.split("\n").slice(-30).join("\n");
    if (answerer === "wait") {
      const pend = await call("manual_pending");
      if (!pend.text.includes("No unanswered")) {
        console.log(`[poll ${round}] waiting on manual answer:\n` + pend.text.split("\n").slice(0, 6).join("\n"));
      } else if (round % 4 === 0) {
        console.log(`[poll ${round}] job running, no prompts parked.\n` + tail.split("\n").slice(-4).join("\n"));
      }
      if (/\b(DONE|FAILED)\b/.test(st.text.split("\n")[0] ?? "")) {
        console.log("=== JOB FINISHED ===\n" + st.text);
        process.exit(/FAILED/.test(st.text.split("\n")[0]) ? 1 : 0);
      }
      continue;
    }
    if (/Manual model input needed|ManualPending|pending-/.test(tail) || /manual_answer/.test(tail)) {
      const pend = await call("manual_pending");
      console.log("--- manual prompts ---\n" + pend.text.split("\n").slice(0, 8).join("\n"));
      const ids = [...pend.text.matchAll(/- ([0-9a-f]{8,}) /g)].map((x) => x[1]);
      if (!ids.length) { console.log("could not parse pending ids; full output:\n" + pend.text); process.exit(2); }
      for (const id of ids) {
        const dir = path.join(process.env.DESIGN_MCP_PROJECT_DIR, ".design-mcp", "manual");
        const file = path.join(dir, `pending-${id}.json`);
        let answer;
        try {
          answer = execFileSync(answerer, [file], { encoding: "utf8", timeout: 120000 });
        } catch (e) {
          console.log(`answerer stopped (exit ${e.status}); prompt ${id} left parked.`);
          process.exit(3);
        }
        if (!answer.trim()) { console.log(`empty answer for ${id}; leaving parked.`); process.exit(3); }
        await fs.mkdir(path.join(dir, "answers"), { recursive: true });
        await fs.writeFile(path.join(dir, "answers", `${id}.json`), JSON.stringify({ text: answer, answeredAt: new Date().toISOString() }));
        console.log(`answered ${id} (${answer.length} chars)`);
      }
      continue;
    }
    if (/\b(DONE|FAILED)\b/.test(st.text.split("\n")[0] ?? "")) {
      console.log("=== JOB FINISHED ===\n" + st.text);
      process.exit(st.text.includes("(build): FAILED") || st.text.includes("(test): FAILED") ? 1 : 0);
    }
    const last = st.text.split("\n").slice(-6).join("\n");
    console.log(`[poll ${round}] ...\n${last}`);
  }
  console.log("drive: timed out waiting for the job");
  process.exit(4);
} finally {
  await client.close().catch(() => {});
}
