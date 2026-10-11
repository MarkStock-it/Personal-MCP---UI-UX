// One-shot MCP tool caller. Useful for manual-provider sessions and debugging:
//   DESIGN_MCP_PROJECT_DIR=/path/to/site node smoke/call.mjs <tool> '{"arg":"val"}'
// Exit 0 on success, 2 when the tool itself returns an error (e.g. ManualPending).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [tool, argsJson] = process.argv.slice(2);
if (!tool) {
  console.error("usage: DESIGN_MCP_PROJECT_DIR=<dir> node smoke/call.mjs <tool> '[json args]'");
  process.exit(1);
}
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(ROOT, "dist", "index.js")],
  env: process.env,
  stderr: "ignore",
});
const client = new Client({ name: "call", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
try {
  const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
  console.log(r.content.map((c) => c.text ?? "").join("\n"));
  process.exitCode = r.isError ? 2 : 0;
} finally {
  await client.close().catch(() => {});
}
