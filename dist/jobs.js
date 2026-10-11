import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "./config.js";
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
    const job = { id: `${kind[0]}-${Date.now().toString(36)}`, kind, status: "running", startedAt: new Date().toISOString(), log: [] };
    jobs.set(job.id, job);
    const log = (m) => {
        job.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
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
