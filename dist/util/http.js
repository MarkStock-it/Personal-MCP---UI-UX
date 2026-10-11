export class ProviderError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "ProviderError";
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** POST JSON with retries on 429 / 5xx / network errors. Never puts keys in error text. */
export async function postJson(url, headers, body, opts = {}) {
    const retries = opts.retries ?? 3;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const host = new URL(url).host;
    for (let attempt = 0;; attempt++) {
        const backoff = 2 ** attempt * 1000 + Math.random() * 250;
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (e) {
            if (attempt < retries) {
                await sleep(backoff);
                continue;
            }
            throw new ProviderError(`Network error calling ${host}: ${e.message}`);
        }
        if (res.ok)
            return (await res.json());
        const text = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            await sleep(backoff);
            continue;
        }
        throw new ProviderError(`HTTP ${res.status} from ${host}: ${text.slice(0, 600)}`, res.status);
    }
}
