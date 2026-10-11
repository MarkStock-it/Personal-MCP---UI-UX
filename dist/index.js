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
import { listPending, renderPending, storeAnswer } from "./providers/manual.js";
import { setSamplingServer } from "./sampling.js";
import { buildVariation } from "./builder/build.js";
import { decideStack, detectStack } from "./builder/scaffold.js";
import { getJob, startJob } from "./jobs.js";
import { pLimit } from "./util/limit.js";
import { findVariations, loadReport, renderReport, testVariation } from "./test/run.js";
import { generateImage, generateText } from "./providers/index.js";
import { usageSummary } from "./usage.js";
// NOTE: stdio servers must never write to stdout (it carries the protocol). Log with console.error only.
const server = new McpServer({ name: "design-mcp", version: "0.6.0" });
setSamplingServer(server);
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
        const keys = ["anthropic", "openai", "google"].map((p) => `${keyEnvName(p)}: ${process.env[keyEnvName(p)] ? "set" : "MISSING"}`);
        const roles = Object.entries(config.roles).map(([r, v]) => `${r.padEnd(8)} -> ${v.provider} / ${v.model}${providerNeedsKey(v.provider) ? "" : " (no key needed)"}`);
        return ok([
            `Project dir: ${projectDir()}`,
            `Config: ${source}`,
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
server.registerTool("providers_test", {
    title: "Test a provider role",
    description: "Makes one tiny real API call for a role to confirm its key and model work. Text roles send a one-word prompt. The image role generates one small test image and saves it under .design-mcp/ in the project.",
    inputSchema: { role: z.enum(["concept", "builder", "critic", "image"]) },
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
        return ok([
            `Job ${job.id} (${job.kind}): ${job.status.toUpperCase()}`,
            `Started ${job.startedAt}${job.finishedAt ? `, finished ${job.finishedAt}` : ""}`,
            "",
            "Recent log:",
            ...job.log.slice(-25),
            job.result ? `\nRESULT:\n${job.result}` : "",
            job.status === "running" ? "\nStill running. Check again in a minute or two." : "",
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
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("design-mcp running on stdio");
