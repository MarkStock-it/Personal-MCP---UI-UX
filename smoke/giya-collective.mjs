/**
 * Temporary driver for the Giya design pass: calls the local design MCP over stdio.
 * Usage: node smoke/giya-collective.mjs 'tool {"json":"args"}'
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The server reads its project from DESIGN_MCP_PROJECT_DIR, not from its own cwd — it lives in
// this tool's repo but must digest and critique the Giya checkout.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, DESIGN_MCP_PROJECT_DIR: process.env.DESIGN_MCP_PROJECT_DIR ?? "E:\\Giya-" },
  stderr: "pipe",
});

const client = new Client({ name: "giya-collective", version: "0.1.0" });
await client.connect(transport);

for (const raw of process.argv.slice(2)) {
  const space = raw.indexOf(" ");
  const name = space === -1 ? raw : raw.slice(0, space);
  const args = space === -1 ? {} : JSON.parse(raw.slice(space + 1));
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    console.log(`\n===== ${name} =====\n${text.slice(0, 12000)}`);
    if (res.isError) console.log("(tool reported isError)");
  } catch (err) {
    console.log(`\n===== ${name} failed =====\n${err.message}`);
  }
}

await client.close();
