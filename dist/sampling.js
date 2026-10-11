/**
 * The "session" provider: completions come from the AI host you are already
 * talking to (Cursor, Freebuff, Claude Code, ...) via MCP sampling, not from
 * an external API. No keys, no separate billing.
 *
 * The host must support the sampling capability. If it does not, every call
 * fails with a plain-English error telling you to use the "manual" provider
 * instead (or a host that supports sampling).
 */
let srv = null;
export function setSamplingServer(s) {
    srv = s;
}
const err = (e) => (e instanceof Error ? e : new Error(String(e)));
export async function sampleCompletion(o) {
    if (!srv)
        throw new Error('Sampling is not wired up (internal error: setSamplingServer was never called).');
    let res;
    try {
        res = await srv.server.createMessage({
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
    }
    catch (e) {
        const m = err(e).message;
        if (/method not found|sampling|capabilit/i.test(m)) {
            throw new Error('The "session" provider asks your AI host to answer (MCP sampling), but this host refused or does not support it. ' +
                'Switch the role to the "manual" provider instead: prompts are saved as files, you answer them, the pipeline resumes. ' +
                `Host said: ${m.slice(0, 200)}`);
        }
        throw new Error(`Sampling call to your AI host failed: ${m.slice(0, 300)}`);
    }
    const c = res.content;
    const text = c?.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c);
    return { text, inputTokens: 0, outputTokens: 0 };
}
