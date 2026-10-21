/**
 * The loop: Ollama `/api/chat` with tools, bounded four ways, and a transcript that does not quietly outgrow
 * the context window.
 *
 * Why `/api/chat` and not `/api/generate`: the generate endpoint has no `tools` parameter at all, which is why
 * `ollama/client.ts` cannot be extended into this and the agent keeps its own transport. `format: "json"` is
 * not sent here — structured output and tool calling fight over the same token stream.
 *
 * The three policies that matter:
 *   - **Caps are checked before the work, not after it.** `maxRounds`, `maxToolCalls` and `maxWallClockSec`
 *     each end the loop with the cap named, so the report says which one fired rather than "it stopped".
 *   - **No retries.** One model call, one chance. A loop that already re-reads the world does not need an
 *     inner retry; that is how a fifteen-minute run becomes an hour.
 *   - **Aging is deterministic.** Older tool results are clipped by position, never summarised by a model:
 *     a summary costs a call and makes two runs of the same task irreproducible.
 *
 * `runToolLoop` takes its model call as a parameter. That is not decoration: it is what lets `smoke/arithmetic.mjs`
 * drive a whole run against a scripted reply, with no server and no model, which is the only way this loop's
 * caps and refusals get asserted at all.
 */
import type { AgentConfig } from "../config.js";
import { estimateTokens } from "../codebase/store.js";
import { TOOL_SCHEMAS, executeTool, type ToolCall, type ToolContext, type ToolSchema } from "./tools.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
}

export type ChatFn = (messages: ChatMessage[], tools: ToolSchema[]) => Promise<ChatReply>;

export interface LoopOutcome {
  messages: ChatMessage[];
  rounds: number;
  toolCalls: number;
  /** `finish` | `final` | `max-rounds` | `max-tool-calls` | `wall-clock` | `model-error` | `stall` */
  stop: string;
  summary: string;
  modelMs: number;
}

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
};

/** The real transport. One request, one timeout, no retry — see the header. */
export function ollamaChat(cfg: AgentConfig): ChatFn {
  const host = cfg.host.replace(/\/$/, "");
  return async (messages, tools) => {
    const cloud = /[:-]cloud$/i.test(cfg.model);
    const res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_name ? { tool_name: m.tool_name } : {}),
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        })),
        tools,
        ...(cloud ? {} : { keep_alive: `${cfg.keepAliveM}m` }),
        options: {
          temperature: cfg.temperature,
          num_ctx: cfg.numCtx,
          num_predict: cfg.maxOutputTokens,
          ...(cloud ? {} : { num_thread: cfg.numThread }),
        },
      }),
      signal: AbortSignal.timeout(cfg.timeoutSec * 1000),
    });
    if (!res.ok) throw new Error(`Ollama answered ${res.status} ${res.statusText} for POST ${host}/api/chat`);
    const body = (await res.json()) as {
      message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
    };
    const calls = (body.message?.tool_calls ?? [])
      .map((c) => ({ name: typeof c.function?.name === "string" ? c.function.name : "", arguments: parseArgs(c.function?.arguments) }))
      .filter((c) => c.name);
    return { content: typeof body.message?.content === "string" ? body.message.content : "", toolCalls: calls };
  };
}

/**
 * Keep the system message, the task and the last few tool results verbatim; clip older ones.
 * Deterministic by position only: the same transcript always ages the same way.
 */
export function ageTranscript(messages: ChatMessage[], numCtx: number, keepRecent = 6): ChatMessage[] {
  const toolIndexes = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const stale = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)));
  const out = messages.map((m, i) =>
    stale.has(i) && m.content.length > 1_600
      ? {
          ...m,
          content: `${m.content.slice(0, 800)}\n… clipped ${m.content.length - 1_600} chars (aged out of context) …\n${m.content.slice(-800)}`,
        }
      : m
  );
  // If clipping alone was not enough (one huge read), drop the oldest tool results entirely.
  const total = out.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (total <= Math.floor(numCtx * 0.75)) return out;
  const trimmed = [...out];
  for (const i of toolIndexes) {
    if (trimmed.reduce((n, m) => n + estimateTokens(m.content), 0) <= Math.floor(numCtx * 0.7)) break;
    trimmed[i] = { ...trimmed[i], content: "… older tool result dropped to stay inside num_ctx …" };
  }
  return trimmed;
}

export interface LoopInput {
  ctx: ToolContext;
  chat: ChatFn;
  system: string;
  task: string;
  maxRounds: number;
  maxToolCalls: number;
  maxWallClockSec: number;
  numCtx: number;
  log: (m: string) => void;
}

export async function runToolLoop(input: LoopInput): Promise<LoopOutcome> {
  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.task },
  ];
  const deadline = Date.now() + input.maxWallClockSec * 1000;
  const seen = new Map<string, number>();
  let rounds = 0;
  let toolCalls = 0;
  let modelMs = 0;
  let stop = "max-rounds";
  let summary = "";

  outer: while (true) {
    if (Date.now() >= deadline) {
      stop = "wall-clock";
      summary = `the run hit agent.maxWallClockSec (${input.maxWallClockSec}s) after ${rounds} round(s)`;
      break;
    }
    if (rounds >= input.maxRounds) {
      stop = "max-rounds";
      summary = `the run hit agent.maxRounds (${input.maxRounds}) without finishing`;
      break;
    }

    let reply: ChatReply;
    const t0 = Date.now();
    try {
      reply = await input.chat(ageTranscript(messages, input.numCtx), TOOL_SCHEMAS);
    } catch (e) {
      modelMs += Date.now() - t0;
      stop = "model-error";
      summary = `the model call failed: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    modelMs += Date.now() - t0;
    rounds++;
    input.log(`  round ${rounds}: ${reply.toolCalls.length} tool call(s), ${reply.content.length} chars of text`);

    if (!reply.toolCalls.length) {
      messages.push({ role: "assistant", content: reply.content });
      stop = "final";
      summary = reply.content;
      break;
    }

    messages.push({
      role: "assistant",
      content: reply.content,
      tool_calls: reply.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
    });

    for (const call of reply.toolCalls) {
      if (toolCalls >= input.maxToolCalls) {
        stop = "max-tool-calls";
        summary = `the run hit agent.maxToolCalls (${input.maxToolCalls})`;
        break outer;
      }
      const key = `${call.name}:${JSON.stringify(call.arguments)}`;
      const times = (seen.get(key) ?? 0) + 1;
      seen.set(key, times);
      if (times >= 3) {
        stop = "stall";
        summary = `the model asked for ${call.name} with the same arguments ${times} times; the loop stopped rather than repeat it`;
        break outer;
      }

      let result;
      try {
        result = await executeTool(input.ctx, call);
      } catch (e) {
        result = { text: JSON.stringify({ refused: `the tool threw: ${e instanceof Error ? e.message : String(e)}` }) };
      }
      toolCalls++;
      messages.push({ role: "tool", tool_name: call.name, content: result.text });
      if (result.stop) {
        stop = "finish";
        try {
          const parsed = JSON.parse(result.text) as { summary?: string; notDone?: string[] };
          summary = parsed.summary ?? "";
          if (parsed.notDone?.length) summary += `\nNOT DONE: ${parsed.notDone.join("; ")}`;
        } catch {
          summary = "the model called finish without a readable summary";
        }
        break outer;
      }
    }
  }

  return { messages, rounds, toolCalls, stop, summary, modelMs };
}
