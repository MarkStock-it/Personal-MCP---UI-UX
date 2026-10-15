/**
 * One model call that must come back as JSON matching a schema.
 *
 * Two attempts, not a loop: the collective is a fan-out, so a stuck worker is worse than a missing one.
 * When the reply is malformed or breaks the schema, the failure is fed back once — with the exact
 * problems, not "try again" — and if it fails twice the caller decides what to do (a worker is dropped
 * and reported; a leader aborts the mission). Nothing here retries silently, so nothing here hides a
 * broken model.
 */
import type { z } from "zod";
import { generateText, type TextRole } from "../providers/index.js";
import { JSON_RULE, extractJson } from "../util/json.js";

export interface AskResult<T> {
  value: T;
  raw: string;
  attempts: number;
  warnings: string[];
  ms: number;
  outputTokens: number;
}

export interface AskOptions<S extends z.ZodTypeAny> {
  role: TextRole;
  system: string;
  user: string;
  schema: S;
  attempts?: number;
  maxTokens?: number;
  temperature?: number;
  /** Soft problems the schema cannot express; they are fed back on the next attempt. */
  validate?: (value: z.infer<S>) => string[];
}

const ms = (t0: number) => Date.now() - t0;

export async function askJson<S extends z.ZodTypeAny>(o: AskOptions<S>): Promise<AskResult<z.infer<S>>> {
  const t0 = Date.now();
  const attempts = Math.max(1, o.attempts ?? 2);
  const base = `${o.user}\n\n${JSON_RULE}`;
  let user = base;
  let lastRaw = "";
  let lastErr = "no attempt was made";
  let tokens = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await generateText(o.role, {
      system: o.system,
      messages: [{ role: "user", content: user }],
      maxTokens: o.maxTokens ?? 2400,
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      json: true,
    });
    tokens += res.outputTokens;
    lastRaw = res.text;

    let parsed: { success: true; data: z.infer<S> } | { success: false; issues: string[] } | null = null;
    try {
      const raw = extractJson(lastRaw);
      const check = o.schema.safeParse(raw);
      parsed = check.success
        ? { success: true, data: check.data }
        : { success: false, issues: check.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
    } catch (e) {
      lastErr = `The reply contained no JSON at all (${e instanceof Error ? e.message : String(e)}).`;
    }

    if (parsed) {
      if (!parsed.success) {
        lastErr = `The JSON did not match the contract:\n${parsed.issues.map((i) => `- ${i}`).join("\n")}`;
      } else {
        const warnings = o.validate?.(parsed.data) ?? [];
        if (!warnings.length || attempt === attempts) {
          return { value: parsed.data, raw: lastRaw, attempts: attempt, warnings, ms: ms(t0), outputTokens: tokens };
        }
        lastErr = `These problems must be fixed:\n${warnings.map((w) => `- ${w}`).join("\n")}`;
      }
    }

    user = `${base}\n\nYour previous reply was REJECTED. Fix exactly this and reply again with the whole corrected JSON object:\n${lastErr}\n\nPrevious reply (for reference only):\n${lastRaw.slice(0, 2000)}`;
  }

  throw new Error(`The ${o.role} reply did not match the contract after ${attempts} attempts. Last problem: ${lastErr}\nLast reply began: ${lastRaw.slice(0, 300)}`);
}
