import type { Role } from "./types.js";

interface Entry {
  role: Role;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  images: number;
}

const ledger: Entry[] = [];

export function recordUsage(e: Entry) {
  ledger.push(e);
}

/** Tokens and image counts only. Prices change too often to hard-code. */
export function usageSummary(): string {
  if (!ledger.length) return "No API calls yet in this server session.";
  const groups = new Map<string, Entry & { calls: number }>();
  for (const e of ledger) {
    const key = `${e.role}|${e.provider}|${e.model}`;
    const g = groups.get(key) ?? { ...e, inputTokens: 0, outputTokens: 0, images: 0, calls: 0 };
    g.inputTokens += e.inputTokens;
    g.outputTokens += e.outputTokens;
    g.images += e.images;
    g.calls += 1;
    groups.set(key, g);
  }
  const lines = [...groups.values()].map(
    (g) =>
      `${g.role.padEnd(8)} ${g.provider}/${g.model}: ${g.calls} calls, ` +
      (g.role === "image" ? `${g.images} images` : `${g.inputTokens} in / ${g.outputTokens} out tokens`)
  );
  const totalIn = ledger.reduce((s, e) => s + e.inputTokens, 0);
  const totalOut = ledger.reduce((s, e) => s + e.outputTokens, 0);
  const totalImg = ledger.reduce((s, e) => s + e.images, 0);
  return [...lines, "", `TOTAL: ${totalIn} in / ${totalOut} out tokens, ${totalImg} images (this session)`].join("\n");
}
