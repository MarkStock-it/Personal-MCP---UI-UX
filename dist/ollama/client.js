/**
 * An Ollama cloud model — `beam:cloud` runs on ollama.com and the local daemon only proxies it.
 * Kept as one predicate so the transport, the status line and the flip message cannot disagree.
 */
export const isCloudModel = (model) => /[:-]cloud$/i.test(model);
export const settingsFor = (local) => ({
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
const inFlight = new Set();
/** Warn-once per session: the same failure is not reported once per task. */
const warned = new Set();
/** A recurring failure announces itself again at most once an hour, not on every task. */
let lastRecurringNote = 0;
const report = (key, message, log) => {
    console.error(message);
    if (!warned.has(key)) {
        warned.add(key);
        log?.(message);
    }
    else if (Date.now() - lastRecurringNote > 3_600_000) {
        lastRecurringNote = Date.now();
        log?.(`${message} (recurring; local_mode shows the counters)`);
    }
};
export const resetWarned = () => {
    warned.clear();
    lastRecurringNote = 0;
};
export function cancelAll() {
    generation++;
    for (const c of inFlight)
        c.abort();
    inFlight.clear();
}
export async function health(settings, timeoutMs = 8000) {
    try {
        const res = await fetch(`${settings.host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok)
            return { ok: false, models: [], detail: `Ollama answered ${res.status} ${res.statusText} — is the daemon healthy?` };
        const body = (await res.json());
        const entries = body.models ?? [];
        const models = entries.map((m) => m.name ?? "").filter(Boolean);
        const match = entries.find((m) => m.name === settings.model) ??
            entries.find((m) => m.name?.split(":")[0] === settings.model.split(":")[0]);
        return {
            ok: true,
            models,
            modelMissing: !match,
            ...(match?.remote_host ? { remote: match.remote_host } : {}),
            ...(match?.details?.parameter_size ? { parameterSize: match.details.parameter_size } : {}),
        };
    }
    catch (e) {
        return { ok: false, models: [], detail: `Ollama at ${settings.host} is unreachable (${e instanceof Error ? e.message : String(e)}).` };
    }
}
const counters = { refused: 0, timeouts: 0, errors: 0, calls: 0 };
/** The counters `local_mode` and the greeting report. No reset: they are lifetime-of-server numbers. */
export const localCounters = () => ({ ...counters });
/** The counting semaphore: at most `limit` generations run at once, the rest queue in call order. */
const waiters = [];
let active = 0;
const acquire = (limit) => {
    if (active < limit) {
        active++;
        return Promise.resolve();
    }
    return new Promise((ok) => waiters.push(() => { active++; ok(); }));
};
const release = () => {
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
    because;
    constructor(because) {
        super(because === "timeout" ? "the local model did not answer within its timeout" : "the request was cancelled: local mode was switched off");
        this.because = because;
        this.name = "RequestCancelled";
    }
}
export const isSwitchedOff = (e) => e instanceof GenerationExpired || (e instanceof RequestCancelled && e.because === "switched-off");
export const isTimeout = (e) => e instanceof RequestCancelled && e.because === "timeout";
export async function generate(settings, req, log) {
    const myGen = generation;
    counters.calls++;
    const controller = new AbortController();
    // From call time, queue time included: the owner's wall clock is what the timeout protects.
    const timer = setTimeout(() => {
        counters.timeouts++;
        controller.abort();
    }, req.timeoutMs);
    const attempt = async () => {
        await acquire(settings.maxConcurrent);
        try {
            if (generation !== myGen) {
                counters.refused++;
                throw new GenerationExpired();
            }
            if (controller.signal.aborted)
                throw new RequestCancelled("switched-off");
            inFlight.add(controller);
            try {
                // keep_alive and num_thread describe hardware this server owns. A cloud model runs on
                // ollama.com, so sending them would describe a machine we cannot see; they are left out.
                const cloud = isCloudModel(settings.model);
                const res = await fetch(`${settings.host}/api/generate`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        model: settings.model,
                        prompt: req.prompt,
                        ...(req.system ? { system: req.system } : {}),
                        stream: false,
                        format: "json",
                        ...(cloud ? {} : { keep_alive: `${settings.keepAliveM}m` }),
                        options: {
                            temperature: settings.temperature,
                            num_ctx: settings.numCtx,
                            ...(cloud ? {} : { num_thread: settings.numThread }),
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
                const parsed = (await res.json());
                if (typeof parsed.response !== "string") {
                    counters.errors++;
                    throw new Error("Ollama's reply carried no response text");
                }
                return { text: parsed.response, ms: 0, ...{} };
            }
            finally {
                inFlight.delete(controller);
            }
        }
        finally {
            release();
        }
    };
    const t0 = Date.now();
    const result = attempt();
    try {
        return { text: (await result).text, ms: Date.now() - t0 };
    }
    catch (e) {
        // A cancelAll() abort (the owner switched the mode off) must not be recorded as a timeout: check the
        // generation first, so the reason the caller records is the one that actually happened.
        if (!(e instanceof GenerationExpired) && generation !== myGen) {
            counters.refused++;
            log?.("local model: an in-flight request was cancelled because local mode was switched off; the council takes these units over");
            throw new GenerationExpired();
        }
        if (e instanceof GenerationExpired)
            throw e;
        if (e instanceof RequestCancelled) {
            if (e.because === "switched-off") {
                counters.refused++;
                report("switched-off", "local model: a request was cancelled because local mode was switched off; the council takes these units over", log);
            }
            throw e;
        }
        if (controller.signal.aborted)
            throw new RequestCancelled("timeout");
        counters.errors++;
        report("unreachable", `local model: the request failed (${e instanceof Error ? e.message : String(e)}); falling back to the council`, log);
        throw e;
    }
    finally {
        clearTimeout(timer);
    }
}
