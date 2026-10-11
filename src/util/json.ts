export const JSON_RULE =
  "Respond with a single valid JSON value and nothing else. No markdown fences, no commentary.";

/** Pull JSON out of a model reply even if it wrapped it in fences or prose. */
export function extractJson<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.search(/[\[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start === -1 || end <= start) throw new Error("Model reply contained no JSON.");
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  }
}
