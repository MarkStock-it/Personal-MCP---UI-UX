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
import { prepareSequence } from "./builder/sequences.js";
import { getJob, startJob } from "./jobs.js";
import { pLimit } from "./util/limit.js";
import { findVariations, loadReport, renderReport, testVariation } from "./test/run.js";
import { generateImage, generateText } from "./providers/index.js";
import { usageSummary } from "./usage.js";
import { findEntry, findTopic, renderEntry, renderTopic, resourceUri, searchPlaybook, TOPIC_IDS, TOPICS, topicIndex } from "./playbook/index.js";
import { renderPalette, paletteCheck, renderSlopFindings, scanSlop } from "./playbook/check.js";
import { RUBRIC_SECTIONS } from "./playbook/rubric.js";
// NOTE: stdio servers must never write to stdout (it carries the protocol). Log with console.error only.
const server = new McpServer({ name: "design-mcp", version: "0.7.0" });
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
/* ---- prompts: the workflows that tie the tools together ---- */
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
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("design-mcp running on stdio");
