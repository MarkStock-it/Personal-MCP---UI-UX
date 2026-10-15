import { apiKeyFor, loadConfig, providerNeedsKey } from "../config.js";
import type { ImageProvider, ImageRequest, ImageResult, TextProvider, TextRequest, TextResult } from "../types.js";
import { recordUsage } from "../usage.js";
import { anthropic } from "./anthropic.js";
import { googleImage, googleText } from "./google.js";
import { manual } from "./manual.js";
import { openaiImage, openaiText } from "./openai.js";
import { session } from "./session.js";

const TEXT: Record<string, TextProvider> = { anthropic, openai: openaiText, google: googleText, session, manual };
const IMAGE: Record<string, ImageProvider> = { openai: openaiImage, google: googleImage };

/** Call whichever text provider/model is configured for a role. Config is re-read each call, so edits apply without restart. */
export type TextRole = "concept" | "builder" | "critic" | "leader" | "worker";

export async function generateText(role: TextRole, req: TextRequest): Promise<TextResult> {
  const { provider, model } = loadConfig().config.roles[role];
  const fn = TEXT[provider];
  if (!fn) throw new Error(`Unknown text provider "${provider}".`);
  const result = await fn.complete(model, providerNeedsKey(provider) ? apiKeyFor(provider) : "", req);
  recordUsage({ role, provider, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, images: 0 });
  return result;
}

export async function generateImage(req: ImageRequest): Promise<ImageResult> {
  const { provider, model } = loadConfig().config.roles.image;
  const result = await IMAGE[provider].generate(model, apiKeyFor(provider), req);
  recordUsage({ role: "image", provider, model, inputTokens: 0, outputTokens: 0, images: 1 });
  return result;
}
