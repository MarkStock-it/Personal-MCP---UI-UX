import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, stateDir } from "./config.js";
const since = (iso) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 1000) : Infinity);
/** Seconds since this job last logged (or since it started, if it never logged). */
export function jobIdleSeconds(job) {
    const idle = since(job.lastActivityAt ?? job.startedAt);
    return Number.isFinite(idle) ? Math.round(idle) : 0;
}
/** A running job that has said nothing for `stallSec` is stalled, not busy. */
export function jobIsStalled(job, stallSec) {
    if (job.status !== "running")
        return false;
    const limit = stallSec ?? loadConfig().config.host.stallSeconds;
    return jobIdleSeconds(job) >= limit;
}
/** "4m 12s" - short enough to sit in a status line. */
export function humanAge(sec) {
    if (sec < 60)
        return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60)
        return `${m}m ${sec % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const jobs = new Map();
const dir = () => path.join(stateDir(), "jobs");
async function persist(job) {
    try {
        await fs.mkdir(dir(), { recursive: true });
        await fs.writeFile(path.join(dir(), `${job.id}.json`), JSON.stringify(job, null, 2));
    }
    catch {
        /* best effort */
    }
}
/** Start a long task in the background. The returned job can be polled. Never throws into the server. */
export function startJob(kind, fn) {
    const now = new Date().toISOString();
    const job = { id: `${kind[0]}-${Date.now().toString(36)}`, kind, status: "running", startedAt: now, lastActivityAt: now, log: [] };
    jobs.set(job.id, job);
    const log = (m) => {
        job.lastActivityAt = new Date().toISOString();
        job.log.push(`${job.lastActivityAt.slice(11, 19)} ${m}`);
        if (job.log.length > 300)
            job.log.splice(0, job.log.length - 300);
        void persist(job);
    };
    void persist(job);
    fn(log)
        .then((result) => {
        job.status = "done";
        job.result = result;
    })
        .catch((e) => {
        job.status = "failed";
        job.result = e instanceof Error ? e.message : String(e);
        log(`FAILED: ${job.result}`);
    })
        .finally(() => {
        job.finishedAt = new Date().toISOString();
        job.lastActivityAt = job.finishedAt;
        void persist(job);
    });
    return job;
}
export async function getJob(id) {
    if (id && jobs.has(id))
        return jobs.get(id);
    if (!id && jobs.size)
        return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    // Not in memory (server restarted): look on disk.
    try {
        const files = (await fs.readdir(dir())).filter((f) => f.endsWith(".json"));
        const pick = id ? `${id}.json` : files.sort().at(-1);
        if (!pick || !files.includes(pick))
            return null;
        const job = JSON.parse(await fs.readFile(path.join(dir(), pick), "utf8"));
        if (job.status === "running")
            job.status = "interrupted";
        return job;
    }
    catch {
        return null;
    }
}
