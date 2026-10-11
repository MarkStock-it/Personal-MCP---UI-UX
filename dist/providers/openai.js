import { postJson, ProviderError } from "../util/http.js";
import { JSON_RULE } from "../util/json.js";
export const openaiText = {
    id: "openai",
    async complete(model, apiKey, req) {
        const system = [req.system, req.json ? JSON_RULE : undefined].filter(Boolean).join("\n\n");
        const messages = [];
        if (system)
            messages.push({ role: "system", content: system });
        for (const m of req.messages) {
            messages.push({
                role: m.role,
                content: m.images?.length
                    ? [
                        { type: "text", text: m.content },
                        ...m.images.map((i) => ({
                            type: "image_url",
                            image_url: { url: `data:${i.mediaType};base64,${i.base64}` },
                        })),
                    ]
                    : m.content,
            });
        }
        const data = await postJson("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${apiKey}` }, {
            model,
            messages,
            max_completion_tokens: req.maxTokens ?? 8000,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.json ? { response_format: { type: "json_object" } } : {}),
        });
        return {
            text: data.choices?.[0]?.message?.content ?? "",
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
        };
    },
};
const SIZES = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" };
export const openaiImage = {
    id: "openai",
    async generate(model, apiKey, req) {
        const data = await postJson("https://api.openai.com/v1/images/generations", { authorization: `Bearer ${apiKey}` }, { model, prompt: req.prompt, size: SIZES[req.shape ?? "square"], n: 1 });
        const b64 = data.data?.[0]?.b64_json;
        if (!b64)
            throw new ProviderError("OpenAI image response had no b64_json (check the model name).");
        return { mediaType: "image/png", base64: b64 };
    },
};
