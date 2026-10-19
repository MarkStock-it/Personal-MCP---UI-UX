/**
 * Local mode's runtime state: the toggle, the model override, and the counters the owner reads.
 *
 * The config file carries the default (`local.enabled`), but the owner flips the mode at runtime — the
 * machine is shared with everything else they do, so the flip must be immediate and must survive server
 * restarts. A small state file under .design-mcp/ serves both: written by `local_mode { set }`, read by
 * everyone. When a state file exists, IT is the truth (`on` and `model`); the config's `enabled` and
 * `model` are only the defaults the file was seeded from. No state file → the config governs, which is
 * exactly "off until you say otherwise".
 *
 * The counters live in the same file so the owner's visibility survives restarts too: delegated / audit
 * passed / audit rejected / fell back, written once per mission end, never mid-write.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../config.js";
const stateFile = (root) => path.join(stateDir(), "local-mode.json");
const emptyCounters = () => ({ delegated: 0, applied: 0, auditFailed: 0, fallback: 0 });
/** No file → the config is the whole truth. A malformed file is treated as "off" with a note, not as a crash. */
export function readLocalState(root) {
    const file = stateFile(root);
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch {
        return { state: null };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            state: {
                on: parsed.on === true,
                model: typeof parsed.model === "string" ? parsed.model : undefined,
                counters: { ...emptyCounters(), ...(parsed.counters ?? {}) },
                flippedAt: typeof parsed.flippedAt === "string" ? parsed.flippedAt : undefined,
                lastHealth: typeof parsed.lastHealth === "string" ? parsed.lastHealth : undefined,
                updated: typeof parsed.updated === "string" ? parsed.updated : undefined,
            },
        };
    }
    catch (e) {
        return { state: null, note: `.design-mcp/local-mode.json is not valid JSON (${e instanceof Error ? e.message : String(e)}), so the config decides and the counters start over.` };
    }
}
export function writeLocalMode(root, patch) {
    const prev = readLocalState(root).state;
    const state = {
        on: patch.on,
        model: patch.model ?? prev?.model,
        counters: prev?.counters ?? emptyCounters(),
        flippedAt: new Date().toISOString(),
        lastHealth: prev?.lastHealth,
        updated: new Date().toISOString(),
    };
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(stateFile(root), `${JSON.stringify(state, null, 2)}\n`);
    return state;
}
/** One bump per mission end, read-modify-write; a lost race loses one count, not the file. */
export function bumpCounters(root, delta) {
    const file = stateFile(root);
    try {
        const prev = readLocalState(root).state;
        if (!prev)
            return; // No state file means the mode was never flipped at runtime: nothing to report against.
        const counters = {
            delegated: prev.counters.delegated + (delta.delegated ?? 0),
            applied: prev.counters.applied + (delta.applied ?? 0),
            auditFailed: prev.counters.auditFailed + (delta.auditFailed ?? 0),
            fallback: prev.counters.fallback + (delta.fallback ?? 0),
        };
        fs.mkdirSync(stateDir(), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify({ ...prev, counters, updated: new Date().toISOString() }, null, 2)}\n`);
    }
    catch {
        // Counters are the least of the mission's integrity; a failed write costs a number, nothing else.
    }
}
export function recordHealth(root, note) {
    const file = stateFile(root);
    try {
        const prev = readLocalState(root).state;
        if (!prev)
            return;
        fs.writeFileSync(file, `${JSON.stringify({ ...prev, lastHealth: note, updated: new Date().toISOString() }, null, 2)}\n`);
    }
    catch {
        // as above
    }
}
/**
 * Effective mode: the runtime file wins when it exists, the config default decides otherwise. The model
 * override follows the same precedence. `on` being true here is only permission — health, dirty-tree and
 * path checks still gate every individual write.
 */
export function effectiveLocal(root, local) {
    const { state, note } = readLocalState(root);
    if (state) {
        return { on: state.on, model: state.model ?? local.model, source: "runtime", note };
    }
    return { on: local.enabled, model: local.model, source: "config", note };
}
export function renderLocalStatus(root, local) {
    const { state, note } = readLocalState(root);
    const eff = effectiveLocal(root, local);
    const lines = [];
    lines.push(`local mode: ${eff.on ? "ON" : "off"} (${eff.source === "runtime" ? "set with local_mode; overrides the config" : "config default; flip it with local_mode"})`);
    lines.push(`model: ${eff.model}`);
    lines.push(`host: ${local.host} · num_ctx ${local.numCtx} · temperature ${local.temperature} · num_thread ${local.numThread} · keep_alive ${local.keepAliveM}m · timeout ${local.timeoutSec}s · maxConcurrent ${local.maxConcurrent}`);
    const c = state?.counters;
    if (c && (c.delegated || c.applied || c.auditFailed || c.fallback)) {
        lines.push(`lifetime: ${c.delegated} delegated · ${c.applied} audit-passed · ${c.auditFailed} audit-rejected · ${c.fallback} fell back to the council`);
    }
    else {
        lines.push("lifetime: nothing delegated yet (counters only move when the mode is on and a mission runs)");
    }
    if (state?.lastHealth)
        lines.push(`last health check: ${state.lastHealth}`);
    if (note)
        lines.push(`note: ${note}`);
    if (state?.flippedAt)
        lines.push(`last flipped: ${state.flippedAt}`);
    return lines.join("\n");
}
