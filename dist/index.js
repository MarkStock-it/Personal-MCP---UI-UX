#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BRIEF_TEMPLATE, readBrief, resolveInProject, validateBrief } from "./brief.js";
import { archiveStore, hashBrief, loadStore, nextIds, proposeConcepts, renderConcepts, reviseConcept, saveStore } from "./concepts.js";
import { critiqueVariation } from "./critic.js";
import { apiKeyFor, keyEnvName, loadConfig, projectDir, providerNeedsKey, stateDir } from "./config.js";
import { adoptHostRoots, ensureProject, isTooBroad, repoRootOf, setSessionRoot } from "./project.js";
import { listPending, renderPending, storeAnswer } from "./providers/manual.js";
import { setSamplingServer } from "./sampling.js";
import { buildVariation } from "./builder/build.js";
import { decideStack, detectStack } from "./builder/scaffold.js";
import { prepareSequence } from "./builder/sequences.js";
import { getJob, humanAge, jobIdleSeconds, jobIsStalled, startJob } from "./jobs.js";
import { pLimit } from "./util/limit.js";
import { findVariations, loadReport, renderReport, testVariation } from "./test/run.js";
import { generateImage, generateText } from "./providers/index.js";
import { usageSummary } from "./usage.js";
import { findEntry, findTopic, renderEntry, renderTopic, resourceUri, searchPlaybook, TOPIC_IDS, TOPICS, topicIndex } from "./playbook/index.js";
import { renderPalette, paletteCheck, renderSlopFindings, scanSlop } from "./playbook/check.js";
import { RUBRIC_SECTIONS } from "./playbook/rubric.js";
import { packContext, renderPack } from "./codebase/pack.js";
import { estimateTokens, getIndex, renderConventions, renderDigest, renderGraph, renderMap, summarizeIndex } from "./codebase/store.js";
import { findReferences, renderReferences } from "./codebase/refs.js";
import { askJson } from "./collective/ask.js";
import { EDIT_STATUS_MEANING, renderEditCheck, verifyEdits } from "./collective/edits.js";
import { renderFocusContract } from "./collective/focus.js";
import { addRuling, clearMemory, loadMemory, renderMemoryReport } from "./collective/memory.js";
import { LeaderPlanSchema, leaderSystem, leaderUser } from "./collective/roles.js";
import { helloCollective } from "./collective/hello.js";
import { cancelAll, health, isCloudModel, localCounters, resetWarned, settingsFor } from "./ollama/client.js";
import { effectiveLocal, recordHealth, renderLocalStatus, writeLocalMode } from "./ollama/state.js";
import { readAgentCounters, startAgentRun } from "./agent/index.js";
import { installSessionBlock, removeSessionBlock, renderInstallReport } from "./collective/install.js";
import { discoverSkills, findSkill, readSkill, renderSkillIndex } from "./skills/index.js";
import { listDossiers, loadDossier, runMission } from "./collective/run.js";
import { STATUS_MEANING, SUPPORT_MEANING, renderVerification, verifyCallerClaims } from "./collective/verify.js";
// NOTE: stdio servers must never write to stdout (it carries the protocol). Log with console.error only.
const server = new McpServer({ name: "design-mcp", version: "0.9.0" });
setSamplingServer(server);
// One request, once the host has initialized: which folder does it have open? A server installed once and
// used from many repos has no other way to know, and guessing from the working directory is how a desktop
// host's home folder became "the project". Best-effort by design — a host without roots falls through.
server.server.oninitialized = () => {
    void adoptHostRoots(server.server);
};
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (e) => ({
    isError: true,
    content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
});
server.registerTool("providers_config", {
    title: "Show provider configuration",
    description: "Shows which LLM / image provider and model is assigned to each role (concept, builder, critic, image), which API keys are present, and where the config was loaded from. Does not call any API.",
    inputSchema: {},
}, async () => {
    try {
        const { config, source } = loadConfig();
        const info = await ensureProject();
        const caps = server.server.getClientCapabilities();
        const keys = ["anthropic", "openai", "google"].map((p) => `${keyEnvName(p)}: ${process.env[keyEnvName(p)] ? "set" : "MISSING"}`);
        const roles = Object.entries(config.roles).map(([r, v]) => `${r.padEnd(8)} -> ${v.provider} / ${v.model}${providerNeedsKey(v.provider) ? "" : " (no key needed)"}`);
        const sessionRoles = Object.entries(config.roles).filter(([, v]) => v.provider === "session").map(([r]) => r);
        return ok([
            `Project dir: ${info.root}`,
            `Root from: ${info.source}`,
            ...(info.tooBroad ? ["", info.warning ?? ""] : []),
            `Config: ${source}`,
            "",
            "Host:",
            caps
                ? caps.sampling
                    ? `  sampling: supported — ${sessionRoles.length ? `${sessionRoles.join(", ")} can answer through this host` : "no role is using it"}`
                    : `  sampling: NOT supported — ${sessionRoles.length ? `${sessionRoles.join(", ")} cannot answer here; point them at a key-based provider or at "manual", or every call will fail` : "no role is using it"}`
                : "  sampling: unknown (the session has not finished initializing yet — call this again)",
            caps?.roots ? "  roots: advertised (the server uses the folder this host reports as the project)" : "  roots: not advertised (the project comes from DESIGN_MCP_PROJECT_DIR, or the working directory)",
            "",
            "Roles:",
            ...roles,
            "",
            "Keys:",
            ...keys,
            "",
            `Limits: ${config.limits.variations} variations, up to ${config.limits.maxFixRounds} fix rounds`,
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
/* ---- which repo is this session on? ---- */
/**
 * Point the session at a repository the owner named. Shared by `project_root` and `code_index { path }`:
 * the second exists because some hosts only let an assistant call tools that were approved when the
 * server was installed, so "index that repo instead" has to be reachable through a tool that is already
 * on the list. Same rules either way: the folder must exist, and a home folder or drive root is refused.
 */
async function adoptProjectPath(wanted) {
    const abs = path.resolve(wanted);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isDirectory())
        return `There is no folder at ${abs}. Pass an absolute path to the repository.`;
    if (isTooBroad(abs)) {
        return `${abs} is a home folder or a drive root, not a repository — point at a project folder instead. That is the exact mistake this exists to stop.`;
    }
    setSessionRoot(abs);
    return null;
}
server.registerTool("project_root", {
    title: "Which repository this session is working on",
    description: "Reports the repository every project-scoped tool reads, and where that answer came from (a path you named, DESIGN_MCP_PROJECT_DIR, the folder the host reported as its workspace, or the working directory). Pass `path` to point this session at a different repository: one install of this server is meant to serve any repo, and a stdio server cannot see which folder you have open unless it is told. The choice is session-scoped — it outranks DESIGN_MCP_PROJECT_DIR, is never written to a config file, and is forgotten when the server restarts. A home folder or a drive root is refused: that is a location, not a repository, and indexing one is how a whole home directory once became \"the project\".",
    inputSchema: {
        path: z.string().optional().describe("Absolute path to the repository to use for the rest of this session; omit it to see what is being used now"),
    },
}, async ({ path: wanted }) => {
    try {
        let changed = "";
        if (wanted !== undefined) {
            const problem = await adoptProjectPath(wanted);
            if (problem)
                return fail(problem);
            changed = `Now using ${path.resolve(wanted)} for the rest of this session. Nothing was written to disk, and this outranks DESIGN_MCP_PROJECT_DIR until the server restarts.`;
        }
        const info = await ensureProject();
        const repo = repoRootOf(info.root);
        const idx = await fs.stat(path.join(info.root, ".design-mcp", "codebase", "index.json")).catch(() => null);
        return ok([
            `Project: ${info.root}`,
            `From: ${info.source}`,
            `Repository: ${repo ? repo : "no .git / package.json / go.mod here — a folder, not a repository"}`,
            `Index: ${idx ? `cached, ${Math.round(idx.size / 1024)} KB, written ${new Date(idx.mtimeMs).toISOString()} — read it with code_digest` : "not built yet — run code_index"}`,
            `State dir: ${path.join(info.root, ".design-mcp")}`,
            ...(info.tooBroad ? ["", info.warning ?? ""] : []),
            changed ? `\n${changed}` : "",
        ]
            .filter(Boolean)
            .join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("providers_test", {
    title: "Test a provider role",
    description: "Makes one tiny real API call for a role to confirm its key and model work. Text roles send a one-word prompt. The image role generates one small test image and saves it under .design-mcp/ in the project.",
    inputSchema: { role: z.enum(["concept", "builder", "critic", "leader", "worker", "image"]) },
}, async ({ role }) => {
    try {
        if (role === "image") {
            const img = await generateImage({ prompt: "A flat orange circle on a plain cream background. Minimal.", shape: "square" });
            const ext = img.mediaType.split("/")[1] ?? "png";
            await fs.mkdir(stateDir(), { recursive: true });
            const file = path.join(stateDir(), `test-image.${ext}`);
            await fs.writeFile(file, Buffer.from(img.base64, "base64"));
            return ok(`Image role works. Saved test image to ${file}`);
        }
        const r = await generateText(role, {
            messages: [{ role: "user", content: "Reply with the single word: ready" }],
            maxTokens: 20,
        });
        return ok(`${role} role works. Reply: "${r.text.trim()}" (${r.inputTokens} in / ${r.outputTokens} out tokens)`);
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("usage_report", {
    title: "Token and image usage",
    description: "Reports tokens and images used by this server since it started, grouped by role and model.",
    inputSchema: {},
}, async () => ok(usageSummary()));
server.registerTool("brief_init", {
    title: "Create a brief template",
    description: "Creates brief.md (or a given path) in the project from a template. Never overwrites an existing file.",
    inputSchema: { path: z.string().optional().describe("Defaults to brief.md") },
}, async ({ path: p }) => {
    try {
        const file = resolveInProject(p ?? "brief.md");
        try {
            await fs.access(file);
            return ok(`${file} already exists, left untouched. Run brief_check to validate it.`);
        }
        catch {
            await fs.writeFile(file, BRIEF_TEMPLATE);
            return ok(`Created ${file}. Fill in Audience, Tone and voice, Content and Goals (required), then run brief_check.`);
        }
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("brief_check", {
    title: "Validate the brief",
    description: "Reads the Markdown brief and reports missing or thin required sections. Does not call any API.",
    inputSchema: { path: z.string().optional().describe("Defaults to brief.md") },
}, async ({ path: p }) => {
    try {
        const { brief, file } = await readBrief(p);
        const { missing, thin } = validateBrief(brief);
        if (!missing.length && !thin.length)
            return ok(`Brief at ${file} is complete. Next: concepts_generate.`);
        return ok([
            `Brief at ${file}:`,
            missing.length ? `MISSING (required): ${missing.join(", ")}` : "",
            thin.length ? `TOO THIN (under 25 characters, the concepts will be generic): ${thin.join(", ")}` : "",
            "Fill these in, then run brief_check again.",
        ].filter(Boolean).join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("concepts_generate", {
    title: "Generate concept directions",
    description: "Reads the brief and creates distinct design concepts (default: the configured number of variations). Saves them to .design-mcp/concepts.json as pending approval and returns them for the user to review. Calls the concept model.",
    inputSchema: {
        brief_path: z.string().optional().describe("Defaults to brief.md"),
        count: z.number().int().min(1).max(5).optional(),
    },
}, async ({ brief_path, count }) => {
    try {
        const { brief, file } = await readBrief(brief_path);
        const { missing } = validateBrief(brief);
        if (missing.length)
            return fail(`Brief is missing required sections: ${missing.join(", ")}. Run brief_check.`);
        const n = count ?? loadConfig().config.limits.variations;
        const { value, warnings } = await proposeConcepts(brief, n);
        const ids = nextIds([], n);
        const concepts = value.map((c, i) => ({ ...c, id: ids[i], status: "proposed" }));
        await archiveStore();
        await saveStore({ briefPath: file, briefHash: hashBrief(brief.raw), createdAt: new Date().toISOString(), status: "pending-approval", concepts });
        return ok([
            renderConcepts(concepts),
            warnings.length ? `\nHeads-up, the model could not fully fix these:\n- ${warnings.join("\n- ")}` : "",
            "\nNEXT: show the user these concepts. They can drop any, request tweaks, or approve. Use concepts_review.",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("concepts_review", {
    title: "Review, tweak, drop or approve concepts",
    description: "Applies the user's decisions to the saved concepts. Call with no arguments to just show them. drop removes concepts by id; tweak revises a concept with an instruction; replace_dropped generates fresh replacements that differ from the survivors; approve locks the remaining concepts so building can start.",
    inputSchema: {
        drop: z.array(z.string()).optional(),
        tweak: z.array(z.object({ id: z.string(), instruction: z.string().min(3) })).optional(),
        replace_dropped: z.boolean().optional(),
        approve: z.boolean().optional(),
    },
}, async ({ drop, tweak, replace_dropped, approve }) => {
    try {
        const store = await loadStore();
        const { brief } = await readBrief(store.briefPath);
        const notes = [];
        let concepts = store.concepts;
        const dropIds = (drop ?? []).map((d) => d.toLowerCase());
        const unknown = [...dropIds, ...(tweak ?? []).map((t) => t.id.toLowerCase())].filter((id) => !concepts.some((c) => c.id === id));
        if (unknown.length)
            return fail(`Unknown concept id(s): ${unknown.join(", ")}. Existing: ${concepts.map((c) => c.id).join(", ")}`);
        if (dropIds.length) {
            concepts = concepts.filter((c) => !dropIds.includes(c.id));
            notes.push(`Dropped: ${dropIds.join(", ")}.`);
        }
        for (const t of tweak ?? []) {
            const id = t.id.toLowerCase();
            const current = concepts.find((c) => c.id === id);
            if (!current) {
                notes.push(`Skipped tweak for ${id} (it was dropped).`);
                continue;
            }
            const { value, warnings } = await reviseConcept(brief, current, t.instruction, concepts.filter((c) => c.id !== id));
            concepts = concepts.map((c) => (c.id === id ? { ...value, id, status: "proposed" } : c));
            notes.push(`Revised ${id}.${warnings.length ? " Unresolved: " + warnings.join("; ") : ""}`);
        }
        if (replace_dropped && dropIds.length) {
            const { value } = await proposeConcepts(brief, dropIds.length, concepts);
            const ids = nextIds(store.concepts.map((c) => c.id), value.length);
            concepts = [...concepts, ...value.map((c, i) => ({ ...c, id: ids[i], status: "proposed" }))];
            notes.push(`Added replacement(s): ${ids.join(", ")}.`);
        }
        if (!concepts.length)
            return fail("No concepts left. Run concepts_generate again.");
        let status = store.status;
        if (approve) {
            concepts = concepts.map((c) => ({ ...c, status: "approved" }));
            status = "approved";
            notes.push(`Approved ${concepts.length} concept(s): ${concepts.map((c) => c.id).join(", ")}.`);
        }
        else if (drop?.length || tweak?.length) {
            status = "pending-approval";
            concepts = concepts.map((c) => ({ ...c, status: "proposed" }));
        }
        await saveStore({ ...store, concepts, status });
        return ok([
            notes.join("\n"),
            "",
            renderConcepts(concepts),
            "",
            status === "approved"
                ? "STATUS: approved. Next: design_build."
                : "STATUS: pending approval. Ask the user if they want more changes or to approve.",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("design_build", {
    title: "Build the approved concepts",
    description: "Builds every approved concept (or the given ids) into its own standalone project under variations/<id>-<name>/: plans, generates images and code, runs npm install and the build, and repairs build errors. Runs in the background and returns a job id immediately. Poll with design_status. Requires concepts_review approve. Calls the builder and image models, so it uses tokens and image credits.",
    inputSchema: {
        ids: z.array(z.string()).optional().describe("Only build these concept ids"),
        overwrite: z.boolean().optional().describe("Replace variation folders that already exist"),
    },
}, async ({ ids, overwrite }) => {
    try {
        const store = await loadStore();
        if (store.status !== "approved")
            return fail("Concepts are not approved yet. Use concepts_review with approve=true first.");
        const { brief } = await readBrief(store.briefPath);
        const want = (ids ?? []).map((i) => i.toLowerCase());
        const selected = store.concepts.filter((c) => !want.length || want.includes(c.id));
        if (!selected.length)
            return fail(`No matching concepts. Existing: ${store.concepts.map((c) => c.id).join(", ")}`);
        const { config } = loadConfig();
        if (providerNeedsKey(config.roles.builder.provider))
            apiKeyFor(config.roles.builder.provider);
        const decision = decideStack(await detectStack());
        const briefChanged = hashBrief(brief.raw) !== store.briefHash;
        const job = startJob("build", async (log) => {
            const ctx = { cfg: config.build, llm: pLimit(config.build.concurrency), installs: pLimit(2), log };
            log(`stack: ${decision.reason}`);
            if (briefChanged)
                log("note: brief.md changed since the concepts were generated; building from the current brief.");
            const results = await Promise.all(selected.map((concept) => buildVariation({ concept, brief, index: store.concepts.findIndex((c) => c.id === concept.id), overwrite: !!overwrite, ctx })));
            return [
                `Stack: ${decision.reason}`,
                "",
                ...results.map((r) => [
                    `${r.id.toUpperCase()} "${r.name}": ${r.status.toUpperCase()}`,
                    r.status !== "failed" ? `  run it:  cd ${r.dir} && npm run dev   ->  http://localhost:${r.port}` : `  error: ${r.error}`,
                    ...r.notes.map((n) => `  note: ${n}`),
                ].join("\n")),
                "",
                "Next: design_test checks mobile, accessibility and performance and takes screenshots.",
            ].join("\n");
        });
        return ok(`Build started (job ${job.id}) for: ${selected.map((c) => `${c.id} ${c.name}`).join(", ")}.\nStack decision: ${decision.reason}\nThis takes several minutes. Check progress with design_status.`);
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("design_status", {
    title: "Check a background job",
    description: "Shows the status, recent log lines and (when finished) the result of a background job such as design_build. Defaults to the most recent job.",
    inputSchema: { job_id: z.string().optional() },
}, async ({ job_id }) => {
    try {
        const job = await getJob(job_id);
        if (!job)
            return ok("No jobs found.");
        const stallSec = loadConfig().config.host.stallSeconds;
        const idle = jobIdleSeconds(job);
        const stalled = jobIsStalled(job, stallSec);
        return ok([
            `Job ${job.id} (${job.kind}): ${job.status.toUpperCase()}`,
            `Started ${job.startedAt}${job.finishedAt ? `, finished ${job.finishedAt}` : ""}`,
            job.status === "running" ? `Last log line ${humanAge(idle)} ago.` : "",
            "",
            stalled
                ? [
                    `STALLED: nothing has been logged for ${humanAge(idle)} (host.stallSeconds is ${stallSec}), so this job is not working — it is waiting.`,
                    "The usual cause is a model call this host cannot answer (see providers_config: sampling supported?). The call has no deadline of its own, so the job will not fail by itself — restart the server to clear it, and fix the provider before re-running.",
                    "",
                ].join("\n")
                : "",
            "Recent log:",
            ...job.log.slice(-25),
            job.result ? `\nRESULT:\n${job.result}` : "",
            job.status === "running" && !stalled ? "\nStill running. Check again in a minute or two." : "",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("design_test", {
    title: "Test built variations",
    description: "Opens each built variation in a real browser (Playwright) and runs the hard gates: mobile (no sideways scroll, tap targets, text size), accessibility (axe audit, keyboard focus, reduced motion, text stays visible, page basics), runtime errors, and performance (weight, load metrics, scroll smoothness). Also saves screenshots to .design-mcp/shots/<id>/ for later critique. Mobile and accessibility failures block a variation; performance only warns (configurable). Runs in the background; poll with design_status.",
    inputSchema: { ids: z.array(z.string()).optional().describe("Only test these variation ids") },
}, async ({ ids }) => {
    try {
        const want = (ids ?? []).map((i) => i.toLowerCase());
        const found = (await findVariations()).filter((v) => v.status !== "failed" && (!want.length || want.includes(v.id)));
        if (!found.length)
            return fail("No built variations found to test. Run design_build first.");
        const job = startJob("test", async (log) => {
            const reports = [];
            for (const v of found) {
                try {
                    reports.push(await testVariation({ root: v.root, id: v.id, name: v.name, log }));
                }
                catch (e) {
                    log(`[${v.id}] could not be tested: ${e instanceof Error ? e.message : e}`);
                    throw e;
                }
            }
            return reports.map(renderReport).join("\n\n----------\n\n");
        });
        return ok(`Testing started (job ${job.id}) for: ${found.map((v) => `${v.id} ${v.name}`).join(", ")}. Variations are tested one at a time so the performance numbers are fair. Check design_status.`);
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("design_report", {
    title: "Show the latest test report",
    description: "Shows the most recent saved test report for a variation id (blocking failures, warnings, what passed, screenshot folder).",
    inputSchema: { id: z.string() },
}, async ({ id }) => {
    try {
        return ok(await loadReport(id.toLowerCase()));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("design_critique", {
    title: "Critique a tested variation",
    description: "Sends a variation's approved concept, its automated test report and up to 3 screenshots to the critic model for an art-director review (concept drift first, then what the gates missed). Needs design_test to have run. Saves the critique under .design-mcp/critiques/. Calls the critic model, so it uses tokens.",
    inputSchema: { id: z.string().describe("Variation id, e.g. a") },
}, async ({ id }) => {
    try {
        const { text } = await critiqueVariation(id);
        return ok(text);
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("manual_pending", {
    title: "List unanswered manual prompts",
    description: "Lists prompts parked by the manual provider that still need an answer. Only relevant when a text role uses provider manual.",
    inputSchema: {},
}, async () => ok(renderPending(await listPending())));
server.registerTool("manual_answer", {
    title: "Answer a manual prompt",
    description: "Stores your reply for a parked manual prompt. Re-run the original tool call afterwards to continue the pipeline.",
    inputSchema: { id: z.string().describe("Pending prompt id from manual_pending"), text: z.string().min(1) },
}, async ({ id, text }) => {
    try {
        await storeAnswer(id, text);
        return ok(`Answer stored for ${id}. Re-run the original tool call to continue.`);
    }
    catch (e) {
        return fail(e);
    }
});
/* ============================ DESIGN PLAYBOOK ============================
   The offline half of this server. The tools above generate and test websites; these serve the
   knowledge for choosing motion, colour, type, layout and material, plus the deterministic
   checks that keep those choices honest. No API keys, no network, so a future session can always
   reach for them.
   ======================================================================== */
server.registerTool("playbook_topics", {
    title: "List the design playbook",
    description: "Lists every design-playbook topic and entry with a one-line intent, so you can see what design knowledge is available offline. Start here before asking for a rubric, a motion pattern, a palette recipe or the anti-slop checklist. No API call.",
    inputSchema: {},
}, async () => ok(topicIndex()));
server.registerTool("design_playbook", {
    title: "Read or search the design playbook",
    description: "Returns curated, offline design knowledge. Pass `topic` to read a whole topic, `query` to search across every topic (all terms must match), or `entry` to fetch one entry by id. Topics cover motion, organic/generative visuals, typography, colour, layout, the accessibility and performance floor, the critique rubric, and the anti-slop checklist. Every entry carries its sources and licences. No API call.",
    inputSchema: {
        topic: z.enum(TOPIC_IDS).optional().describe("Read this whole topic"),
        query: z.string().optional().describe("Search text; every whitespace-separated term must match"),
        entry: z.string().optional().describe("Fetch one entry by its id"),
    },
}, async ({ topic, query, entry }) => {
    try {
        if (entry) {
            const hit = findEntry(entry);
            if (!hit)
                return fail(`No playbook entry with id "${entry}". Run playbook_topics to see the ids.`);
            return ok(`# ${hit.topic.title} (${hit.topic.id})\n\n${renderEntry(hit.entry)}`);
        }
        if (topic)
            return ok(renderTopic(findTopic(topic), query));
        if (query?.trim()) {
            const hits = searchPlaybook(query);
            if (!hits.length)
                return ok(`Nothing in the playbook matched "${query}". Closest topics: ${TOPICS.map((t) => t.id).join(", ")}. Try fewer or broader words.`);
            return ok([
                `Playbook search "${query}" — ${hits.length} match(es).`,
                "",
                ...hits.slice(0, 6).map((h) => `## ${h.topic.id} / ${h.entry.name}\n\n${renderEntry(h.entry)}`),
                hits.length > 6 ? `\n(${hits.length - 6} more match(es). Narrow the query or name a topic.)` : "",
            ].filter(Boolean).join("\n"));
        }
        return ok(topicIndex());
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("motion_pattern", {
    title: "Find a motion pattern for a need",
    description: "Describe what the interface should do (\"a group of cards should arrive together\", \"a background that is alive but cheap\") and this returns the closest motion patterns with their tunable numbers, code pattern and pitfalls, plus the reduced-motion contract that every one of them answers to. No API call.",
    inputSchema: { need: z.string().min(3).describe("What the motion should accomplish, in plain words") },
}, async ({ need }) => {
    try {
        const hits = searchPlaybook(need, "motion");
        const contract = findEntry("reduced-motion-contract");
        if (!hits.some((h) => h.entry.id === "reduced-motion-contract"))
            hits.push(contract);
        return ok([
            `Motion patterns for: ${need}`,
            hits.length > 1
                ? `${hits.length - 1} matching pattern(s), then the contract they all obey.`
                : `No direct match, so here is the contract plus what the motion topic covers.`,
            "",
            ...hits.slice(0, 4).map((h) => renderEntry(h.entry)),
            hits.length <= 1 ? `\nAvailable motion entry ids: ${contract.topic.entries.map((e) => e.id).join(", ")}` : "",
        ].filter(Boolean).join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("palette_check", {
    title: "Check a palette offline",
    description: "Deterministic palette review with no model involved: classifies each colour as surface, ink or accent, gives a softness verdict (high-chroma mid-lightness colours read as neon), computes every ink-on-surface WCAG contrast ratio with its pass/fail, flags a hue spread that means two palettes, and suggests concrete fixes. Use it when keeping a palette soft while still meeting the 4.5:1 body-text floor.",
    inputSchema: {
        colours: z.array(z.string()).min(2).max(8).describe("Hex colours, e.g. [\"#F7F5FB\",\"#2B2742\",\"#5B58C9\"]"),
    },
}, async ({ colours }) => {
    try {
        return ok(renderPalette(paletteCheck(colours)));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("critique_rubric", {
    title: "The design critique rubric",
    description: "Returns the weighted critique rubric used to review a design: eleven scored sections (first impression, concept fit, space and rhythm, depth and layering, typography range, colour and material, motion and interaction, states and edge cases, the accessibility floor, the performance floor, content honesty), each with what to look for, what to flag, how to verify with evidence, and five score anchors. Pass `focus` for one section, or `how` for how to run the review itself. No API call.",
    inputSchema: {
        focus: z.string().optional().describe("A section id, e.g. depth-and-layering"),
        how: z.boolean().optional().describe("Include how-to-score and report-shape guidance"),
    },
}, async ({ focus, how }) => {
    try {
        const render = (s) => [
            `## ${s.title} (weight ${s.weight})`,
            `Look for: ${s.lookFor.join(" ")}`,
            `Flag: ${s.flag.join(" ")}`,
            `Verify: ${s.verify}`,
            `Scores: ${s.anchors.map((a, i) => `${i}=${a}`).join(" | ")}`,
        ].join("\n");
        const sections = focus
            ? RUBRIC_SECTIONS.filter((s) => s.id === focus.toLowerCase())
            : RUBRIC_SECTIONS;
        if (!sections.length)
            return fail(`No rubric section "${focus}". Existing: ${RUBRIC_SECTIONS.map((s) => s.id).join(", ")}`);
        const topic = findTopic("rubric");
        return ok([
            `# Design critique rubric — ${RUBRIC_SECTIONS.length} sections, weights sum ${RUBRIC_SECTIONS.reduce((n, s) => n + s.weight, 0)}`,
            "Score every section, then report the single highest-impact fix with the evidence behind it.",
            "",
            ...sections.map(render),
            how ? `\n---\n\n${topic.entries.map(renderEntry).join("\n\n")}` : "",
        ].filter(Boolean).join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("antislop_check", {
    title: "Scan for generated-looking defaults",
    description: "Scans CSS/HTML/JS/TS source for the machine-detectable tells of generated design (banned typefaces, purple gradient fills, gradient blobs, uniform radii and shadows, glass navbars, emoji icons, placeholder copy, fake form success, outline removal) and returns each match with its line, a severity and the concrete better move. Pass `path` for a file in the project or `text` for a snippet. A clean result is not proof of originality — follow it with critique_rubric. No API call.",
    inputSchema: {
        text: z.string().optional().describe("Source code to scan"),
        path: z.string().optional().describe("File inside the project, e.g. index.html"),
    },
}, async ({ text, path: p }) => {
    try {
        if (!text && !p)
            return fail("Pass either `text` or `path`.");
        let source = text ?? "";
        let label = "snippet";
        if (p) {
            const file = resolveInProject(p);
            const stat = await fs.stat(file).catch(() => null);
            if (!stat?.isFile())
                return fail(`No file at ${file} inside the project folder.`);
            if (stat.size > 400_000)
                return fail(`${p} is ${Math.round(stat.size / 1024)} KB; scan a smaller file or pass an excerpt as text.`);
            source = await fs.readFile(file, "utf8");
            label = p;
        }
        const findings = scanSlop(source);
        const high = findings.filter((f) => f.severity === "high").length;
        return ok([
            renderSlopFindings(findings, label),
            findings.length
                ? `\nNext: fix the ${high} high-severity match(es) first, then run critique_rubric to judge what a pattern scan cannot see.`
                : "",
        ].filter(Boolean).join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("sequence_extract", {
    title: "Turn a video into a scroll-scrubbed frame sequence",
    description: "Builds the asset behind a scroll-linked scene: evenly sampled WebP frames, a poster still and a manifest, written to .design-mcp/sequences/<name>/ and copied into every variation at build time as /sequences/<name>/. Reports frame count, bytes per frame, total weight and the decoded working set against the budgets, and when ffmpeg is missing it says so and hands back the exact command to run instead. Feed it any local clip — from an image-to-video model, a screen recording, or a render — then design_build places it as the one moment the page is driven by scroll rather than merely revealed by it.",
    inputSchema: {
        video: z.string().describe("Path to the source clip (mp4, mov, m4v, webm, mkv, avi), relative to the project or absolute"),
        name: z.string().describe("Sequence name, lowercase-kebab; becomes /sequences/<name>/ in the built site"),
        frames: z.number().int().min(24).max(240).optional().describe("Frames sampled evenly across the clip. More frames = smoother scrub and more bytes"),
        longEdge: z.number().int().min(320).max(2400).optional().describe("Long edge of every frame in pixels (default 1280)"),
        quality: z.number().int().min(40).max(100).optional().describe("WebP quality (default 80)"),
        overwrite: z.boolean().optional().describe("Replace an existing sequence with the same name"),
    },
}, async ({ video, name, frames, longEdge, quality, overwrite }) => {
    try {
        const { config } = loadConfig();
        const r = await prepareSequence({
            video, name, cfg: config.build, budgets: config.test.budgets, cwd: projectDir(),
            frames, longEdge, quality, overwrite: !!overwrite,
        });
        const kb = (n) => Math.round(n / 1024);
        return ok([
            `Sequence "${r.name}" is ready: ${r.frames} ${r.format.toUpperCase()} frames at ${r.width}x${r.height}, ${kb(r.bytes)} KB total (${r.bytesPerFrame} bytes per frame).`,
            `Decoded working set: about ${Math.round(r.decodeMiB)} MB, the frames the renderer holds at once (budget ${config.test.budgets.sequenceDecodeWindowMB} MB).`,
            `Stored in .design-mcp/sequences/${r.name}/ (manifest.json, frame-001.webp ... , poster.webp) and copied into every variation as /sequences/${r.name}/.`,
            `Poster still (the reduced-motion and loading fallback): ${r.poster}`,
            "",
            ...r.notes.map((n) => `Note: ${n}`),
            "Next: design_build. The builder may use ONE scroll scene, through the ScrollSequence component shipped in every variation (src/motion/sequence.tsx).",
            `Extraction command (for the record): ${r.command}`,
        ].filter(Boolean).join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
/* ---- the codebase layer: ground truth about this repo, computed from the files, no model involved ---- */
server.registerTool("code_index", {
    title: "Index this codebase",
    description: "Walks the project and indexes it: every file, every declaration it can see with its line numbers, every import, how the project is built and run, and its own rule files. The index is cached in .design-mcp/codebase/index.json and reused until a file actually changes (path, size or mtime), so calling it again after an edit costs one stat pass rather than a re-read. It respects .gitignore (via git ls-files) and the codebase.roots/ignore config, and it never reads outside the project. No model is called, so this is fast and cannot be wrong in the way prose is wrong. Run it first, then read its digest instead of opening files at random.",
    inputSchema: {
        refresh: z.boolean().optional().describe("Rebuild even if nothing changed"),
        path: z
            .string()
            .optional()
            .describe("Index this repository instead: points the whole session at it, exactly like project_root { path }"),
    },
}, async ({ refresh, path: wanted }) => {
    try {
        const t0 = Date.now();
        if (wanted !== undefined) {
            const problem = await adoptProjectPath(wanted);
            if (problem)
                return fail(problem);
        }
        const { config } = loadConfig();
        const loaded = await getIndex(projectDir(), config.codebase, { refresh: !!refresh });
        const digest = renderDigest(loaded.index, { tokens: config.codebase.digestTokens });
        return ok([
            summarizeIndex(loaded),
            `.design-mcp/codebase/index.json written (${loaded.stampMs} ms to check the files, ${Date.now() - t0} ms in total)`,
            "",
            `Below is the digest: ~${estimateTokens(digest)} tokens (budget ${config.codebase.digestTokens}) that replaces reading the files. Read it, then use code_context for the part you are about to change.`,
            "",
            digest,
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("code_digest", {
    title: "The compact map of this codebase",
    description: "The digest: file paths with real line counts, exported symbols with their real line numbers, the commands that build and test the project, its own rule files, its entry points, the files most imported by others, and the third-party surface. Computed from the files themselves rather than written by a model, so it is stable and checkable, and trimmed to a token budget with whatever was cut named at the end. This is what an assistant should read instead of guessing at the shape of a repo. Also available as the resource code://digest.",
    inputSchema: { focus: z.string().optional().describe("What you are about to work on: files relevant to it are listed first") },
}, async ({ focus }) => {
    try {
        const { config } = loadConfig();
        const { index } = await getIndex(projectDir(), config.codebase, {});
        return ok(renderDigest(index, { tokens: config.codebase.digestTokens, focus }));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("code_context", {
    title: "Pack the source a question needs",
    description: "Given a question (or paths you already know you need), returns the smallest set of real source lines that can answer it: the files ranked by path, symbol name, doc and import-graph relevance, one hop out to what they depend on and who depends on them, each slice carrying the file's own line numbers, and every file considered and left out with the reason it was left out. Deterministic and model-free, so it costs milliseconds and cannot flatter you. Cite what comes back as path:line. If it returns nothing, the honest answer is 'not in the indexed codebase', not a guess.",
    inputSchema: {
        query: z.string().describe("The question or the work, e.g. 'where is the session cookie signed' or 'the newsletter unsubscribe route'"),
        paths: z.array(z.string()).optional().describe("Files you already know you need; they outrank the ranking and are never dropped silently"),
        exclude: z.array(z.string()).optional().describe("Files to leave out, e.g. the ones another worker already owns"),
        budgetTokens: z.number().int().min(500).max(60000).optional().describe("Defaults to codebase.contextTokens"),
        refresh: z.boolean().optional().describe("Reindex before packing"),
    },
}, async ({ query, paths, exclude, budgetTokens, refresh }) => {
    try {
        const { config } = loadConfig();
        const { index, cached } = await getIndex(projectDir(), config.codebase, { refresh: !!refresh });
        const pack = await packContext(projectDir(), index, {
            query,
            paths,
            exclude,
            budget: budgetTokens ?? config.codebase.contextTokens,
        });
        return ok([`index ${cached ? "reused (files unchanged)" : `rebuilt in ${index.buildMs} ms`}`, renderPack(pack)].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("code_verify_cites", {
    title: "Check citations against the files",
    description: "The anti-hallucination gate, and the one tool here that can say 'you are wrong'. Give it claims, each with a path, an optional line range and the exact quote you are relying on. It re-reads each file and answers: verified (the quote is at the cited lines), found-elsewhere (the quote is real but the line numbers are wrong), quote-not-found (the claim is unsupported), file-missing, or outside-project (refused, never read). It also flags the second failure a citation can have: a quote that is really there but shares no wording with the claim it is attached to, which is labelled as thin support rather than trusted. That label is one-sided and says nothing about the reverse case: wording in common is not entailment, so a verified quote still proves only that the file says that. No model is involved, so it cannot be talked round. Run your own claims through it before you tell the owner something about their code; run a worker's claims through it before you trust them. Whitespace is ignored, everything else must match.",
    inputSchema: {
        claims: z
            .array(z.object({
            claim: z.string().optional().describe("What you believe, for the report; the quote is what is checked"),
            path: z.string(),
            lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
            quote: z.string().min(4).describe("Text copied from those lines"),
        }))
            .min(1)
            .max(50),
    },
}, async ({ claims }) => {
    try {
        const v = await verifyCallerClaims(projectDir(), claims);
        return ok([
            renderVerification(v, { quotes: false }),
            "",
            "What the statuses mean:",
            ...Object.entries(STATUS_MEANING).map(([k, s]) => `  - ${k}: ${s}`),
            "",
            "What the support label means (only set when the quote was found):",
            ...Object.entries(SUPPORT_MEANING).map(([k, s]) => `  - ${k}: ${s}`),
            "",
            v.counts.verified === v.claims.length
                ? "Every claim checked out. Quote these lines when you report to the owner."
                : "Fix or drop anything that is not verified before reporting it as fact.",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("code_verify_edits", {
    title: "Check where an edit lands, before you make it",
    description: "The same gate as code_verify_cites, pointed at the work instead of the claims. Give it the edits you or a worker are about to make: a path, and where possible an anchor (the symbol or the exact line the edit sits next to) and a line range. It re-reads each file and answers whether the edit can be applied as described — anchored, anchor-elsewhere (the anchor is real but the line numbers are stale), anchor-ambiguous (the anchor occurs more than once and no line range says which one), anchor-not-found (the anchor is not in that file at all), lines-out-of-range, no-such-file, outside-project, or unanchored when there was nothing to check but the path. For each edit it also reads the index's import graph and reports what a change there can break: how many indexed files import it, which of them are tests, and whether the anchor is declared in a different file, which means the edit sits at a use site and a rename would have to sweep that declaration's importers. Every checked edit carries the sha256 of the file exactly as it was read, so a re-check can tell whether the cited line numbers are still the ones that were checked. No model is involved and nothing is ever applied: this says where an edit lands, never whether the change is right. Run it before you hand the owner an edit, and run it on a dossier's plan before you follow that plan.",
    inputSchema: {
        edits: z
            .array(z.object({
            path: z.string().min(1),
            anchor: z.string().optional().describe("The symbol, name or exact line of code the edit sits next to"),
            lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
            intent: z.string().optional().describe("What the edit is meant to do, for the report"),
            risk: z.enum(["low", "medium", "high"]).optional(),
        }))
            .min(1)
            .max(50),
    },
}, async ({ edits }) => {
    try {
        const { config } = loadConfig();
        const { index } = await getIndex(projectDir(), config.codebase, {});
        const proposed = edits.map((e, i) => ({ source: "caller", sourceIndex: i, path: e.path, intent: e.intent ?? "(no intent given)", anchor: e.anchor, lines: e.lines, risk: e.risk }));
        const check = await verifyEdits({ projectRoot: projectDir(), index, edits: proposed });
        return ok([
            renderEditCheck(check, { heading: false, limit: 30 }),
            "",
            "What the statuses mean:",
            ...Object.entries(EDIT_STATUS_MEANING).map(([k, s]) => `  - ${k}: ${s}`),
            "",
            check.broken
                ? "Do not apply the edits above that cannot be applied as described: an edit anchored to something that is not in the file is a guess about where the code goes. Re-cite it (the report says where the closest line is) or drop it."
                : "Every edit landed where it says it does. If the file hashes differently now, the line numbers are stale: re-check rather than guess.",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("code_refs", {
    title: "Who declares this name, and who uses it",
    description: "The question the import graph cannot answer: for one symbol or identifier, every place it is declared and every place it is used, with the real file, line and text of each. Use it before a rename, a signature change or a deletion — 'this file imports that one' is not the same as 'this code calls that function', and a file that never imports it can still name it in a test title or a string. Declarations come first, with their kind and whether they are exported; if nothing declares the name, the report says so and tells you to treat it as external until you find the definition. It is a word-boundary text scan over the indexed files, not a type checker: a match inside a comment or a string counts, a same-named local in an unrelated file counts, and a name reached dynamically is invisible — read the lines before acting on them. Deterministic and keyless: no model, no language server, no build. Files the index skipped (binary, minified, over the size cap, outside the configured roots) are never scanned, and the report says which caps it hit.",
    inputSchema: {
        name: z.string().min(2).describe("The identifier or symbol name, e.g. formatMoney or verifyReports"),
        paths: z.array(z.string()).optional().describe("Restrict the scan to these files (the rename surface), instead of every indexed file"),
        limit: z.number().int().min(1).max(200).optional().describe("How many uses to quote; defaults to 40"),
    },
}, async ({ name, paths, limit }) => {
    try {
        const { config } = loadConfig();
        const { index } = await getIndex(projectDir(), config.codebase, {});
        const report = await findReferences({ projectRoot: projectDir(), index, name, only: paths });
        const next = report.declarations.length
            ? [
                "",
                `Before you change it: ${report.declarations.length} declaration(s), ${report.uses.length} use(s) quoted. If the declaration is exported, the importers named above are the ones a signature change reaches; if it is not exported, the uses in its own file are the whole surface.`,
            ]
            : [
                "",
                "No declaration in the indexed files. That means one of three things — a dependency, a file the index skipped, or a name you have just invented. Check before you use it in code.",
            ];
        return ok([renderReferences(report, { limit: limit ?? 40 }), ...next].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
/* ---- the collective: one leader, several copies of the model, quotes checked before anyone agrees ---- */
function renderPlan(plan, known) {
    return [
        "Restated in this repository's terms:",
        plan.restated,
        "",
        `Units (${plan.units.length}), each one running in parallel with no memory of the others:`,
        ...plan.units.map((u) => [
            `- ${u.id} [${u.role}] ${u.objective}`,
            `    owns: ${u.scope.length ? u.scope.map((p) => `${p}${known.has(p) ? "" : " (DOES NOT EXIST)"}`).join(", ") : "nothing named"}`,
            u.skill ? `    follows your skill: ${u.skill}` : "",
            ...u.mustAnswer.map((q) => `    must answer: ${q}`),
            ...u.doneWhen.map((d) => `    done when: ${d}`),
        ]
            .filter(Boolean)
            .join("\n")),
        ...(plan.assumptions.length ? ["", "Assumed (unverified):", ...plan.assumptions.map((a) => `  - ${a}`)] : []),
        ...(plan.unknowns.length ? ["", "Admitted unknowns:", ...plan.unknowns.map((a) => `  - ${a}`)] : []),
        ...(plan.risks.length ? ["", "Risks:", ...plan.risks.map((a) => `  - ${a}`)] : []),
    ].join("\n");
}
server.registerTool("collective_plan", {
    title: "The leader splits a mission into units",
    description: "One planning call. A leader model reads the codebase digest (the map of the repo, never the file contents) and cuts the mission into independent units: an explorer to report what the code does today, an architect to choose the shape, an implementer to place the edits, a verifier whose only job is to falsify the others, a critic to judge against this project's own standards. Each unit names the files it owns, so no two of them edit the same file, and each carries concrete questions it must answer. Use it when you want the split and will dispatch the workers yourself; use collective_run to have the server dispatch them. Runs on roles.leader, which defaults to your own host model via sampling, so no API key is needed.",
    inputSchema: {
        mission: z.string().describe("What needs to be done or understood, in plain language"),
        focus: z.string().optional().describe("The part you care about most"),
        paths: z.array(z.string()).optional().describe("Files you already know are involved"),
        units: z.number().int().min(1).max(12).optional().describe("Cap on units; defaults to collective.maxUnits"),
        skills: z.array(z.string()).optional().describe("Shortlist of your installed skills to offer the leader, by name; defaults to all of them"),
    },
}, async ({ mission, focus, paths, units, skills }) => {
    try {
        const { config } = loadConfig();
        const { index, cached } = await getIndex(projectDir(), config.codebase, {});
        const digest = renderDigest(index, { tokens: config.codebase.digestTokens, focus: focus ?? mission });
        const maxUnits = Math.min(config.collective.maxUnits, units ?? config.collective.maxUnits);
        const scan = config.skills.enabled ? await discoverSkills(projectDir(), config.skills) : { skills: [], roots: [], notes: [] };
        const offered = skills?.length ? scan.skills.filter((s) => skills.some((n) => s.name.toLowerCase() === n.toLowerCase())) : scan.skills;
        const skillIndex = offered.slice(0, 40).map((s) => `- ${s.name} — ${s.description.replace(/\s+/g, " ").slice(0, 180)}`).join("\n");
        const asked = await askJson({
            role: "leader",
            system: leaderSystem(maxUnits, skillIndex || undefined),
            user: leaderUser({ mission, digest, focus, paths, maxUnits }),
            schema: LeaderPlanSchema,
            maxTokens: 2200,
            attempts: 2,
        });
        const known = new Set(index.files.map((f) => f.path));
        const missing = asked.value.units.flatMap((u) => u.scope.filter((p) => !known.has(p.replace(/^\.\//, ""))));
        return ok([
            renderPlan(asked.value, known),
            "",
            `Leader: ${config.roles.leader.provider}/${config.roles.leader.model}, ${asked.attempts} attempt(s), ${asked.ms} ms, over a ~${estimateTokens(digest)}-token digest of ${index.totals.files} files${cached ? " (index reused)" : ` (index built in ${index.buildMs} ms)`}.`,
            missing.length ? `Warning: the leader scoped files that do not exist: ${missing.join(", ")} — trim them before dispatching.` : "Every path the leader scoped exists in the index.",
            "",
            "Next: dispatch these units (one worker each, parallel, each with its own code_context pack) and check every claim they make with code_verify_cites — or run the whole thing with collective_run.",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("collective_run", {
    title: "Run the collective on a mission",
    description: "The full loop, in the background, for one mission: a leader plans from the repo's digest, the units answer in parallel on their own slices of real source, the server re-reads every quote and deletes what does not survive, a citation the gate rejected goes back to its own unit once to be re-quoted or withdrawn, the copies then read each other's verified findings (round two), the leader closes with what remains, and both the closing paragraph and every step the mission proposes are checked before anyone reads them — a sentence that asserts a finding the gate deleted, states a thin-support quote as established or names a file that is not in the repository goes back to the leader once, and a step that cannot be placed goes back to its own source once, with the server's reason, and both are re-checked. Returns a job id immediately — poll with design_status. The dossier lands in .design-mcp/collective/<id>.md, is the job result, and is readable with collective_report: it carries the verified quotes, the rejected claims, every proposed edit checked against the file as it is now (did the path exist, was the anchor really in it at those lines, what imports it), the conversation, disagreements nobody settled, and what the run did not check. Workers run on roles.worker (your host model via sampling by default, so no key), one model call per unit plus one for round two.",
    inputSchema: {
        mission: z.string().describe("What needs to be done or understood"),
        focus: z.string().optional(),
        paths: z.array(z.string()).optional(),
        units: z.number().int().min(1).max(12).optional(),
        workers: z.number().int().min(1).max(6).optional().describe("How many units may run at once; defaults to collective.maxWorkers"),
        peer: z.boolean().optional().describe("Round two: let the units read each other's verified findings and answer with evidence. Defaults to collective.peerRound; costs one extra model call per unit"),
        repair: z.boolean().optional().describe("The repair pass: a finding the citation gate rejected goes back to its unit ONCE with the server's reason and the line the quote really lives at, and the answer is re-gated the same way. Defaults to collective.repairRound; costs at most one extra call per unit that had a repairable rejection"),
        conclusion: z.boolean().optional().describe("The conclusion repair pass: a sentence of the leader's closing paragraph that contradicts this mission's own record — a finding the gate deleted restated as fact, a thin-support quote stated as established, a claim its own author withdrew, or a file that is not in the repository — goes back to the leader ONCE, by number, with the record's words, and the rewrite is re-checked. Defaults to collective.conclusionRepair; costs one extra call"),
        skills: z.array(z.string()).optional().describe("Shortlist of your installed skills to offer the leader, by name; defaults to all of them"),
    },
}, async ({ mission, focus, paths, units, workers, peer, repair, conclusion, skills }) => {
    try {
        const { config } = loadConfig();
        for (const role of ["leader", "worker"]) {
            if (providerNeedsKey(config.roles[role].provider))
                apiKeyFor(config.roles[role].provider);
        }
        const job = startJob("collective", async (log) => {
            const collective = {
                ...config.collective,
                ...(peer === undefined ? {} : { peerRound: peer }),
                ...(repair === undefined ? {} : { repairRound: repair }),
                ...(conclusion === undefined ? {} : { conclusionRepair: conclusion }),
            };
            const r = await runMission(projectDir(), { codebase: config.codebase, collective, skills: config.skills, local: config.local }, { mission, focus, paths, units, workers, skills }, log);
            log(`dossier written to ${path.relative(projectDir(), r.file)}`);
            return [
                `Dossier: ${path.relative(projectDir(), r.file)}`,
                `verified ${r.stats.verified} claim(s), rejected ${r.stats.rejected}, ${r.stats.calls} model call(s), ${r.stats.ms} ms`,
                r.verdict.headline,
                "",
                r.dossier,
            ].join("\n");
        });
        return ok([
            `Mission started (job ${job.id}).`,
            `Leader and workers run on ${config.roles.leader.provider}/${config.roles.leader.model} and ${config.roles.worker.provider}/${config.roles.worker.model}.${effectiveLocal(projectDir(), config.local).on ? " Local mode is ON: units the leader marks eligible are delegated to the local model and audited." : ""}`,
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("collective_report", {
    title: "Read a mission dossier",
    description: "Without an id: lists the mission dossiers kept in .design-mcp/collective/. With an id: returns that dossier — a verdict counted from the gate's own results, what the collective concluded, the plan, every verified quote with its file and line, the quotes that are real but do not visibly back their claim, what the server rejected as unsupported, the repair pass and what it fixed or withdrew, every edit the mission proposed with what the gate said about where it lands and what the edit repair pass settled, the closing paragraph checked sentence by sentence against the mission's own record and what the conclusion repair pass settled, conflicts between units, admitted unknowns, and what the run explicitly did not check.",
    inputSchema: { id: z.string().optional().describe("Mission id, e.g. m-abc123 (a prefix works too)") },
}, async ({ id }) => {
    try {
        if (id)
            return ok(await loadDossier(projectDir(), id));
        const list = await listDossiers(projectDir());
        if (!list.length)
            return ok("No missions yet. Run collective_run to start one.");
        return ok([`${list.length} dossier(s) in .design-mcp/collective/:`, ...list.map((d) => `- ${d.id} (${Math.round(d.bytes / 1024)} KB)`)].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("collective_memory", {
    title: "What the collective remembers about this repo",
    description: "The collective's memory between missions: claims whose quote the server itself re-read, claims it rejected (kept so nobody repeats them), and the owner's own rulings. Every quoted entry is re-checked against the file as it is now, and anything whose code has changed or gone is listed as stale and kept out of every prompt — a memory that cannot expire is a memory that will confidently lie. Only quote-verified claims from a mission that reached a conclusion are ever recorded, because adding everything is a measured way to make the next mission worse. Memory is a hint list, never a citation. Also the resource code://memory.",
    inputSchema: {
        action: z.enum(["list", "ruling", "forget"]).default("list").describe("list (default), ruling to record the owner's decision, forget to erase it all"),
        text: z.string().optional().describe("The ruling, required for action=ruling. Say it as a constraint: 'never let the newsletter double-send'"),
    },
}, async ({ action, text }) => {
    try {
        const { config } = loadConfig();
        if (action === "forget") {
            const n = await clearMemory(projectDir());
            return ok(`Erased ${n} memory entr${n === 1 ? "y" : "ies"}. The collective starts from nothing next mission.`);
        }
        if (action === "ruling") {
            if (!text || text.trim().length < 8)
                return fail("action=ruling needs `text` with the decision, e.g. 'never let the newsletter double-send'.");
            const item = await addRuling(projectDir(), text.trim(), config.collective.memoryItems);
            return ok(`Recorded as a ruling (${item.id}). Rulings are given to the leader and every worker in every future mission, and are never pruned.`);
        }
        const loaded = await loadMemory(projectDir());
        return ok(renderMemoryReport(loaded));
    }
    catch (e) {
        return fail(e);
    }
});
/* ---- saying hello: the session bootstrap, your skills, and making it automatic ---- */
server.registerTool("collective_hello", {
    title: "Wake the collective in this repo",
    description: "The session bootstrap, and the answer to \"Hello collective.\": one cheap pass with no model call and no API key. Returns the roll call of seats, the codebase digest computed from the files, what the collective already established or already got wrong here (with stale entries named), the recent mission dossiers, the owner's installed skills, and the state of the git tree — followed by the exact next steps so the answer is not improvised. Call it once at the start of a session in this project, then answer the owner from it instead of from memory of this repo. Written into the project's instruction file by collective_install so a host that reads those files calls it without being asked.",
    inputSchema: {
        focus: z.string().optional().describe("What the owner said they want, so the digest and the advice point at it"),
        budgetTokens: z.number().int().min(300).max(8000).optional().describe("Digest size; defaults to 1100 tokens, capped by codebase.digestTokens"),
        skills: z.boolean().optional().describe("Skip the skills scan with false (it walks the configured roots)"),
    },
}, async ({ focus, budgetTokens, skills }) => {
    try {
        const { config } = loadConfig();
        const r = await helloCollective(projectDir(), config, { focus, budgetTokens, skills });
        return ok(r.text);
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("local_mode", {
    title: "Local model mode (Ollama) on/off and its status",
    description: 'With no arguments: the current local-delegation status — on/off, which source set it, the model, host and per-request values, the lifetime counters (delegated / audit-passed / audit-rejected / fell back) and this session\'s transport counters. With { set: "on" }: runs a health check first (Ollama must be reachable and the model must be pulled) and only then flips the mode on; it stays on across server restarts until you flip it off. With { set: "off" }: flips off immediately, aborts the request in flight and refuses every queued local task — those units fall back to the council. Passing model also sets (or swaps, for an A/B test) the model the mode runs on. A cloud model (any tag ending in :cloud, e.g. beam:cloud) works the same way: your local Ollama daemon proxies it to ollama.com, the status line says so, and the code slices it is sent leave this machine.',
    inputSchema: {
        set: z.enum(["on", "off"]).optional().describe("Flip local delegation on or off at runtime; omit to just read the status"),
        model: z
            .string()
            .optional()
            .describe("The Ollama model tag to delegate to, e.g. deepseek-coder-v2:latest, qwen2.5-coder:7b, or a cloud model such as beam:cloud (it runs on ollama.com, proxied by your local daemon)"),
    },
}, async ({ set, model }) => {
    try {
        const root = projectDir();
        const { config } = loadConfig();
        const local = config.local;
        if (set === "off") {
            // Immediate: abort what is on the wire and revoke every queued call before the file even lands.
            cancelAll();
            writeLocalMode(root, { on: false, model });
            return ok(["Local mode is OFF. The request in flight was aborted and queued local tasks were refused; their units go back to the council.", "", renderLocalStatus(root, local)].join("\n"));
        }
        if (set === "on") {
            // Health check BEFORE the flip: an on that cannot run is worse than staying off, because every
            // unit would then silently pay a health-check round-trip before falling back anyway.
            const h = await health(settingsFor(local));
            if (!h.ok) {
                return fail(new Error(`Local mode stays off: ${h.detail}\nStart Ollama (ollama serve) and pull the model (ollama pull ${model ?? local.model}), then flip it on again.`));
            }
            if (h.modelMissing) {
                return fail(new Error(`Local mode stays off: the model "${model ?? local.model}" is not pulled. Available: ${h.models.join(", ")}.\nRun: ollama pull ${model ?? local.model}`));
            }
            const state = writeLocalMode(root, { on: true, model });
            resetWarned();
            const effModel = state.model ?? local.model; // the effective model, never a bare "undefined"
            return ok([
                `Local mode is ON (${effModel}); Ollama answered and the model is present.`,
                // A cloud model is the one case where "local" is only a routing mode: say where the code goes.
                ...(isCloudModel(effModel) || h.remote
                    ? [`${effModel} is served by ${h.remote ?? "ollama.com"}, not by this machine: the file slices a delegated unit is given are sent there. The audit ladder and the council review still run on what comes back.`]
                    : []),
                "The leader may mark well-scoped implementer units local; their output is audited (typecheck → lint → tests → import check → council review) before it is kept.",
                "",
                renderLocalStatus(root, local),
            ].join("\n"));
        }
        const eff = effectiveLocal(root, local);
        const counters = localCounters();
        return ok([
            renderLocalStatus(root, local),
            `this session's transport: ${counters.calls} request(s), ${counters.errors} failed, ${counters.timeouts} timed out, ${counters.refused} queued then cancelled by a mode switch`,
            eff.on ? "Health is checked when it is flipped on and before a mission delegates; with the mode off, zero Ollama calls happen." : "With the mode off, zero Ollama calls happen.",
        ].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("agent_run", {
    title: "Run a tool-using agent (opt-in, config-gated)",
    description: "The one deliberate exception to this server's no-command-runner rule. An Ollama model (/api/chat with tools) works on one task with its own hands: read_file, list_files, search, who_refs, read_context, write_file, edit, run, run_audit, finish. It is OFF unless design-mcp.config.json sets agent.enabled — there is no runtime flip and no argument here that turns it on, because a model must never be one call away from giving itself a shell. When it runs: every path is realpath-confined to the project, writes are allowed only under agent.writeRoots (empty = read-only), every command goes through agent.bash (off | allowlist | shell, the last needing DESIGN_MCP_AGENT_SHELL=1), every file is snapshotted before its first write, and the run is reverted byte-for-byte unless the edit gate finds no broken anchor, one council diff review passes and the project's own typecheck/tests pass — otherwise the diff is kept as proposed.patch. It runs as a background job: poll design_status. This is confinement and reversibility, not isolation: shell mode is your terminal in that directory, so leave it off unless you mean it. Call with no task for the status and lifetime counters.",
    inputSchema: {
        task: z.string().optional().describe("What to change or find out, in one or two sentences. Omit for the status and counters."),
        writeRoots: z.array(z.string()).optional().describe("Override agent.writeRoots for this run; an empty array is a read-only run"),
        maxRounds: z.number().int().min(1).max(60).optional().describe("Override agent.maxRounds for this run"),
        dryRun: z.boolean().optional().describe("Read-only by construction: same as writeRoots: []"),
    },
}, async ({ task, writeRoots, maxRounds, dryRun }) => {
    try {
        const { config } = loadConfig();
        const root = projectDir();
        const cfg = config.agent;
        if (!task || !task.trim()) {
            const c = readAgentCounters(root);
            return ok([
                `agent_run is ${cfg.enabled ? "ON" : "OFF"} (config: ${cfg.enabled ? "agent.enabled is true" : 'agent.enabled is false — add "agent": { "enabled": true } to design-mcp.config.json'}).`,
                `model: ${cfg.model} at ${cfg.host}${/[:-]cloud$/i.test(cfg.model) ? " — a cloud model: what it reads leaves this machine" : ""}`,
                `writes allowed under: ${cfg.writeRoots.length ? cfg.writeRoots.join(", ") : "nothing (read-only until you name a directory)"}`,
                `commands: ${cfg.bash.mode}${cfg.bash.mode === "shell" ? " (and DESIGN_MCP_AGENT_SHELL=1)" : ""} · caps ${cfg.maxRounds} rounds / ${cfg.maxToolCalls} calls / ${cfg.maxWallClockSec}s · requireClean ${cfg.requireClean} · isolation ${cfg.isolation}`,
                `gates: typecheck ${cfg.gates.runTypecheck ? "on" : "off"}, tests ${cfg.gates.runTests ? "on" : "off"}, council review ${cfg.gates.councilReview ? "on" : "off"}`,
                `lifetime: ${c.runs} run(s) — ${c.kept} kept, ${c.reverted} reverted, ${c.unsafe} unsafe, ${c.failed} failed · ${c.rounds} rounds · ${c.toolCalls} tool calls · ${c.commands} commands · ${c.refusals} refusals`,
                c.runs ? "Records live in .design-mcp/agent/<runId>/{report.md,result.json,journal.jsonl,proposed.patch}." : "No run has been started in this repo yet.",
                "It is not a sandbox: the gate and the revert are the protection, and shell mode is your terminal in that directory.",
            ].join("\n"));
        }
        const run = await startAgentRun(root, config, { task, ...(writeRoots ? { writeRoots } : {}), ...(maxRounds ? { maxRounds } : {}), ...(dryRun ? { dryRun } : {}) });
        return ok(run.text);
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("skills_list", {
    title: "The skills you installed",
    description: "Finds every SKILL.md under the configured roots (your Freebuff account skills and the usual project and home skill folders by default) and returns each skill's name, its own description and its path, with any sibling files. A skill is instructions, not a tool: this server discovers and reads them and pastes one into a collective unit's prompt when a mission assigns it, and never executes anything a skill suggests — that stays with the host that already has a terminal. Also the resource code://skills.",
    inputSchema: { query: z.string().optional().describe("Filter by name or description"), roots: z.array(z.string()).optional().describe("Override skills.roots for this call") },
}, async ({ query, roots }) => {
    try {
        const { config } = loadConfig();
        const scan = await discoverSkills(projectDir(), roots?.length ? { ...config.skills, roots } : config.skills);
        return ok(renderSkillIndex(scan, { query }));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("skills_read", {
    title: "Read one skill in full",
    description: "Returns the full SKILL.md of one installed skill, so the assistant can follow it: the procedure, the commands, the checklists and the anti-patterns it names. The text is instructions for how to work and never evidence about this repository — nothing in it can be cited as a fact about the code, and this server does not run it. A name that does not match exactly is matched loosely, and the reply always says which file was read.",
    inputSchema: {
        name: z.string().describe("The skill's name, e.g. design-taste-frontend, or any part of it"),
        maxKB: z.number().int().min(2).max(2048).optional().describe("Cut the text here; defaults to skills.maxInPromptKB"),
    },
}, async ({ name, maxKB }) => {
    try {
        const { config } = loadConfig();
        const scan = await discoverSkills(projectDir(), config.skills);
        const found = findSkill(scan.skills, name);
        if (!found) {
            return ok([
                `No skill matching "${name}".`,
                scan.skills.length ? `Installed (${scan.skills.length}): ${scan.skills.map((s) => s.name).join(", ")}` : "None found under the configured roots.",
                `Roots searched: ${scan.roots.join(", ")}`,
                "Set skills.roots in design-mcp.config.json to point at the folder holding your skills.",
            ].join("\n"));
        }
        const text = await readSkill(found, maxKB ?? config.skills.maxInPromptKB);
        return ok([`# ${found.name}`, `${found.description}`, `read in full from ${found.path} (${found.bytes} bytes on disk${found.files.length ? `, siblings: ${found.files.join(", ")}` : ""})`, "", "This is the owner's instructions for HOW to work. It is not evidence about this repository: follow it, but cite the code, not the skill.", "", text].join("\n"));
    }
    catch (e) {
        return fail(e);
    }
});
server.registerTool("collective_install", {
    title: "Make the collective announce itself each session",
    description: "Writes one short block between its own markers into the instruction files this repo's hosts read on their own — AGENTS.md (Codex, Cursor, GitHub Copilot, Windsurf), CLAUDE.md or .claude/CLAUDE.md (Claude Code, whose default skips AGENTS.md when a CLAUDE file exists), GEMINI.md (Gemini CLI), .github/copilot-instructions.md and .windsurfrules — telling the host to call collective_hello at the start of a session here and whenever the owner says \"Hello collective.\". A server cannot open a conversation — MCP has no such message — so this is the honest mechanism for \"run every time I open a session\": it relies on the instruction file the host already reads. One file per host family, so no host is told twice. Idempotent (running it twice writes nothing the second time), never touches text outside its markers, names the families it did not cover instead of creating files the repo never had, and action=remove takes the block back out. Also available as the prompt hello_collective for hosts that only honour prompts.",
    inputSchema: {
        action: z.enum(["install", "remove", "show"]).default("install"),
        targets: z
            .array(z.string())
            .optional()
            .describe("Instruction files to use instead of auto-detection, e.g. [\"GEMINI.md\"] or [\"AGENTS.md\",\"CLAUDE.md\"]"),
        create: z.boolean().optional().describe("With action=install, create AGENTS.md when the repo has no instruction file at all (default true)"),
    },
}, async ({ action, targets, create }) => {
    try {
        const root = projectDir();
        if (action === "show") {
            const { results, uncovered } = await installSessionBlock(root, { targets, create: false, dry: true });
            return ok(renderInstallReport(results, root, true, uncovered));
        }
        if (action === "remove")
            return ok(renderInstallReport(await removeSessionBlock(root, { targets }), root));
        const { results, uncovered } = await installSessionBlock(root, { targets, create });
        return ok(renderInstallReport(results, root, false, uncovered));
    }
    catch (e) {
        return fail(e);
    }
});
/* ---- resources: the same knowledge, addressable for hosts that attach context ---- */
server.registerResource("design-playbook", resourceUri("index"), { title: "Design playbook index", description: "Every design-playbook topic and entry, with intents.", mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: topicIndex() }] }));
for (const topic of TOPICS) {
    server.registerResource(`playbook-${topic.id}`, resourceUri(topic.id), { title: topic.title, description: topic.summary, mimeType: "text/markdown" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderTopic(topic) }] }));
}
server.registerResource("critique-rubric", "design://rubric/sections", { title: "Design critique rubric sections", description: "The eleven weighted rubric sections with their evidence checks.", mimeType: "text/markdown" }, async (uri) => ({
    contents: [
        {
            uri: uri.href,
            mimeType: "text/markdown",
            text: RUBRIC_SECTIONS.map((s) => `## ${s.title} (${s.weight})\n${s.verify}`).join("\n\n"),
        },
    ],
}));
/* ---- the codebase and the contract, as resources a host can attach ---- */
const codeResource = (id, title, description, render) => server.registerResource(id, `code://${id}`, { title, description, mimeType: "text/markdown" }, async (uri) => {
    const { config } = loadConfig();
    const { index } = await getIndex(projectDir(), config.codebase, {});
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: render(index) }] };
});
codeResource("digest", "Codebase digest", "The compact, computed map of this repo: files, symbols, line numbers, commands, rule files.", (index) => renderDigest(index, { tokens: loadConfig().config.codebase.digestTokens, focus: undefined }));
codeResource("map", "File and symbol map", "Every indexed file with its declarations and line spans.", (index) => renderMap(index));
codeResource("graph", "Import graph", "Who imports what, who would break, and the third-party packages actually imported.", (index) => renderGraph(index));
codeResource("conventions", "How this project is built", "Package manager, scripts, test files, rule files and everything the index skipped.", (index) => renderConventions(index));
codeResource("focus", "The focus contract", "How to work in this repository: ground first, cite everything, obey the project's own rules, prove it by running its gates.", (index) => renderFocusContract(index));
server.registerResource("collective-memory", "code://memory", { title: "What the collective remembers", description: "Established claims, rejected claims and the owner's rulings — each re-checked against the current source, with the stale ones named.", mimeType: "text/markdown" }, async (uri) => {
    const loaded = await loadMemory(projectDir());
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderMemoryReport(loaded) }] };
});
server.registerResource("installed-skills", "code://skills", { title: "The skills installed for this project", description: "Every SKILL.md found under the configured roots, with its description and path — instructions to follow, never evidence about the code.", mimeType: "text/markdown" }, async (uri) => {
    const { config } = loadConfig();
    const scan = await discoverSkills(projectDir(), config.skills);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: renderSkillIndex(scan) }] };
});
/* ---- prompts: the workflows that tie the tools together ---- */
server.registerPrompt("hello_collective", {
    title: "Hello collective — wake the crew in this repo",
    description: "Invoke this when the owner says \"Hello collective.\" (or anything like it) in a project that has this server: it wakes the collective, grounds itself on this repo's digest, and answers as a crew standing in the room rather than as an assistant guessing from memory.",
    argsSchema: { focus: z.string().optional().describe("What the owner seems to want, if they said") },
}, ({ focus }) => ({
    description: "Waking the collective in this repository",
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    "Hello collective.",
                    focus ? `The owner's focus: ${focus}` : "",
                    "",
                    "1. Call `collective_hello` now, before anything else. It is one cheap pass, no model call, and it is the only thing that knows this repo.",
                    "2. Answer the owner from it: the repo by name and size, the state of the working tree, what the collective already established or already got wrong here, and the two or three most interesting things in the digest. Name the seats that are standing by, and say plainly that they are stances on one model rather than independent minds.",
                    "3. Say what you did NOT read. The digest is a map; nothing in this conversation is yet a verification of any file.",
                    "4. Then ask which thread to pull — one question, not a menu. If the owner already said what they want, start there instead: `code_context` for the area, then `collective_run` if the work splits into independent questions.",
                    "5. If the owner's skills matter for that thread, list them from `code://skills` and follow the one that fits with `skills_read`.",
                    "Do not describe this repository from memory. Everything you say about the code must come from the digest, a context pack, or a quote the server re-read.",
                ]
                    .filter(Boolean)
                    .join("\n"),
            },
        },
    ],
}));
server.registerPrompt("premium_pass", {
    title: "Premium design pass",
    description: "A structured pass that raises one target's design quality without adding effects for their own sake: diagnose, choose the one bold idea, keep everything else quiet, then verify against the floor.",
    argsSchema: {
        target: z.string().describe("What to review or improve, e.g. 'the home page of ./index.html'"),
        keep: z.string().optional().describe("The parts of the current design that must survive"),
    },
}, ({ target, keep }) => ({
    description: `Premium design pass on ${target}`,
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `Run a premium design pass on: ${target}`,
                    keep ? `\nMust survive unchanged (the owner's favourites): ${keep}` : "",
                    "",
                    "Work in this order, and gather evidence at every step rather than judging from code alone:",
                    "1. Look at it for real, at desktop and phone widths. Screenshot it.",
                    "2. Score it with the rubric below. Name the three to five biggest gaps, ranked.",
                    "3. Choose ONE idea to spend boldness on and keep everything else quiet. Say why that idea and not another.",
                    "4. Change it in small steps, re-checking after each one.",
                    "5. Verify: keyboard pass, reduced-motion pass, contrast, frame budget, empty and long-content states.",
                    "Report what changed, what you deliberately did not do, and what is unverified.",
                    "",
                    "=== CRITIQUE RUBRIC ===",
                    RUBRIC_SECTIONS.map((s) => `## ${s.title} (weight ${s.weight})\nLook for: ${s.lookFor.join(" ")}\nFlag: ${s.flag.join(" ")}\nVerify: ${s.verify}\nScores: ${s.anchors.join(" | ")}`).join("\n\n"),
                    "",
                    "=== CHOOSING THE ONE BOLD IDEA ===",
                    findTopic("rubric").entries.find((e) => e.id === "one-bold-idea")?.do.join("\n") ?? "",
                    "",
                    "=== ANTI-SLOP CHECKLIST (avoid these; they are what makes work read as generated) ===",
                    findTopic("slop").entries.find((e) => e.id === "defaults-inventory")?.do.join("\n") ?? "",
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("motion_review", {
    title: "Motion review",
    description: "Reviews the motion and interaction of a target against easing-by-role, choreography, interruptibility and the reduced-motion contract, and reports what the frame budget actually costs.",
    argsSchema: { target: z.string().describe("What to review, e.g. 'the hero animation in ./index.html'") },
}, ({ target }) => ({
    description: `Motion review of ${target}`,
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `Review the motion and interaction of: ${target}`,
                    "",
                    "For each animated thing, answer: what does it communicate, which easing role is it, how long should it take at that distance, who leads and who follows, can it be interrupted mid-flight, what does it do under prefers-reduced-motion, and what does it cost per frame?",
                    "Measure the frame cost rather than estimating it, and label anything you could not verify.",
                    "",
                    "=== MOTION PLAYBOOK ===",
                    renderTopic(findTopic("motion")),
                ].join("\n"),
            },
        },
    ],
}));
server.registerPrompt("collective_mission", {
    title: "Run a mission with the collective",
    description: "The full protocol for handing real work to a team of copies of the model: ground on the digest, split into independent units with one verifier, dispatch the workers in parallel, check every quote with the server before agreeing with it, then implement and prove it with the project's own gates.",
    argsSchema: {
        mission: z.string().describe("The work to plan or do, e.g. 'make the newsletter subscribe route reject unconfirmed addresses'"),
        focus: z.string().optional().describe("The part that matters most"),
    },
}, ({ mission, focus }) => ({
    description: `Collective mission: ${mission}`,
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: [
                    `Mission: ${mission}`,
                    focus ? `Focus: ${focus}` : "",
                    "",
                    "Run it as the collective. In this order, and do not skip step 2 or 5:",
                    "1. Ground. Read `code_digest` (or the resource code://digest). Do not plan from memory of this repo: the digest is computed from the files and your recollection is not.",
                    "2. Split, with one leader. `collective_plan` (or `collective_run` to have the server dispatch everything). The units must be independent, must own their own files, and must include a verifier whose only job is to falsify the rest.",
                    "3. Dispatch the workers in parallel. Each one gets its own `code_context` pack; no worker sees another's context.",
                    "4. Do not agree with a claim you cannot cite. Every worker claim goes through `code_verify_cites` before it becomes part of your conclusion. Rejected claims are deleted, not softened; a quote that is really there but does not visibly back its claim is labelled, and you read those lines yourself.",
                    "5. Implement the smallest correct change, inside the module that already owns the behaviour, obeying this project's own rule files. Check where each edit lands first with `code_verify_edits`: a path that does not exist and an anchor that is not in the file are the cheapest defects to catch and the most expensive to ship.",
                    "6. Prove it. Run the project's own gates (the digest lists its test, build and lint commands). Report separately: what you verified by running, what you verified only by reading, and what you did not check at all. An unverified change is unfinished, and saying so is part of the work.",
                    "",
                    "=== THE CITATION CONTRACT (this is what makes the collective trustworthy) ===",
                    "A fact about this code exists for the collective only as a quote with a path and a line range that the server can re-read. Anything else is a question or an unknown. When a worker's quote is not found, that claim is dropped before the leader sees it — so your final answer must never depend on one. `collective_run` then hands that finding back to its own worker exactly once, with the reason and the line the quote really lives at, and re-checks whatever comes back at the same standard; a claim the worker withdraws is recorded as withdrawn rather than quietly dropped. The dossier's verdict line is arithmetic over those checks, and it is the fastest honest answer to \"how much does this run actually know?\".",
                    "",
                    "=== ROLE CATALOGUE ===",
                    "explorer: what the code does today. architect: the shape of the change. implementer: exact edits with real anchors. verifier: the case where this breaks. critic: judge against this project's own standards, not your habits.",
                ]
                    .filter(Boolean)
                    .join("\n"),
            },
        },
    ],
}));
server.registerPrompt("focus_contract", {
    title: "How to work in this repository",
    description: "The ground rules for working in this codebase only, read out of the repo itself: its commands, its rule files, its entry points and what can break. Attach this before any coding session in this project.",
    argsSchema: { task: z.string().optional().describe("What you are about to work on, so the contract is concrete") },
}, async ({ task }) => {
    const { config } = loadConfig();
    const { index } = await getIndex(projectDir(), config.codebase, {});
    return {
        description: `Focus contract for ${index.name}`,
        messages: [{ role: "user", content: { type: "text", text: renderFocusContract(index, task) } }],
    };
});
// Resource safety, at boot: when local mode is on (runtime state or config), check Ollama once here so
// the owner hears about an unreachable daemon or a missing model before a mission quietly falls back.
// It never blocks the MCP surface from coming up, and it speaks only through stderr — the one channel
// index.ts may use. With the mode off this whole block costs nothing and touches nothing.
try {
    const root = projectDir();
    const { config: bootConfig } = loadConfig();
    const eff = effectiveLocal(root, bootConfig.local);
    if (eff.on) {
        const h = await health(settingsFor(bootConfig.local));
        const note = h.ok
            ? h.modelMissing
                ? `Ollama is up but the model "${eff.model}" is not pulled (available: ${h.models.join(", ") || "none"}). Local units will refuse until: ollama pull ${eff.model}`
                : `Ollama is up and the model "${eff.model}" is present — local delegation is armed.`
            : `Ollama at ${bootConfig.local.host} is unreachable at startup (${h.detail ?? "no detail"}); local units will fall back to the council until it answers.`;
        console.error(`local mode: ${note}`);
        recordHealth(root, note);
    }
}
catch {
    // A boot health check that cannot run is a warning, never a reason the server fails to start.
}
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("design-mcp running on stdio");
