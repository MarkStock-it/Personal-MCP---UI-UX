import { postJson } from "../util/http.js";
import { JSON_RULE } from "../util/json.js";
export const anthropic = {
    id: "anthropic",
    async complete(model, apiKey, req) {
        const system = [req.system, req.json ? JSON_RULE : undefined].filter(Boolean).join("\n\n");
        const data = await postJson("https://api.anthropic.com/v1/messages", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, {
            model,
            max_tokens: req.maxTokens ?? 8000,
            ...(system ? { system } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            messages: req.messages.map((m) => ({
                role: m.role,
                content: [
                    ...(m.images ?? []).map((i) => ({
                        type: "image",
                        source: { type: "base64", media_type: i.mediaType, data: i.base64 },
                    })),
                    { type: "text", text: m.content },
                ],
            })),
        });
        const text = (data.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("");
        return {
            text,
            inputTokens: data.usage?.input_tokens ?? 0,
            outputTokens: data.usage?.output_tokens ?? 0,
        };
    },
};
