export type TextProviderId = "anthropic" | "openai" | "google" | "session" | "manual";
export type ImageProviderId = "openai" | "google";

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: ImageInput[]; // used by the critic (vision)
}

export interface TextRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean; // ask for a single JSON value back
}

export interface TextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TextProvider {
  id: TextProviderId;
  complete(model: string, apiKey: string, req: TextRequest): Promise<TextResult>;
}

export interface ImageRequest {
  prompt: string;
  shape?: "square" | "landscape" | "portrait";
}

export interface ImageResult {
  mediaType: string;
  base64: string;
}

export interface ImageProvider {
  id: ImageProviderId;
  generate(model: string, apiKey: string, req: ImageRequest): Promise<ImageResult>;
}

export type Role = "concept" | "builder" | "critic" | "image";
