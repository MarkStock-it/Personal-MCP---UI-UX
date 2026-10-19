import { loadConfig } from "./config.js";
/**
 * The "session" provider: completions come from the AI host you are already
 * talking to (Cursor, Freebuff, Claude Code, ...) via MCP sampling, not from
 * an external API. No keys, no separate billing.
 *
 * Two failure modes are handled here, and both are the same bug from opposite ends: a sampling call
 * that never comes back. MCP gives the request no deadline, and the host is not obliged to answer, so
 * a host that lacks the capability (or declares it and then ignores the request) leaves this promise
 * pending forever. That is not a hypothetical: a whole mission sat on its leader call for hours, with
 * the process alive and nothing in any log saying why, because the only thing that ever failed was a
 * server restart.
 *
 *   - No declared capability -> refuse before sending. `getClientCapabilities()` is populated at
 *     initialize, so a host that never advertised sampling is known to be unable to answer, and
 *     waiting for it is not optimism, it is a hang with extra steps.
 *   - Declared capability, no answer -> fail at `host.samplingTimeoutSec` (default 300s) with the
 *     elapsed time and the three ways out. A slow host is a real thing; an infinite wait is not.
 */
let srv = null;
export function setSamplingServer(s) {
    srv = s;
}
const err = (e) => (e instanceof Error ? e : new Error(String(e)));
/** What to do when the host cannot answer. Named fixes, because "unsupported" alone is a dead end. */
const REFUSAL = [
    'The "session" provider expects your MCP host to answer the model call (MCP sampling), and this host does not offer it.',
    "Two ways forward, both in design-mcp.config.json:",
    '  1. Point the roles at a provider that answers on its own — "roles": { "leader": { "provider": "anthropic", "model": "<model id>" }, "worker": { "provider": "anthropic", "model": "<model id>" } } — and put that provider\'s key in the server env.',
    '  2. Or use "provider": "manual": each prompt is parked as a file under .design-mcp/manual/, the owner answers it with manual_answer, and the call resumes. No key, works on any host, one round trip per model call.',
    "The codebase, playbook and design tools call no model at all and are unaffected.",
].join("\n");
/** One promise, one deadline, and the timer is always cleaned up. */
async function withDeadline(work, ms, describe) {
    let timer;
    // The losing side of the race must not become an unhandled rejection later on.
    work.catch(() => { });
    try {
        return await Promise.race([
            work,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(describe())), ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export async function sampleCompletion(o) {
    if (!srv)
        throw new Error("Sampling is not wired up (internal error: setSamplingServer was never called).");
    const caps = srv.server.getClientCapabilities();
    if (caps && !caps.sampling)
        throw new Error(REFUSAL);
    const { config } = loadConfig();
    const timeoutSec = config.host.samplingTimeoutSec;
    const request = srv.server.createMessage({
        ...(o.system ? { systemPrompt: o.system } : {}),
        messages: o.messages.map((m) => ({
            role: m.role,
            content: [
                ...(m.images ?? []).map((i) => ({ type: "image", data: i.base64, mimeType: i.mediaType })),
                { type: "text", text: m.content },
            ],
        })),
        maxTokens: o.maxTokens,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        includeContext: "none",
    });
    // The deadline message is already a full explanation, so it must not be re-wrapped by the
    // protocol-error branch below (which matches on the word "sampling" and would swallow it).
    let timedOut = false;
    let res;
    try {
        res = await withDeadline(request, timeoutSec * 1000, () => {
            timedOut = true;
            return [
                `Your MCP host accepted the request and did not answer within ${timeoutSec}s, so the call was failed instead of left pending (an unanswered sampling request never times out on its own — that is how a mission hung in this server before).`,
                `If the host is merely slow, raise host.samplingTimeoutSec in design-mcp.config.json (currently ${timeoutSec}).`,
                'If it cannot answer at all, point the role at a key-based provider or at "manual" — see the notes on the "session" provider in README.md.',
            ].join("\n");
        });
    }
    catch (e) {
        if (timedOut)
            throw err(e);
        const m = err(e).message;
        if (/method not found|sampling|capabilit/i.test(m)) {
            throw new Error(`${REFUSAL}\nHost said: ${m.slice(0, 200)}`);
        }
        throw new Error(`Sampling call to your AI host failed: ${m.slice(0, 300)}`);
    }
    const c = res.content;
    const text = c?.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c);
    return { text, inputTokens: 0, outputTokens: 0 };
}
