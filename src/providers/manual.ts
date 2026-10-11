import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "../config.js";
import type { TextProvider } from "../types.js";

/**
 * The "manual" provider: your own assistant (this session) is the model.
 *
 * The first call for a prompt parks it at .design-mcp/manual/pending-<id>.json
 * and throws ManualPending. Read the file, compose the reply, store it with
 * the manual_answer tool, then re-run the original tool call: the stored
 * answer is picked up automatically and the pipeline continues. Works with any
 * MCP host, no keys, no sampling support needed. Usage is unmetered (0 tokens).
 */

export class ManualPending extends Error {
  constructor(public id: string, public file: string) {
    super(
      `Manual model input needed (provider "manual"). Prompt saved to ${file}. ` +
        `Read it, compose the reply, then run manual_answer with { "id": "${id}", "text": "..." } ` +
        `and re-run the original tool call to continue.`
    );
    this.name = "ManualPending";
  }
}

const dir = () => path.join(stateDir(), "manual");
const answersDir = () => path.join(dir(), "answers");
const hash = (o: unknown) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 12);

export interface PendingPrompt {
  id: string;
  file: string;
  role: string;
  createdAt: string;
  preview: string;
}

export async function listPending(): Promise<PendingPrompt[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir())).filter((f) => f.startsWith("pending-") && f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: PendingPrompt[] = [];
  for (const f of files) {
    const id = f.slice("pending-".length, -".json".length);
    try {
      await fs.access(path.join(answersDir(), `${id}.json`));
      continue; // already answered
    } catch {
      /* still pending */
    }
    try {
      const p = JSON.parse(await fs.readFile(path.join(dir(), f), "utf8"));
      const last = (p.messages ?? []).at(-1);
      const preview = typeof last?.content === "string" ? last.content.slice(0, 300) : "(no preview)";
      out.push({ id, file: path.join(dir(), f), role: String(p.role ?? "?"), createdAt: String(p.createdAt ?? "?"), preview });
    } catch {
      /* unreadable prompt file; skip */
    }
  }
  return out;
}

export function renderPending(list: PendingPrompt[]): string {
  if (!list.length) return "No unanswered manual prompts.";
  return [
    `${list.length} unanswered manual prompt(s):`,
    ...list.map((p) => [`- ${p.id} (${p.role}, ${p.createdAt})`, `  file: ${p.file}`, `  ends with: ${p.preview.slice(-160)}`].join("\n")),
    "",
    'Answer with manual_answer { "id": "<id>", "text": "..." }, then re-run the original tool call.',
  ].join("\n");
}

export async function storeAnswer(id: string, text: string): Promise<string> {
  const clean = id.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pending = path.join(dir(), `pending-${clean}.json`);
  try {
    await fs.access(pending);
  } catch {
    throw new Error(`No pending prompt "${id}". Run manual_pending to see what needs an answer.`);
  }
  await fs.mkdir(answersDir(), { recursive: true });
  await fs.writeFile(path.join(answersDir(), `${clean}.json`), JSON.stringify({ text, answeredAt: new Date().toISOString() }));
  return pending;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait for an answer before giving up (0 = throw immediately). */
const waitMs = () => {
  const n = Number(process.env.DESIGN_MCP_MANUAL_WAIT_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3_600_000) : 0;
};

export const manual: TextProvider = {
  id: "manual",
  async complete(_model, _apiKey, req) {
    const key = { system: req.system ?? "", messages: req.messages, maxTokens: req.maxTokens ?? 0, json: !!req.json };
    const id = hash(key);
    const readAnswer = async (): Promise<string | null> => {
      try {
        const saved = JSON.parse(await fs.readFile(path.join(answersDir(), `${id}.json`), "utf8"));
        if (typeof saved.text === "string" && saved.text.trim()) return saved.text;
      } catch {
        /* no stored answer yet */
      }
      return null;
    };
    const hit = await readAnswer();
    if (hit) return { text: hit, inputTokens: 0, outputTokens: 0 };
    const file = path.join(dir(), `pending-${id}.json`);
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ id, role: "text", createdAt: new Date().toISOString(), maxTokens: req.maxTokens ?? 8000, json: !!req.json, system: req.system ?? "", messages: req.messages }, null, 2)
    );
    // One-session mode: wait for the answer instead of failing the job, so a
    // driver holding the connection open can be answered from another tool.
    const deadline = Date.now() + waitMs();
    while (Date.now() < deadline) {
      await sleep(5000);
      const late = await readAnswer();
      if (late) return { text: late, inputTokens: 0, outputTokens: 0 };
    }
    throw new ManualPending(id, file);
  },
};
