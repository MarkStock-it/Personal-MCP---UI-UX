/**
 * The one door to Ollama.
 *
 * Everything the owner's resource rules asked for lives in this file so the rules cannot drift apart:
 *   - A HARD CAP on concurrent local requests (`maxConcurrent`, default 1) held by a counting semaphore.
 *     `cancelAll` aborts the requests on the wire, and every queued (not yet started) call is refused
 *     with the generation error "local mode was switched off" rather than silently converted into a
 *     later run — callers reacting to that reason fall back to the council, which is what switching the
 *     mode off is supposed to cause.
 *   - Every request carries its own timeout and an AbortController; the timer covers queue time as
 *     well as generation time, because from the owner's side a queued task is still their wall clock.
 *     Nothing retries here: retries after a *deterministic* refusal are the delegation's business, and
 *     a hung generation is not a deterministic refusal.
 *   - Requests are built from config per call (model, options, keep_alive) — nothing is hardcoded; the
 *     model named in `local.model` is swappable for an A/B test without touching this file.
 *   - Failures are reported once per session, not once per task: the first unreachable/HTTP-error
 *     message is shown (console.error + the run's own log), later ones only tick the counters the
 *     status shows.
 *
 * Honest boundary: parse errors, schema rejections and audit failures are NOT this file's concern. This
 * file is transport only — it can say the generation did not come back; it cannot say whether the code
 * it returned is good.
 */
import type { LocalConfig } from "../config.js";

export interface GenerateRequest {
  prompt: string;
  system?: string;
  /** How long to wait — queue time included — for the parsed reply before cancelling the request. */
  timeoutMs: number;
}

export interface GenerateResult {
  text: string;
  ms: number;
}

export interface HealthResult {
  ok: boolean;
  models: string[];
  /** Present when Ollama answered, but the configured model is not among what it has. */
  modelMissing?: boolean;
  detail?: string;
}

export interface ClientSettings {
  host: string;
  model: string;
  numCtx: number;
  temperature: number;
  numThread: number;
  keepAliveM: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxConcurrent: number;
}

export const settingsFor = (local: LocalConfig): ClientSettings => ({
  host: local.host.replace(/\/$/, ""),
  model: local.model,
  numCtx: local.numCtx,
  temperature: local.temperature,
  numThread: local.numThread,
  keepAliveM: local.keepAliveM,
  maxOutputTokens: local.maxOutputTokens,
  timeoutMs: local.timeoutSec * 1000,
  maxConcurrent: local.maxConcurrent,
});

/** Bumped on every mode switch: a queued call whose generation is stale refuses instead of running. */
let generation = 0;
/** The controllers of calls currently on the wire; aborting them is what "switch it off now" means. */
const inFlight = new Set<AbortController>();
/** Warn-once per session: the same failure is not reported once per task. */
const warned = new Set<string>();
/** A recurring failure announces itself again at most once an hour, not on every task. */
let lastRecurringNote = 0;

const report = (key: string, message: string, log?: (m: string) => void): void => {
  console.error(message);
  if (!warned.has(key)) {
    warned.add(key);
    log?.(message);
  } else if (Date.now() - lastRecurringNote > 3_600_000) {
    lastRecurringNote = Date.now();
    log?.(`${message} (recurring; local_mode shows the counters)`);
  }
};

export const resetWarned = (): void => {
  warned.clear();
  lastRecurringNote = 0;
};

export function cancelAll(): void {
  generation++;
  for (const c of inFlight) c.abort();
  inFlight.clear();
}

export async function health(settings: ClientSettings, timeoutMs = 8000): Promise<HealthResult> {
  try {
    const res = await fetch(`${settings.host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, models: [], detail: `Ollama answered ${res.status} ${res.statusText} — is the daemon healthy?` };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const models = (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    return {
      ok: true,
      models,
      modelMissing: !models.some((n) => n === settings.model || n.split(":")[0] === settings.model.split(":")[0]),
    };
  } catch (e) {
    return { ok: false, models: [], detail: `Ollama at ${settings.host} is unreachable (${e instanceof Error ? e.message : String(e)}).` };
  }
}

const counters = { refused: 0, timeouts: 0, errors: 0, calls: 0 };
/** The counters `local_mode` and the greeting report. No reset: they are lifetime-of-server numbers. */
export const localCounters = () => ({ ...counters });

/** The counting semaphore: at most `limit` generations run at once, the rest queue in call order. */
const waiters: (() => void)[] = [];
let active = 0;
const acquire = (limit: number): Promise<void> => {
  if (active < limit) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((ok) => waiters.push(() => { active++; ok(); }));
};
const release = (): void => {
  active--;
  waiters.shift()?.();
};

class GenerationExpired extends Error {
  constructor() {
    super("local mode was switched off");
    this.name = "GenerationExpired";
  }
}

export class RequestCancelled extends Error {
  constructor(public readonly because: "timeout" | "switched-off") {
    super(because === "timeout" ? "the local model did not answer within its timeout" : "the request was cancelled: local mode was switched off");
    this.name = "RequestCancelled";
  }
}

export const isSwitchedOff = (e: unknown): boolean =>
  e instanceof GenerationExpired || (e instanceof RequestCancelled && e.because === "switched-off");
export const isTimeout = (e: unknown): boolean => e instanceof RequestCancelled && e.because === "timeout";

export async function generate(settings: ClientSettings, req: GenerateRequest, log?: (m: string) => void): Promise<GenerateResult> {
  const myGen = generation;
  counters.calls++;
  const controller = new AbortController();
  // From call time, queue time included: the owner's wall clock is what the timeout protects.
  const timer = setTimeout(() => {
    counters.timeouts++;
    controller.abort();
  }, req.timeoutMs);

  const attempt = async (): Promise<GenerateResult> => {
    await acquire(settings.maxConcurrent);
    try {
      if (generation !== myGen) {
        counters.refused++;
        throw new GenerationExpired();
      }
      if (controller.signal.aborted) throw new RequestCancelled("switched-off");
      inFlight.add(controller);
      try {
        const res = await fetch(`${settings.host}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: settings.model,
            prompt: req.prompt,
            ...(req.system ? { system: req.system } : {}),
            stream: false,
            format: "json",
            keep_alive: `${settings.keepAliveM}m`,
            options: {
              temperature: settings.temperature,
              num_ctx: settings.numCtx,
              num_thread: settings.numThread,
              num_predict: settings.maxOutputTokens,
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          counters.errors++;
          report(`http-${res.status}`, `local model: POST ${settings.host}/api/generate → ${res.status} ${res.statusText}; falling back to the council`, log);
          throw new Error(`Ollama returned ${res.status} ${res.statusText}`);
        }
        const parsed = (await res.json()) as { response?: string };
        if (typeof parsed.response !== "string") {
          counters.errors++;
          throw new Error("Ollama's reply carried no response text");
        }
        return { text: parsed.response, ms: 0, ...{} };
      } finally {
        inFlight.delete(controller);
      }
    } finally {
      release();
    }
  };

  const t0 = Date.now();
  const result = attempt();
  try {
    return { text: (await result).text, ms: Date.now() - t0 };
  } catch (e) {
    // A cancelAll() abort (the owner switched the mode off) must not be recorded as a timeout: check the
    // generation first, so the reason the caller records is the one that actually happened.
    if (!(e instanceof GenerationExpired) && generation !== myGen) {
      counters.refused++;
      log?.("local model: an in-flight request was cancelled because local mode was switched off; the council takes these units over");
      throw new GenerationExpired();
    }
    if (e instanceof GenerationExpired) throw e;
    if (e instanceof RequestCancelled) {
      if (e.because === "switched-off") {
        counters.refused++;
        report("switched-off", "local model: a request was cancelled because local mode was switched off; the council takes these units over", log);
      }
      throw e;
    }
    if (controller.signal.aborted) throw new RequestCancelled("timeout");
    counters.errors++;
    report("unreachable", `local model: the request failed (${e instanceof Error ? e.message : String(e)}); falling back to the council`, log);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
