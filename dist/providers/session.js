import { sampleCompletion } from "../sampling.js";
/** Text via the host you are already using (MCP sampling). Needs no API key. */
export const session = {
    id: "session",
    async complete(_model, _apiKey, req) {
        return sampleCompletion({
            system: [req.system, req.json ? "Return JSON only." : undefined].filter(Boolean).join("\n\n") || undefined,
            messages: req.messages,
            maxTokens: req.maxTokens ?? 8000,
            temperature: req.temperature,
        });
    },
};
