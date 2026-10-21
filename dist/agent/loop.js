import { estimateTokens } from "../codebase/store.js";
import { TOOL_SCHEMAS, executeTool } from "./tools.js";
const parseArgs = (raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw))
        return raw;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        }
        catch {
            return {};
        }
    }
    return {};
};
/** The real transport. One request, one timeout, no retry — see the header. */
export function ollamaChat(cfg) {
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
        if (!res.ok)
            throw new Error(`Ollama answered ${res.status} ${res.statusText} for POST ${host}/api/chat`);
        const body = (await res.json());
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
export function ageTranscript(messages, numCtx, keepRecent = 6) {
    const toolIndexes = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    const stale = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)));
    const out = messages.map((m, i) => stale.has(i) && m.content.length > 1_600
        ? {
            ...m,
            content: `${m.content.slice(0, 800)}\n… clipped ${m.content.length - 1_600} chars (aged out of context) …\n${m.content.slice(-800)}`,
        }
        : m);
    // If clipping alone was not enough (one huge read), drop the oldest tool results entirely.
    const total = out.reduce((n, m) => n + estimateTokens(m.content), 0);
    if (total <= Math.floor(numCtx * 0.75))
        return out;
    const trimmed = [...out];
    for (const i of toolIndexes) {
        if (trimmed.reduce((n, m) => n + estimateTokens(m.content), 0) <= Math.floor(numCtx * 0.7))
            break;
        trimmed[i] = { ...trimmed[i], content: "… older tool result dropped to stay inside num_ctx …" };
    }
    return trimmed;
}
export async function runToolLoop(input) {
    const messages = [
        { role: "system", content: input.system },
        { role: "user", content: input.task },
    ];
    const deadline = Date.now() + input.maxWallClockSec * 1000;
    const seen = new Map();
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
        let reply;
        const t0 = Date.now();
        try {
            reply = await input.chat(ageTranscript(messages, input.numCtx), TOOL_SCHEMAS);
        }
        catch (e) {
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
            }
            catch (e) {
                result = { text: JSON.stringify({ refused: `the tool threw: ${e instanceof Error ? e.message : String(e)}` }) };
            }
            toolCalls++;
            messages.push({ role: "tool", tool_name: call.name, content: result.text });
            if (result.stop) {
                stop = "finish";
                try {
                    const parsed = JSON.parse(result.text);
                    summary = parsed.summary ?? "";
                    if (parsed.notDone?.length)
                        summary += `\nNOT DONE: ${parsed.notDone.join("; ")}`;
                }
                catch {
                    summary = "the model called finish without a readable summary";
                }
                break outer;
            }
        }
    }
    return { messages, rounds, toolCalls, stop, summary, modelMs };
}
