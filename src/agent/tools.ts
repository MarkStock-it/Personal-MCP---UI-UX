/**
 * The tool surface `agent_run` gives the model, and nothing else.
 *
 * Shape rules, all of them deliberate:
 *   - Every tool returns text (usually JSON). A refusal is data, not an exception: the model gets the reason
 *     and can correct itself in the next turn, which is the difference between a loop that recovers and a
 *     loop that repeats the same failed call.
 *   - Every mutating tool goes through `sandbox.resolveWrite` and then `journal.capture` BEFORE the write, so
 *     there is no path to a modified file that cannot be restored.
 *   - `write_file` on an existing file requires that the run has read it. That one rule kills most "rewrote
 *     the file from a guess" failures and costs one Set.
 *   - `run` is the only tool that takes a command string, and it is judged by `bash.judge` before anything is
 *     spawned. `run_audit` takes a NAME, never a command, and only runs strings from the owner's config.
 *   - There is no delete, no git write, no install, no network and no spawn. A deletion can be proposed in
 *     `finish`; the owner applies it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, LocalConfig } from "../config.js";
import type { RepoIndex } from "../codebase/store.js";
import { packContext, renderPack } from "../codebase/pack.js";
import { findReferences, renderReferences } from "../codebase/refs.js";
import { toPosix, resolveRead, resolveWrite, type Sandbox } from "./sandbox.js";
import { envSubset, judge, shellArmed } from "./bash.js";
import { capture, recordCommand, recordRefusal, type RunnerJournal } from "./journal.js";
import { run as runCmd } from "../util/exec.js";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  /** Set by `finish`: the loop ends here. */
  stop?: boolean;
}

export interface WriteRecord {
  rel: string;
  before: string | null;
  after: string;
  /** A line from the new content and where it sits, so the edit gate has something real to check. */
  anchor: string;
  line: number;
}

export interface ToolContext {
  sandbox: Sandbox;
  journal: RunnerJournal;
  index: RepoIndex;
  cfg: AgentConfig;
  audit: LocalConfig["audit"];
  log: (m: string) => void;
  /** Paths read this run: an existing file must be read before it is replaced. */
  readPaths: Set<string>;
  writes: WriteRecord[];
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… clipped ${text.length - max} chars (tool output cap) …`;

const refuse = (reason: string): ToolResult => ({ text: JSON.stringify({ refused: reason }) });

/** First line that differs from the pre-image, and its 1-based line number in the NEW file. */
export function firstChangedLine(before: string | null, after: string): { line: number; text: string } {
  const b = (before ?? "").split("\n");
  const a = after.split("\n");
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      for (let k = i; k < a.length; k++) if (a[k].trim()) return { line: k + 1, text: a[k].trim() };
      return { line: i + 1, text: (a[i] ?? "").trim() };
    }
  }
  return { line: a.length, text: (a[a.length - 1] ?? "").trim() };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Count an anchor in a file. Exact text first; if that finds nothing, one whitespace-insensitive pass, which is
 * the same relaxation the edit gate makes. More than one occurrence is never placed — it is refused with the
 * count, because picking one is how an edit lands in the wrong branch of an if.
 */
export function findAnchor(text: string, anchor: string): { index: number; length: number; count: number } {
  const exact = text.split(anchor).length - 1;
  if (exact > 0) return { index: text.indexOf(anchor), length: anchor.length, count: exact };
  const tokens = anchor.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { index: -1, length: 0, count: 0 };
  const re = new RegExp(tokens.map(escapeRe).join("\\s+"), "g");
  const matches = [...text.matchAll(re)];
  if (!matches.length) return { index: -1, length: 0, count: 0 };
  const first = matches[0];
  return { index: first.index ?? -1, length: first[0].length, count: matches.length };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file inside the project. Returns the file's own line numbers. Read a file before you write it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root" },
          startLine: { type: "integer", description: "1-based first line (default 1)" },
          endLine: { type: "integer", description: "1-based last line (default 400 lines from startLine)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory of the project, breadth first, skipping .git/node_modules/.design-mcp/dist.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to the project root (default .)" },
          depth: { type: "integer", description: "How deep to walk (default 2, max 4)" },
          limit: { type: "integer", description: "Maximum entries (default 200)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search the indexed source files with a regular expression. Returns path, line and text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression" },
          glob: { type: "string", description: "Only paths containing this substring, e.g. src/collective/" },
          maxResults: { type: "integer", description: "Default 40" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "who_refs",
      description: "Where a name is declared and used, as a word-boundary text scan (not semantic analysis).",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_context",
      description: "A token-budgeted pack of the most relevant files for a question, with real line numbers.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, tokens: { type: "integer" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a complete file inside the directories this run may write. Read an existing file first.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace one exact (or whitespace-insensitive) occurrence of anchor with replacement. The anchor must occur exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          anchor: { type: "string", description: "The existing text to replace, unique in the file" },
          replacement: { type: "string" },
        },
        required: ["path", "anchor", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run",
      description: "Run one command according to this server's command policy. Returns exit code and output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Directory inside the project (default the project root)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_audit",
      description: "Run one of the project's configured gates (typecheck, lint or tests). Takes a name, never a command.",
      parameters: {
        type: "object",
        properties: { which: { type: "string", enum: ["typecheck", "lint", "test"] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the run with what you changed and anything you could not do. The gate still decides what is kept.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          notDone: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
      },
    },
  },
];

const READ_MAX_BYTES = 512 * 1024;

async function readTextFile(ctx: ToolContext, raw: unknown): Promise<{ rel: string; text: string } | ToolResult> {
  const r = await resolveRead(ctx.sandbox, str(raw));
  if (!r.ok) return refuse(r.reason);
  let buf: Buffer;
  try {
    buf = await fs.readFile(r.abs);
  } catch {
    return refuse(`${r.rel}: no such file`);
  }
  if (buf.length > READ_MAX_BYTES) {
    return refuse(`${r.rel}: ${buf.length} bytes is over the ${READ_MAX_BYTES}-byte read cap; read a smaller file or use search`);
  }
  if (buf.includes(0)) return refuse(`${r.rel}: looks binary; not read as text`);
  return { rel: r.rel, text: buf.toString("utf8") };
}

const isRefusal = (v: { rel: string; text: string } | ToolResult): v is ToolResult => "text" in v && !("rel" in v);

export async function executeTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "read_file": {
      const got = await readTextFile(ctx, args.path);
      if (isRefusal(got)) {
        await recordRefusal(ctx.journal, got.text);
        return got;
      }
      ctx.readPaths.add(got.rel);
      const lines = got.text.split("\n");
      const start = Math.max(1, num(args.startLine) ?? 1);
      const end = Math.min(lines.length, num(args.endLine) ?? start + 399);
      if (start > lines.length) return refuse(`${got.rel}: startLine ${start} is past the end (${lines.length} lines)`);
      const body = lines
        .slice(start - 1, end)
        .map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
        .join("\n");
      return {
        text: `${got.rel} (${lines.length} lines${end < lines.length ? `, showing ${start}-${end}` : ""}):\n${clip(body, 48_000)}`,
      };
    }

    case "list_files": {
      const dir = str(args.path) || ".";
      const base = await resolveRead(ctx.sandbox, dir);
      if (!base.ok) return refuse(base.reason);
      const depth = Math.min(Math.max(num(args.depth) ?? 2, 1), 4);
      const limit = Math.min(Math.max(num(args.limit) ?? 200, 1), 500);
      const skip = new Set([".git", "node_modules", ".design-mcp", "dist", "coverage", "build", "out"]);
      const found: string[] = [];
      const walk = async (abs: string, rel: string, level: number): Promise<void> => {
        if (found.length >= limit || level > depth) return;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(abs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (found.length >= limit) return;
          if (e.name.startsWith(".") && e.name !== ".github") continue;
          const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
          if (e.isDirectory()) {
            if (skip.has(e.name)) continue;
            await walk(path.join(abs, e.name), childRel, level + 1);
          } else if (e.isFile()) {
            found.push(childRel);
          }
        }
      };
      await walk(base.abs, base.rel === "." ? "." : base.rel, 1);
      return { text: `${found.length} entr${found.length === 1 ? "y" : "ies"} :: ${found.join("\n")}${found.length >= limit ? `\n(hit the ${limit} entry cap; narrow the path or the depth)` : ""}` };
    }

    case "search": {
      const pattern = str(args.pattern);
      if (!pattern) return refuse("search needs a pattern");
      let re: RegExp;
      try {
        re = new RegExp(pattern, "g");
      } catch (e) {
        return refuse(`that pattern is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
      }
      const glob = str(args.glob);
      const max = Math.min(Math.max(num(args.maxResults) ?? 40, 1), 120);
      const matches: string[] = [];
      let scanned = 0;
      let bytes = 0;
      for (const f of ctx.index.files) {
        if (matches.length >= max || bytes > 1_500_000) break;
        if (glob && !f.path.includes(glob)) continue;
        scanned++;
        let text: string;
        try {
          text = await fs.readFile(path.join(ctx.sandbox.root, f.path), "utf8");
        } catch {
          continue;
        }
        bytes += text.length;
        for (const [i, line] of text.split("\n").entries()) {
          re.lastIndex = 0;
          if (!re.test(line)) continue;
          matches.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (matches.length >= max) break;
        }
      }
      return {
        text: `${matches.length} match(es) in ${scanned} scanned file(s)${matches.length >= max ? " (hit the result cap)" : ""}\n${matches.join("\n")}`,
      };
    }

    case "who_refs": {
      const name = str(args.name).trim();
      if (!name) return refuse("who_refs needs a name");
      const report = await findReferences({ projectRoot: ctx.sandbox.root, index: ctx.index, name, maxPerFile: 8 });
      return { text: clip(renderReferences(report), 24_000) };
    }

    case "read_context": {
      const query = str(args.query);
      if (!query) return refuse("read_context needs a query");
      const budget = Math.min(Math.max(num(args.tokens) ?? 4000, 500), 12_000);
      const pack = await packContext(ctx.sandbox.root, ctx.index, { query, budget });
      return { text: clip(renderPack(pack), 64_000) };
    }

    case "write_file": {
      const r = await resolveWrite(ctx.sandbox, str(args.path));
      if (!r.ok) {
        await recordRefusal(ctx.journal, r.reason);
        return refuse(r.reason);
      }
      const content = str(args.content);
      const size = Buffer.byteLength(content);
      if (size > ctx.cfg.maxWriteKB * 1024) {
        return refuse(`${r.rel}: ${size} bytes exceeds agent.maxWriteKB (${ctx.cfg.maxWriteKB} KB)`);
      }
      const before = await fs.readFile(r.abs, "utf8").catch(() => null);
      if (before !== null && !ctx.readPaths.has(r.rel)) {
        return refuse(`${r.rel}: read it before replacing it — a whole-file rewrite from memory is how a file loses code it still needed`);
      }
      try {
        await capture(ctx.journal, r.abs, r.rel);
        await fs.mkdir(path.dirname(r.abs), { recursive: true });
        await fs.writeFile(r.abs, content);
      } catch (e) {
        return refuse(`${r.rel}: the write failed (${e instanceof Error ? e.message : String(e)})`);
      }
      const changed = firstChangedLine(before, content);
      ctx.writes.push({ rel: r.rel, before, after: content, anchor: changed.text, line: changed.line });
      ctx.log(`  write ${r.rel} (${size} bytes${before === null ? ", new file" : ""})`);
      return { text: JSON.stringify({ written: r.rel, bytes: size, created: before === null }) };
    }

    case "edit": {
      const r = await resolveWrite(ctx.sandbox, str(args.path));
      if (!r.ok) {
        await recordRefusal(ctx.journal, r.reason);
        return refuse(r.reason);
      }
      const anchor = str(args.anchor);
      if (!anchor) return refuse("edit needs an anchor: the existing text to replace");
      const before = await fs.readFile(r.abs, "utf8").catch(() => null);
      if (before === null) return refuse(`${r.rel}: no such file (use write_file to create it)`);
      const found = findAnchor(before, anchor);
      if (found.count === 0) {
        return refuse(`${r.rel}: the anchor is not in the file (whitespace-insensitive). Read the file and quote an exact line.`);
      }
      if (found.count > 1) {
        return refuse(`${r.rel}: the anchor occurs ${found.count} times, so it is ambiguous; quote more surrounding text until it is unique.`);
      }
      const after = before.slice(0, found.index) + str(args.replacement) + before.slice(found.index + found.length);
      if (Buffer.byteLength(after) > ctx.cfg.maxWriteKB * 1024) {
        return refuse(`${r.rel}: the result would exceed agent.maxWriteKB (${ctx.cfg.maxWriteKB} KB)`);
      }
      try {
        await capture(ctx.journal, r.abs, r.rel);
        await fs.writeFile(r.abs, after);
      } catch (e) {
        return refuse(`${r.rel}: the write failed (${e instanceof Error ? e.message : String(e)})`);
      }
      const line = before.slice(0, found.index).split("\n").length;
      const replacementLine = str(args.replacement).split("\n")[0]?.trim() || firstChangedLine(before, after).text;
      ctx.writes.push({ rel: r.rel, before, after, anchor: replacementLine, line });
      ctx.log(`  edit ${r.rel} at line ${line}`);
      return { text: JSON.stringify({ edited: r.rel, atLine: line, replacedChars: found.length }) };
    }

    case "run": {
      const command = str(args.command).trim();
      const verdict = judge(command, ctx.cfg.bash);
      if (!verdict.ok) {
        await recordRefusal(ctx.journal, verdict.reason);
        return refuse(verdict.reason);
      }
      if (verdict.shell && !shellArmed(ctx.cfg.bash)) {
        const reason = "shell mode is not armed: set agent.bash.mode to \"shell\" AND start the server with DESIGN_MCP_AGENT_SHELL=1";
        await recordRefusal(ctx.journal, reason);
        return refuse(reason);
      }
      let cwd = ctx.sandbox.root;
      if (str(args.cwd)) {
        const dir = await resolveRead(ctx.sandbox, str(args.cwd));
        if (!dir.ok) {
          await recordRefusal(ctx.journal, dir.reason);
          return refuse(dir.reason);
        }
        cwd = dir.abs;
      }
      const env = envSubset(process.env, ctx.cfg.bash.env);
      const started = Date.now();
      const res = verdict.shell
        ? await runCmd(command, [], cwd, ctx.cfg.bash.timeoutSec * 1000, { shell: true, env })
        : await runCmd(verdict.argv[0], verdict.argv.slice(1), cwd, ctx.cfg.bash.timeoutSec * 1000, { shell: false, env });
      const out = clip(res.out, ctx.cfg.bash.maxOutputKB * 1024);
      await recordCommand(ctx.journal, {
        command,
        cwd: toPosix(path.relative(ctx.sandbox.root, cwd)) || ".",
        code: res.code,
        ms: Date.now() - started,
        timedOut: res.timedOut,
        output: out,
      });
      ctx.log(`  run ${command} -> exit ${res.code}${res.timedOut ? " (timeout)" : ""}`);
      return { text: JSON.stringify({ command, code: res.code, timedOut: res.timedOut, output: out }) };
    }

    case "run_audit": {
      const which = str(args.which) || "test";
      const table: Record<string, string | undefined> = {
        typecheck: ctx.audit.typecheckCmd,
        lint: ctx.audit.lintCmd,
        test: ctx.audit.testCmd,
      };
      const command = table[which];
      if (!command) {
        return refuse(`no ${which} command is configured (local.audit.${which === "test" ? "testCmd" : which === "lint" ? "lintCmd" : "typecheckCmd"}); run the project's own command with run instead, if it is allowed`);
      }
      const env = envSubset(process.env, ctx.cfg.bash.env);
      const started = Date.now();
      const parts = command.split(/\s+/);
      const res = await runCmd(parts[0], parts.slice(1), ctx.sandbox.root, ctx.audit.timeoutSec * 1000, { env });
      const out = clip(res.out, ctx.cfg.bash.maxOutputKB * 1024);
      await recordCommand(ctx.journal, {
        command,
        cwd: ".",
        code: res.code,
        ms: Date.now() - started,
        timedOut: res.timedOut,
        output: out,
      });
      ctx.log(`  audit ${which}: exit ${res.code}${res.timedOut ? " (timeout)" : ""}`);
      return { text: JSON.stringify({ which, command, code: res.code, timedOut: res.timedOut, output: out }) };
    }

    case "finish": {
      const summary = str(args.summary);
      const notDone = Array.isArray(args.notDone) ? args.notDone.map((v) => str(v)).filter(Boolean) : [];
      return { text: JSON.stringify({ summary, notDone }), stop: true };
    }

    default:
      return refuse(`there is no tool called "${call.name}". Available: ${TOOL_SCHEMAS.map((t) => t.function.name).join(", ")}`);
  }
}
