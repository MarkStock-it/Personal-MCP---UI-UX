import type { ImageProvider, TextProvider } from "../types.js";
import { postJson, ProviderError } from "../util/http.js";
import { JSON_RULE } from "../util/json.js";

const base = "https://generativelanguage.googleapis.com/v1beta/models";

export const googleText: TextProvider = {
  id: "google",
  async complete(model, apiKey, req) {
    const system = [req.system, req.json ? JSON_RULE : undefined].filter(Boolean).join("\n\n");

    const data = await postJson(
      `${base}/${model}:generateContent`,
      { "x-goog-api-key": apiKey },
      {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [
            { text: m.content },
            ...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.base64 } })),
          ],
        })),
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 8000,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      }
    );

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join("");
    return {
      text,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },
};

const ASPECT = { square: "1:1", landscape: "16:9", portrait: "9:16" } as const;

export const googleImage: ImageProvider = {
  id: "google",
  async generate(model, apiKey, req) {
    const data = await postJson(
      `${base}/${model}:generateContent`,
      { "x-goog-api-key": apiKey },
      {
        contents: [
          { role: "user", parts: [{ text: `${req.prompt}\n\nAspect ratio: ${ASPECT[req.shape ?? "square"]}.` }] },
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }
    );
    const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
    const img = parts.map((p) => p.inlineData ?? p.inline_data).find((d) => d?.data);
    if (!img) throw new ProviderError("Google response contained no image (check the model supports image output).");
    return { mediaType: img.mimeType ?? img.mime_type ?? "image/png", base64: img.data };
  },
};
