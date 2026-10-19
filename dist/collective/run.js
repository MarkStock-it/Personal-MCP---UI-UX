/**
 * The mission loop.
 *
 *   leader   reads the digest (never the files) and cuts the mission into independent units
 *   workers  run in parallel, each on its own packed slice of real source, and may only claim what it quotes
 *   server   re-reads every quote and deletes what does not survive
 *   leader   closes the mission using the checked evidence only, and names what stays unverified
 *
 * One process, no shared memory between the copies, and the only facts that travel are ones the server
 * confirmed exist in the repository. The dossier is the artefact: short, cited, and explicit about the
 * difference between checked and assumed, which is what keeps the next reader honest.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { packContext, renderPack } from "../codebase/pack.js";
import { estimateTokens, getIndex, renderDigest } from "../codebase/store.js";
import { pLimit } from "../util/limit.js";
import { askJson } from "./ask.js";
import { LeaderPlanSchema, SynthesisSchema, WorkerReportSchema, leaderSystem, leaderUser, synthesisSystem, workerSystem, workerUser, } from "./roles.js";
import { admitFromMission, loadMemory, renderMemoryBlock } from "./memory.js";
import { loadOwner, recordMission, renderOwnerStats } from "./owner.js";
import { renderConversation, runPeerRound } from "./peer.js";
import { handleFor } from "./personas.js";
import { discoverSkills, findSkill, readSkill } from "../skills/index.js";
import { LOCAL_ROUTING } from "./roles.js";
import { delegateUnit } from "../ollama/delegate.js";
import { bumpCounters, effectiveLocal } from "../ollama/state.js";
import { settingsFor } from "../ollama/client.js";
import { repairableRejections, runRepairRound } from "./repair.js";
import { mergeEditChecks, proposedEdits, renderEditCheck, verifyEdits } from "./edits.js";
import { renderEditRepair, repairableEdits, runEditRepairRound } from "./editrepair.js";
import { checkConclusion, renderConclusionCheck, renderConclusionRepair } from "./conclusion.js";
import { runConclusionRepairRound } from "./conclusionrepair.js";
import { missionVerdict } from "./verdict.js";
import { mergeVerification, verifyReports } from "./verify.js";
export const missionsDir = (root) => path.join(root, ".design-mcp", "collective");
export async function runMission(projectRoot, cfg, input, log) {
    const t0 = Date.now();
    const warnings = [];
    const id = `m-${Date.now().toString(36)}`;
    const loaded = await getIndex(projectRoot, cfg.codebase, {});
    const index = loaded.index;
    log(`${index.name}: ${index.totals.files} files indexed${loaded.cached ? " (cache verified, unchanged)" : ` in ${index.buildMs} ms`}`);
    const digest = renderDigest(index, { tokens: cfg.codebase.digestTokens, focus: input.focus ?? input.mission });
    const digestTokens = estimateTokens(digest);
    log(`digest: ~${digestTokens} tokens (budget ${cfg.codebase.digestTokens}) — this is all the leader sees of the repo`);
    const memory = cfg.collective.memory ? await loadMemory(projectRoot) : { items: [], stale: [], live: [] };
    const memoryBlock = cfg.collective.memory ? renderMemoryBlock(memory, { tokens: cfg.collective.memoryTokensInPrompt }) : "";
    if (memory.live.length || memory.stale.length) {
        log(`memory: ${memory.live.length} live entr${memory.live.length === 1 ? "y" : "ies"} in front of the collective${memory.stale.length ? `, ${memory.stale.length} retired as stale` : ""}`);
    }
    // History of past missions here: counts and hot files, never evidence. One small JSON read, and the
    // leader gets it as a labelled block so it knows where this repo's work keeps landing.
    const owner = await loadOwner(projectRoot);
    const ownerBlock = renderOwnerStats(owner);
    if (owner.missions)
        log(`owner: ${owner.missions} earlier mission(s) here, hot files in front of the leader`);
    // The owner's skills. Only their names and one-line intents go to the leader; the text itself is read
    // later, and only for the units that were actually assigned one, so an unused skill costs nothing.
    const scan = cfg.skills.enabled ? await discoverSkills(projectRoot, cfg.skills) : { skills: [], roots: [], notes: [] };
    const offered = input.skills?.length
        ? scan.skills.filter((s) => input.skills.some((n) => s.name.toLowerCase() === n.toLowerCase()))
        : scan.skills;
    if (input.skills?.length) {
        const missing = input.skills.filter((n) => !offered.some((s) => s.name.toLowerCase() === n.toLowerCase()));
        if (missing.length)
            warnings.push(`skill(s) asked for but not found under the configured roots: ${missing.join(", ")}`);
    }
    const skillIndex = offered.length
        ? offered.slice(0, 40).map((s) => `- ${s.name} — ${s.description.replace(/\s+/g, " ").slice(0, 180)}`).join("\n")
        : "";
    if (offered.length)
        log(`skills: ${offered.length} of the owner's skills offered to the leader${scan.skills.length - offered.length ? ` (${scan.skills.length - offered.length} not shortlisted)` : ""}`);
    warnings.push(...scan.notes);
    const maxUnits = Math.min(cfg.collective.maxUnits, input.units ?? cfg.collective.maxUnits);
    // Local mode, resolved once per mission: the runtime flip (local_mode) beats the config default.
    const localEff = effectiveLocal(projectRoot, cfg.local);
    const localSettings = settingsFor(cfg.local);
    const localDetails = [];
    if (localEff.on)
        log(`local mode is ON (${localEff.source === "runtime" ? "runtime flip" : "config default"}, model ${localEff.model}) — well-scoped implementer units may be delegated`);
    const planAsk = await askJson({
        role: "leader",
        system: leaderSystem(maxUnits, skillIndex || undefined, localEff.on ? LOCAL_ROUTING : undefined),
        user: leaderUser({ mission: input.mission, digest, focus: input.focus, paths: input.paths, maxUnits, memory: memoryBlock, owner: ownerBlock }),
        schema: LeaderPlanSchema,
        maxTokens: 2200,
        attempts: 2,
    });
    const plan = planAsk.value;
    log(`leader planned ${plan.units.length} unit(s) in ${planAsk.ms} ms: ${plan.units.map((u) => `${u.id}(${u.role})`).join(", ")}`);
    warnings.push(...planAsk.warnings.map((w) => `leader: ${w}`));
    const known = new Map(index.files.map((f) => [f.path, f]));
    // Every name the index knows: one import the local model uses that is not in here is a mechanical reject.
    const knownNames = new Set(index.files.flatMap((f) => f.symbols.map((s) => s.name)));
    const units = dedupeUnits(plan.units.slice(0, maxUnits).map((u) => {
        // The leader naming a file that does not exist is the cheapest hallucination to catch, so catch it here.
        const missing = u.scope.filter((p) => !known.has(p.replace(/^\.\//, "")));
        if (missing.length)
            warnings.push(`unit ${u.id} scoped files that do not exist and the scope was trimmed: ${missing.join(", ")}`);
        return { ...u, scope: u.scope.map((p) => p.replace(/^\.\//, "")).filter((p) => known.has(p)) };
    }));
    if (!units.some((u) => u.role === "verifier"))
        warnings.push("the leader did not include a verifier unit, so nothing is trying to falsify the plan");
    // Resolve the assigned skills before anything is dispatched: a skill whose file cannot be read is a
    // defect in the plan, and it is cheaper to say so here than to let a worker run under a false premise.
    const assigned = new Map();
    for (const u of units) {
        if (!u.skill)
            continue;
        const found = findSkill(offered, u.skill);
        if (!found) {
            warnings.push(`unit ${u.id} was assigned skill "${u.skill}", which is not under the configured roots, so the unit ran without it`);
            continue;
        }
        try {
            const text = await readSkill(found, cfg.skills.maxInPromptKB);
            assigned.set(u.id, { name: found.name, path: found.path, text, bytes: text.length });
            log(`  ${u.id}: following the owner's skill "${found.name}" (${Math.round(text.length / 1024)} KB read into its prompt)`);
        }
        catch (e) {
            warnings.push(`unit ${u.id} could not read the skill "${u.skill}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const workerCount = Math.min(cfg.collective.maxWorkers, input.workers ?? cfg.collective.maxWorkers, Math.max(1, units.length));
    const limit = pLimit(workerCount);
    let contextTokens = 0;
    const reports = [];
    const failed = [];
    log(`dispatching ${units.length} worker(s), ${workerCount} at a time, each on its own slice of source`);
    await Promise.all(units.map((unit) => limit(async () => {
        const query = [unit.objective, ...unit.mustAnswer].join(" ");
        const pack = await packContext(projectRoot, index, {
            query,
            paths: unit.scope,
            budget: cfg.collective.contextTokensPerWorker,
            symbols: [],
        });
        contextTokens += pack.tokens;
        log(`  ${unit.id}: ${pack.slices.length} file(s), ~${pack.tokens} tokens packed in ${pack.ms} ms`);
        if (unit.local && unit.role !== "implementer") {
            warnings.push(`unit ${unit.id} was offered to the local model, but only implementer units are eligible — it runs on the council instead`);
        }
        // Local delegation. The mode is checked right here, not once at the start of the mission, so a flip
        // during a run takes effect for every unit that has not started yet. Only applied outcomes end the
        // unit; everything else falls through to the normal council path below, carrying the reason.
        if (localEff.on && unit.local && unit.role === "implementer") {
            const detail = await delegateUnit(unit, input.mission, index, knownNames, cfg.local, localSettings, log);
            localDetails.push({ unit: unit.id, detail });
            if (detail.outcome === "applied" || detail.outcome === "applied-with-retry") {
                reports.push({
                    unit: unit.id,
                    answer: `This unit was DELEGATED TO THE LOCAL MODEL and its output is applied. The audit ladder ran in order: deterministic checks, then the import/API existence check, then the council spec review. ${detail.reason}`,
                    findings: [],
                    steps: [],
                    unknowns: [],
                    openQuestions: [],
                    verdict: "ok",
                });
                return;
            }
            // Everything else — UNKNOWN, audit failure after the one retry, timeout, mode switched off
            // mid-flight — goes back to the council as a normal worker call, carrying the audit's reason.
            warnings.push(`unit ${unit.id}: local delegation ${detail.outcome} — the council takes it over (${detail.reason.slice(0, 200)})`);
        }
        const takeoverNote = localDetails.find((l) => l.unit === unit.id && l.detail.outcome !== "applied" && l.detail.outcome !== "applied-with-retry")
            ? `THE LOCAL MODEL TRIED THIS UNIT FIRST AND DID NOT PASS (${localDetails.find((l) => l.unit === unit.id).detail.reason.slice(0, 400)}). You are the council doing this unit properly from real source. Do not copy any of its code; the audit already deleted it.`
            : undefined;
        try {
            const asked = await askJson({
                role: "worker",
                system: workerSystem(unit.role, assigned.get(unit.id)),
                user: workerUser(unit, renderPack(pack), memoryBlock, takeoverNote),
                schema: WorkerReportSchema,
                maxTokens: 2600,
                attempts: 2,
            });
            const report = { ...asked.value, unit: unit.id };
            reports.push(report);
            if (report.verdict === "blocked")
                warnings.push(`unit ${unit.id} reported itself blocked`);
            warnings.push(...asked.warnings.map((w) => `unit ${unit.id}: ${w}`));
            if (!pack.slices.length)
                warnings.push(`unit ${unit.id} got an empty context pack: its answer can only be "unknown"`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            failed.push({ unit: unit.id, error: message });
            log(`  ${unit.id}: FAILED (${message.split("\n").slice(0, 2).join(" ")})`);
            warnings.push(`unit ${unit.id} produced nothing usable: ${message.split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
        }
    })));
    // One file cache for the whole mission: the citation gate and the edit gate read the same snapshots, so
    // what the edits are checked against is exactly what the quotes were checked against.
    const fileCache = new Map();
    let verification = await verifyReports({ projectRoot, units, reports, cache: fileCache });
    // Kept: the repair pass adds to `verification`, and the verdict needs to see what the first pass alone
    // rejected, so it can tell a citation that was fixed from one that is still wrong.
    const roundOne = verification;
    log(`verification: ${verification.counts.verified} verified, ${verification.rejected.length} rejected of ${verification.claims.length} claims (${verification.ms} ms, no model involved)`);
    if (verification.thin.length)
        log(`  ${verification.thin.length} verified quote(s) share no wording with the claim they are attached to — flagged, not deleted`);
    if (verification.conflicts.length)
        for (const c of verification.conflicts)
            log(`  conflict: ${c}`);
    // One repair pass, and only for the citations a worker can actually fix. The rejected findings go back
    // with the server's own reason (including where the quote really is, when it is real), the reply is
    // re-gated at the same standard, and nothing that already verified is re-sent — a correction round that
    // is allowed to edit good findings can break them.
    let repair;
    const fixable = repairableRejections(verification).length;
    if (cfg.collective.repairRound && fixable) {
        const unitsWithRejections = new Set(repairableRejections(verification).map((c) => c.unit)).size;
        log(`repair pass: ${fixable} rejected finding(s) in ${unitsWithRejections} unit(s) go back once, with the reason the gate gave`);
        repair = await runRepairRound({ projectRoot, index, units, verification, cfg: cfg.collective, memoryBlock, assigned, concurrency: workerCount, log });
        if (repair.repaired)
            log(`  repaired: ${repair.repaired} finding(s) re-cited correctly, ${repair.stillRejected} still not verifiable`);
        else
            log(`  nothing was repaired: all ${repair.stillRejected || fixable} rejected finding(s) stand as rejected`);
        if (repair.verification.claims.length)
            verification = mergeVerification(verification, repair.verification);
    }
    else if (cfg.collective.repairRound) {
        log("repair pass: nothing to repair — every citation that was checked is either verified or outside what a worker can re-cite");
    }
    // Round two: the copies finally read each other. Only verified findings are exchanged, their replies go
    // through the same gate, and an unevidenced rebuttal is recorded as exactly that rather than as doubt.
    let conversation;
    if (cfg.collective.peerRound && reports.length >= 2) {
        log(`round two: ${reports.length} worker(s) read each other (verified findings only)`);
        conversation = await runPeerRound({ projectRoot, units, reports, verification, memoryBlock, concurrency: workerCount, log });
        if (conversation.unevidenced)
            log(`  ${conversation.unevidenced} rebuttal(s) came with no quote and stand as unproven`);
    }
    else if (cfg.collective.peerRound) {
        warnings.push("round two was skipped: it needs at least two workers to have reported");
    }
    let synthesis;
    let closingRan = false;
    if (cfg.collective.synthesize && reports.length) {
        const evidence = renderEvidence(units, reports, verification);
        const conversationText = conversation ? `\n\n=== THE CONVERSATION (round two) ===\n${renderConversation(conversation, units).join("\n")}` : "";
        try {
            const asked = await askJson({
                role: "leader",
                system: synthesisSystem(),
                user: `MISSION: ${input.mission}\n\nThe workers' checked evidence, and what was rejected:\n\n${evidence}${conversationText}`,
                schema: SynthesisSchema,
                maxTokens: 2200,
                attempts: 2,
            });
            synthesis = asked.value;
            closingRan = true;
            warnings.push(...asked.warnings.map((w) => `synthesis: ${w}`));
            log(`leader closed the mission in ${asked.ms} ms`);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            warnings.push(`the closing pass failed: ${message.split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
            synthesis = fallbackSynthesis(plan, verification);
        }
    }
    else {
        synthesis = fallbackSynthesis(plan, verification);
    }
    // Then the summary itself, against the mission's own record. Every other output is gated: quotes are
    // re-read from the file, proposed edits are placed against it, and both get one repair. The paragraph the
    // owner actually reads was never checked, and it is the one place a deleted finding can come back as a
    // confident sentence. The checks are deterministic (does a sentence restate a rejected or withdrawn
    // finding, state a THIN SUPPORT quote as established, or name a file that is not in this repository), and
    // the repair is the same one pass the other two get: numbered sentences, the record's own words, and the
    // rewritten paragraph re-checked at the same standard.
    const conclusionIssues = await checkConclusion({ synthesis, verification, repair, index, root: projectRoot });
    let conclusionRepair;
    if (conclusionIssues.length) {
        for (const i of conclusionIssues)
            log(`  conclusion: [${i.kind}] ${i.field} — ${i.text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (cfg.collective.conclusionRepair && conclusionIssues.length) {
        log(`conclusion: ${conclusionIssues.length} sentence(s) of the closing paragraph contradict the mission's own record and go back once`);
        conclusionRepair = await runConclusionRepairRound({ projectRoot, index, mission: input.mission, synthesis, issues: conclusionIssues, verification, memoryBlock, log });
        if (conclusionRepair.attempt.error)
            warnings.push(`conclusion repair produced nothing usable: ${conclusionRepair.attempt.error.split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
        synthesis = conclusionRepair.synthesis;
        if (conclusionRepair.rewritten || conclusionRepair.withdrawn)
            log(`  settled: ${conclusionRepair.rewritten} rewritten, ${conclusionRepair.withdrawn} given up, ${conclusionRepair.remaining.length} still contradicting the record`);
    }
    else if (cfg.collective.conclusionRepair) {
        log("conclusion repair: nothing to repair — no sentence of the closing paragraph contradicts the record this run produced");
    }
    // Then the work itself, with the same suspicion the claims got. A finding whose quote was missing was
    // deleted; an edit whose file or anchor is missing was travelling straight into the owner's editor. The
    // checks are the ones no model can argue with: does the path exist, is the anchor really in that file at
    // the lines it cites, and what do the index's own edges say a change there can break.
    const proposed = proposedEdits({ units, reports, synthesis });
    let edits = await verifyEdits({ projectRoot, index, edits: proposed.edits, cache: fileCache });
    if (proposed.edits.length) {
        log(`edits: ${proposed.edits.length} proposed — ${edits.counts.anchored} anchored, ${edits.broken} that cannot be applied as described, ${edits.staleLines} with stale line numbers, ${edits.unanchored} anchored to nothing (${edits.ms} ms, no model)`);
        for (const e of edits.edits.filter((x) => ["no-such-file", "outside-project", "anchor-not-found", "lines-out-of-range"].includes(x.status))) {
            log(`  ${e.source}: ${e.path || "(no path)"} — ${e.status}${e.detail ? ` (${e.detail.slice(0, 120)})` : ""}`);
        }
    }
    else if (proposed.pathless.length) {
        log("edits: no proposed change named a file, so there was nothing to check");
    }
    if (proposed.pathless.length) {
        warnings.push(`edit gate: ${proposed.pathless.length} proposed step(s) name no file, so where they land could not be checked at all`);
    }
    // One repair pass for the steps that could not be placed, and only for the ones a source can act on. The
    // gate's own reason goes back with each step (the anchor is not there, it is really at line N, it occurs
    // three times, the range is past the end), the source either re-places it or withdraws it with a reason,
    // and what comes back is re-gated at the same standard. Nothing already placed is ever re-sent.
    let editRepair;
    const unplaceable = repairableEdits(edits);
    if (cfg.collective.editRepair && unplaceable.length) {
        const sources = new Set(unplaceable.map((e) => e.source)).size;
        log(`edit repair: ${unplaceable.length} step(s) in ${sources} source(s) could not be placed and go back once, with the server's reason`);
        editRepair = await runEditRepairRound({ projectRoot, index, units, edits, cfg: cfg.collective, memoryBlock, assigned, concurrency: workerCount, log, cache: fileCache });
        for (const a of editRepair.attempts)
            if (a.error)
                warnings.push(`edit repair for ${a.source} produced nothing usable: ${a.error.split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
        if (editRepair.fixed || editRepair.withdrawn)
            log(`  settled: ${editRepair.fixed} re-placed, ${editRepair.withdrawn} withdrawn, ${editRepair.stillBroken} still not placeable`);
        if (editRepair.check.edits.length)
            edits = mergeEditChecks(edits, editRepair.check, editRepair.settled);
    }
    else if (cfg.collective.editRepair && proposed.edits.length) {
        log("edit repair: nothing to repair — every step that was checked landed where it said it would");
    }
    // The verdict is arithmetic over the gate's results, not a reading of the closing paragraph — it is
    // computed here only because `closingRan` is not known until the pass has been attempted.
    const finalVerdict = missionVerdict({
        units,
        reports,
        failed,
        roundOne,
        repair,
        merged: verification,
        edits,
        editRepair,
        closingRan,
        conclusionFound: conclusionIssues.length,
        conclusionRepair: conclusionRepair ? { calls: conclusionRepair.calls, rewritten: conclusionRepair.rewritten, withdrawn: conclusionRepair.withdrawn, stillBroken: conclusionRepair.attempt.stillBroken } : undefined,
        conclusionStillStanding: (conclusionRepair ? conclusionRepair.remaining : conclusionIssues).length,
    });
    log(`verdict: ${finalVerdict.headline}`);
    // Memory is admitted on the way out, and quality-gated on purpose: a claim needs a quote the server
    // re-read and a mission that actually closed. Adding everything is a measured way to make the next
    // mission worse, so the rejected claims are kept too — as things not to say again.
    let admitted = [];
    let reinforced = 0;
    if (cfg.collective.memory) {
        const recorded = await admitFromMission({
            root: projectRoot,
            mission: input.mission,
            verification,
            closingRan,
            conflictPaths: verification.conflicts.map((c) => c.split(" ")[0]),
            // A claim the repair pass re-cited correctly was never a false belief about the code, so it is not
            // filed as one of the things not to say again.
            settled: (repair?.verification.claims ?? []).filter((c) => c.status === "verified").map((c) => `${c.unit}|${c.claim}`),
            cap: cfg.collective.memoryItems,
            perMission: 6,
        });
        admitted = recorded.added;
        reinforced = recorded.reinforced;
        if (recorded.added.length)
            log(`memory: recorded ${recorded.added.length} entr${recorded.added.length === 1 ? "y" : "ies"} for future missions`);
        else if (recorded.reinforced)
            log(`memory: nothing new, but ${recorded.reinforced} earlier entr${recorded.reinforced === 1 ? "y" : "ies"} confirmed again`);
        warnings.push(...recorded.skipped);
    }
    const stats = {
        workers: units.length,
        calls: reports.length + failed.length + 1 + (closingRan ? 1 : 0) + (conversation?.responses.length ?? 0) + (repair?.calls ?? 0),
        verified: verification.counts.verified,
        rejected: verification.rejected.length,
        repaired: repair?.repaired ?? 0,
        withdrawn: (repair?.attempts ?? []).reduce((n, a) => n + a.withdrawn.length, 0),
        thin: verification.thin.length,
        repairCalls: repair?.calls ?? 0,
        contextTokens,
        digestTokens,
        cached: loaded.cached,
        closingRan,
        peerCalls: conversation?.responses.length ?? 0,
        grade: finalVerdict.grade,
        editsChecked: edits.edits.length,
        editsBroken: edits.broken,
        editsStale: edits.staleLines,
        editsPathless: proposed.pathless.length,
        editRepairCalls: editRepair?.calls ?? 0,
        editsFixed: editRepair?.fixed ?? 0,
        editsWithdrawn: editRepair?.withdrawn ?? 0,
        conclusionFound: conclusionIssues.length,
        conclusionRepairCalls: conclusionRepair?.calls ?? 0,
        conclusionsRewritten: conclusionRepair?.rewritten ?? 0,
        conclusionsWithdrawn: conclusionRepair?.withdrawn ?? 0,
        conclusionsStanding: (conclusionRepair ? conclusionRepair.remaining : conclusionIssues).length,
        localDelegated: localDetails.length,
        localApplied: localDetails.filter((l) => l.detail.outcome === "applied" || l.detail.outcome === "applied-with-retry").length,
        localFallback: localDetails.filter((l) => l.detail.outcome !== "applied" && l.detail.outcome !== "applied-with-retry").length,
        ms: Date.now() - t0,
    };
    // The owner's counters, once per mission. These are the numbers the status reads; nothing here is
    // allowed to diffuse them (an audit rejection is an audit rejection).
    bumpCounters(projectRoot, {
        delegated: stats.localDelegated,
        applied: stats.localApplied,
        auditFailed: localDetails.filter((l) => l.detail.outcome === "rejected-and-taken-over").length,
        fallback: stats.localFallback,
    });
    const memoryState = { added: admitted, reinforced, stale: memory.stale, live: memory.live.length };
    const skillsUsed = units.flatMap((u) => {
        const a = assigned.get(u.id);
        return a ? [{ name: a.name, unit: u.id, path: a.path, bytes: a.bytes }] : [];
    });
    // The owner record is learned on the way out, from this mission's own numbers: no model call, and a
    // failure to persist it is a warning rather than a lost mission (read-only projects are real).
    try {
        await recordMission(projectRoot, {
            id,
            mission: input.mission,
            grade: finalVerdict.grade,
            units: units.length,
            verified: verification.counts.verified,
            rejected: verification.rejected.length,
            files: [
                ...verification.claims.filter((c) => c.status === "verified").map((c) => c.path),
                ...edits.edits.map((e) => e.path),
            ],
            skills: skillsUsed.map((s) => s.name),
        });
    }
    catch (e) {
        warnings.push(`the owner record could not be written (${e instanceof Error ? e.message : String(e)})`);
    }
    const dossier = renderDossier({ id, input, index, plan, units, reports, failed, verification, synthesis, conversation, repair, edits, editRepair, conclusion: conclusionIssues, conclusionRepair, verdict: finalVerdict, memory: memoryState, skills: skillsUsed, local: localDetails, offered: offered.map((s) => s.name), stats, warnings });
    const dir = missionsDir(projectRoot);
    const file = path.join(dir, `${id}.md`);
    try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, dossier);
        await prune(dir, cfg.collective.keepDossiers);
    }
    catch {
        warnings.push("the dossier could not be written to .design-mcp/collective/ (read-only project?)");
    }
    return { id, file, dossier, plan, verification, synthesis, conversation, repair, edits, editRepair, conclusion: { issues: conclusionIssues, repair: conclusionRepair }, verdict: finalVerdict, memory: memoryState, skills: skillsUsed, local: localDetails, stats, warnings };
}
/** Unit ids must be unique and stable: the reports are matched back to the plan by id. */
function dedupeUnits(units) {
    const seen = new Map();
    return units.map((u) => {
        const n = seen.get(u.id) ?? 0;
        seen.set(u.id, n + 1);
        return n === 0 ? u : { ...u, id: `${u.id}-${n + 1}` };
    });
}
function renderEvidence(units, reports, v) {
    const blocks = [];
    for (const r of reports) {
        const unit = units.find((u) => u.id === r.unit);
        const mine = v.claims.filter((c) => c.unit === r.unit && c.status === "verified");
        blocks.push([
            `### unit ${r.unit} (${unit?.role ?? "?"}) — verdict ${r.verdict}`,
            `objective: ${unit?.objective ?? "(unknown)"}`,
            `mustAnswer: ${(unit?.mustAnswer ?? []).join(" | ")}`,
            `answer: ${r.answer}`,
            r.steps.length ? `proposed steps: ${r.steps.map((s) => `${s.path} (${s.risk}): ${s.intent}`).join("; ")}` : "",
            "verified findings (quote checked against the file by the server):",
            ...mine.map((c) => `  - ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""} — ${c.claim}${c.repaired ? " [repaired: this failed the gate once and was re-cited]" : ""}${c.support === "thin" ? " [THIN SUPPORT: the quote is real but shares no wording with this claim, so the line does not visibly back it — do not state it as established; carry it into unverified or check the line]" : ""}\n      quote: ${c.quote.replace(/\s+/g, " ").slice(0, 300)}`),
            r.unknowns.length ? `unknowns: ${r.unknowns.join(" | ")}` : "",
            r.openQuestions.length ? `open questions: ${r.openQuestions.join(" | ")}` : "",
        ]
            .filter(Boolean)
            .join("\n"));
    }
    const rejected = v.rejected.length
        ? ["### rejected findings (these quotes were NOT found where they were cited — never re-introduce them as facts)", ...v.rejected.map((c) => `  - [${c.status}] ${c.unit} ${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 160)}${c.detail ? ` (${c.detail})` : ""}`)].join("\n")
        : "";
    const conflicts = v.conflicts.length ? ["### conflicts between units", ...v.conflicts.map((c) => `  - ${c}`)].join("\n") : "";
    return [...blocks, rejected, conflicts].filter(Boolean).join("\n\n");
}
/** When the closing pass fails or is switched off, the verified findings still reach the reader in order. */
function fallbackSynthesis(plan, v) {
    return {
        answer: [
            "No synthesis pass was run. The verified findings below are the collective's output.",
            ...v.units.map((u) => `- ${u.unit} (${u.role}, ${u.verified}/${u.total} verified): ${u.answer.replace(/\s+/g, " ").slice(0, 400)}`),
        ].join("\n"),
        plan: [],
        risks: plan.risks,
        unverified: v.rejected.map((c) => `${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 140)} (${c.status})`),
        firstAction: "Read the verified findings below and decide the first edit yourself.",
        definitionOfDone: ["The project's own gates pass (see the digest for its test and build commands)."],
    };
}
export function renderDossier(d) {
    const { index: idx, synthesis: s, plan, verification: v, stats } = d;
    const t = idx.conventions;
    return [
        `# Collective mission ${d.id}`,
        `${d.input.mission}`,
        "",
        `repo: ${idx.name} (${idx.totals.files} files, ${idx.totals.lines} lines) · ${d.units.length} unit(s) · ${stats.calls} model call(s) · ${stats.ms} ms`,
        `verified ${stats.verified}, rejected ${stats.rejected}${stats.repaired ? `, repaired ${stats.repaired}` : ""} · leader saw a ~${stats.digestTokens}-token digest, workers ~${stats.contextTokens} tokens of real source`,
        "",
        ...d.verdict.lines,
        "",
        "## Restated in this repository's own terms",
        plan.restated,
        "",
        "## What the collective concluded",
        s.answer,
        "",
        `## First action\n${s.firstAction}`,
        ...(s.plan.length ? ["", "## Plan", ...s.plan.map((p, i) => `${i + 1}. ${p.step}${p.path ? ` — ${p.path}` : ""} (${p.risk} risk): ${p.intent}${planEditNote(d.edits, i)}`)] : []),
        ...(s.definitionOfDone.length ? ["", "## Definition of done", ...s.definitionOfDone.map((x) => `- ${x}`)] : []),
        ...(d.local.length
            ? [
                "",
                "## Local delegation (Ollama)",
                ...d.local.map((l) => {
                    const files = l.detail.files.length ? ` files: ${l.detail.files.map((f) => `${f.path} (${f.status}, ${f.bytes} B)`).join(", ")}` : " (no files)";
                    return `- ${l.unit}: ${l.detail.outcome}${files} — ${l.detail.reason.replace(/\s+/g, " ").slice(0, 300)}`;
                }),
                ...d.local.flatMap((l) => l.detail.audit.map((a) => `    - ${l.unit} audit: ${a.replace(/\s+/g, " ").slice(0, 300)}`)),
                ...d.local.flatMap((l) => l.detail.outputs.filter(Boolean).map((o, i) => `    - ${l.unit} attempt ${i + 1} (the raw local output is kept here, and it is not built on): ${o.replace(/\s+/g, " ").slice(0, 500)}`)),
                "- Local output is untrusted by default: nothing merged without the audit ladder passing (deterministic checks, then import/API existence, then the council spec review), and every failure was reverted byte-for-byte from the snapshot taken before the write.",
            ]
            : []),
        ...(stats.localDelegated
            ? [
                "",
                `## Local delegation cost\n- Local delegation: ${stats.localDelegated} unit(s) offered to the local model — ${stats.localApplied} applied after audit, ${stats.localFallback} did not pass and went back to the council.`,
            ]
            : []),
        ...renderConclusionCheck(d.conclusion),
        ...(d.conclusionRepair ? renderConclusionRepair({ ...d.conclusionRepair.attempt, calls: d.conclusionRepair.calls }) : []),
        "",
        renderEditCheck(d.edits, { heading: true }),
        ...(d.editRepair ? ["", ...renderEditRepair(d.editRepair)] : []),
        "",
        "## Evidence (every quote below was re-read from the file by the server)",
        ...v.units.map((u) => [
            `### ${handleFor(u.role)} (${u.unit}) — ${u.role}, ${u.verified}/${u.total} claims verified, verdict ${u.verdict}${d.skills.find((s) => s.unit === u.unit) ? `, followed the skill "${d.skills.find((s) => s.unit === u.unit).name}"` : ""}`,
            u.answer,
            ...v.claims
                .filter((c) => c.unit === u.unit && c.status === "verified")
                .map((c) => `- ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : c.foundAt ? `:~${c.foundAt}` : ""}: ${c.claim}${c.repaired ? " (repaired and re-verified)" : ""}${c.support === "thin" ? " — THIN SUPPORT: the quote shares no wording with the claim" : ""}\n    \`${c.quote.replace(/\s+/g, " ").slice(0, 240)}\``),
        ].join("\n")),
        ...(v.rejected.length ? ["", "## Rejected: cited but not found in the file (never build on these)", ...v.rejected.map((c) => `- [${c.status}] ${c.unit} ${c.path}: ${c.claim.replace(/\s+/g, " ").slice(0, 200)}${c.detail ? `\n    ${c.detail}` : ""}`)] : []),
        ...(v.thin.length
            ? [
                "",
                "## Verified, but the quote does not visibly back the claim",
                "The quote is really at those lines. It also shares no content word with the claim it is attached to, which is what an unsupported citation looks like from the outside — so it is labelled rather than trusted. Whether a line truly supports a claim needs a reader; this is the half that can be checked without one, and shared wording would not have proved it either.",
                ...v.thin.map((c) => `- ${c.unit} ${c.path}${c.lines ? `:${c.lines[0]}-${c.lines[1]}` : ""}: ${c.claim.replace(/\s+/g, " ").slice(0, 200)}\n    \`${c.quote.replace(/\s+/g, " ").slice(0, 200)}\``),
            ]
            : []),
        ...(d.repair?.attempts.length
            ? [
                "",
                "## The repair pass (one second chance, for a citation the gate rejected)",
                `- ${d.repair.calls} unit(s) got their own rejected findings back with the server's reason: which lines they cited, and where the quote actually is when it exists elsewhere. ${d.repair.repaired} finding(s) came back verified, ${d.repair.stillRejected} are still not verifiable.`,
                ...d.repair.attempts.map((a) => `- ${handleFor(a.role)} (${a.unit}): ${a.sent} sent back → ${a.recited} re-cited under the same claim, ${a.replaced} replaced by a different finding, ${a.withdrawn.length} withdrawn, ${a.unaddressed} left unaddressed${a.error ? ` — the pass FAILED: ${a.error.split("\n")[0]}` : ""}`),
                ...d.repair.attempts.flatMap((a) => a.withdrawn.map((w) => `    - ${a.unit} withdrew: ${w.claim.replace(/\s+/g, " ").slice(0, 160)} — ${w.why.replace(/\s+/g, " ").slice(0, 200)}`)),
                "- Nothing that had already passed was re-sent: a correction round is allowed to add, never to edit a verified finding. Every re-cited claim went through the same gate at the same standard, and a first attempt that failed is still listed as rejected above.",
            ]
            : []),
        ...(v.conflicts.length ? ["", "## Conflicts", ...v.conflicts.map((c) => `- ${c}`)] : []),
        ...(d.conversation ? ["", "## The conversation (round two)", ...renderConversation(d.conversation, d.units)] : []),
        ...(d.conversation?.responses.some((r) => r.dissent.length)
            ? ["", "## They do not all agree (unproven dissent, kept for the owner)", ...d.conversation.responses.flatMap((r) => r.dissent.map((x) => `- ${r.unit}: ${x}`))]
            : []),
        "",
        ...(d.offered.length
            ? [
                "",
                "## Skills (the owner's own instructions, offered to the leader)",
                `- offered for assignment: ${d.offered.slice(0, 20).join(", ")}${d.offered.length > 20 ? ` (and ${d.offered.length - 20} more)` : ""}`,
                ...(d.skills.length
                    ? d.skills.map((s) => `- ${s.unit} followed **${s.name}** — ${Math.round(s.bytes / 1024)} KB of its text was in that worker's prompt (${s.path})`)
                    : ["- the leader assigned none of them, so no skill text reached any prompt."]),
                "- A skill is how to work, never what is true: it cannot be cited as a fact about this code, and nothing it says was checked against the source.",
            ]
            : []),
        "",
        "## Memory",
        `- ${d.memory.live} entr${d.memory.live === 1 ? "y" : "ies"} from earlier missions were given to this run as hints.`,
        ...(d.memory.added.length
            ? ["- recorded for future missions (each carries the quote the server re-read):", ...d.memory.added.map((m) => `    - [${m.kind}] ${m.path ?? ""}: ${m.text.replace(/\s+/g, " ").slice(0, 160)}`)]
            : d.memory.reinforced
                ? [`- nothing new, but ${d.memory.reinforced} earlier entr${d.memory.reinforced === 1 ? "y" : "ies"} were confirmed again by this mission.`]
                : ["- nothing was solid enough to record."]),
        ...(d.memory.stale.length ? [`- ${d.memory.stale.length} earlier entr${d.memory.stale.length === 1 ? "y" : "ies"} retired: the code they quoted is gone or changed, so they were kept out of every prompt.`] : []),
        "- Memory is a hint list and never a citation. Nothing in it counts until someone quotes the file again.",
        ...(d.failed.length ? ["", "## Workers that produced nothing usable", ...d.failed.map((f) => `- ${f.unit}: ${f.error.split("\n")[0]}`)] : []),
        "",
        "## Unknowns the collective admitted",
        ...(plan.unknowns.length || d.reports.some((r) => r.unknowns.length || r.openQuestions.length)
            ? [
                ...plan.unknowns.map((x) => `- leader: ${x}`),
                ...d.reports.flatMap((r) => [...r.unknowns.map((x) => `- ${r.unit} (did not know): ${x}`), ...r.openQuestions.map((x) => `- ${r.unit} (asked): ${x}`)]),
            ]
            : ["- (none: nobody admitted an unknown, which is worth being suspicious about)"]),
        ...(s.unverified.length ? ["", "## Unverified (claimed, but not checkable from the source we read)", ...s.unverified.map((x) => `- ${x}`)] : []),
        "",
        "## Method and cost",
        stats.closingRan
            ? `- leader: one planning pass over a ${stats.digestTokens}-token digest computed from the files (no file contents), then one closing pass over the checked findings only.`
            : `- leader: one planning pass over a ${stats.digestTokens}-token digest, with no closing pass (it needs at least one usable worker report). The findings below are unmerged.`,
        `- workers: ${d.units.map((u) => `${handleFor(u.role)}(${u.id})`).join(", ")} — parallel, no shared context in round one.`,
        stats.peerCalls
            ? `- round two: the same copies read each other's verified findings (${stats.peerCalls} replies, quote-checked like everything else). Agreement between copies of one model is not independent evidence and is never counted as verification here.`
            : "- round two did not run, so no worker saw another's findings.",
        d.memory.live || d.memory.added.length
            ? `- memory: ${d.memory.live} live entr${d.memory.live === 1 ? "y" : "ies"} were in front of it at the start (hints, never citations); ${d.memory.added.length} recorded from this mission${d.memory.stale.length ? `; ${d.memory.stale.length} retired as stale` : ""}.`
            : "- memory: nothing recorded yet from this repository.",
        d.skills.length ? `- skills: ${d.skills.map((s) => `${s.name} → ${s.unit}`).join(", ")} (read from disk into that worker's prompt; not evidence).` : "- skills: none assigned by the leader.",
        `- verification: ${v.claims.length} quotes re-read from disk in ${v.ms} ms, ${v.counts.verified} matched at the cited lines, ${v.counts["found-elsewhere"]} matched elsewhere (line numbers wrong), ${v.counts["quote-not-found"]} not found${stats.thin ? `; ${stats.thin} matched but do not visibly back their claim` : ""}.`,
        stats.repairCalls
            ? `- repair: one pass, ${stats.repairCalls} model call(s). ${stats.repaired} rejected finding(s) were re-cited and re-verified; ${stats.withdrawn} claim(s) were withdrawn by their own worker with a reason. The pass never re-sends a finding that already passed, and never gets a second attempt.`
            : `- repair: no pass ran (nothing rejected was repairable, or \`collective.repairRound\` is off).`,
        `- edits: ${d.edits.edits.length} proposed change(s) went through the same gate as the quotes — the path must exist, the anchor must really be in that file at the lines it cites, and the file must still hash to the recorded snapshot: ${d.edits.counts.anchored} anchored, ${d.edits.broken} that cannot be applied as described, ${d.edits.staleLines} with stale line numbers, ${d.edits.unanchored} anchored to nothing.${stats.editsPathless ? ` ${stats.editsPathless} further step(s) named no file, so nothing about where they land could be checked.` : ""} What a change there can break is read off the index's own import graph, never guessed.`,
        stats.editRepairCalls
            ? `- edit repair: one pass, ${stats.editRepairCalls} model call(s). ${stats.editsFixed} step(s) that could not be placed came back placed and re-verified; ${stats.editsWithdrawn} were withdrawn by their own author with a reason. The pass never re-sends a step that already landed and never gets a second attempt.`
            : `- edit repair: no pass ran (every step that was checked could be placed, or \`collective.editRepair\` is off).`,
        stats.conclusionFound
            ? `- conclusion: ${stats.conclusionFound} sentence(s) of the closing paragraph contradicted this mission's own record — a finding the gate deleted restated, a claim its own author withdrew, a labelled THIN SUPPORT quote stated as established, or a file that is not in this repository. ${stats.conclusionsStanding} still contradict it at the end.`
            : `- conclusion: the closing paragraph was checked against the mission's own record and no sentence contradicted it.`,
        stats.conclusionRepairCalls
            ? `- conclusion repair: one pass, ${stats.conclusionRepairCalls} model call(s). ${stats.conclusionsRewritten} sentence(s) were rewritten and re-checked against the record; ${stats.conclusionsWithdrawn} were given up by the leader with a reason. Nothing else in the conclusion was touched, and the pass never gets a second attempt.`
            : `- conclusion repair: no pass ran (no sentence contradicted the record, or \`collective.conclusionRepair\` is off).`,
        `- verdict: ${d.verdict.grade.toUpperCase()} — ${d.verdict.totals.verified} verified quote(s), ${d.verdict.totals.rejected} rejected, ${d.verdict.totals.stillWrong} citation(s) still wrong, ${d.verdict.totals.productive}/${d.verdict.totals.units} unit(s) usable. Computed from these counts, not written by a model.`,
        `- index: ${idx.totals.files} files, ${stats.cached ? "reused from cache" : `built in ${idx.buildMs} ms`}; ${idx.skipped.length} file(s) skipped.`,
        ...(d.warnings.length ? ["", "## Warnings raised while running", ...[...new Set(d.warnings)].map((w) => `- ${w}`)] : []),
        "",
        "## What this does NOT check",
        `- A verified quote proves the code says that. It does not prove the conclusion drawn from it is right.`,
        `- Nothing here ran the project's own gates. After implementing, run: ${[t.test ? `\`${t.test}\`` : null, t.build ? `\`${t.build}\`` : null, t.lint ? `\`${t.lint}\`` : null].filter(Boolean).join(", ") || "(this project declares no test, build or lint command — that is itself a finding)"}`,
        `- The index skipped ${idx.skipped.length} file(s) and extracts symbols with a lightweight parser, so a path can be missing from every context above without being missing from the repo.`,
        `- The edit gate checks where an edit lands, not what it does: it does not apply the change, does not parse the result, and cannot tell a correct change from a wrong one. It also only knows the import graph of the index, so a file reached by a dynamic import, a string path or a build step is invisible to the impact line.`,
        `- The support label is one-sided. A quote sharing no wording with its claim is flagged; a quote that shares wording is NOT thereby supporting it (non-entailing pairs with near-perfect overlap are easy to build), and nothing here reads a passage to decide.`,
        `- The conclusion check is one-sided as well: it catches a sentence that contradicts this mission's own record, states a labelled THIN SUPPORT finding as established, or names a file that is not in this repository. It does not decide whether a conclusion is right — a paragraph built only from verified quotes can still be a bad one — and a sentence that repeats a rejected finding in different words than the claim's own may pass it.`,
    ]
        .filter((l) => l !== undefined)
        .join("\n");
}
/** The gate's verdict on one step of the closing plan, short enough to sit on the end of its line. */
function planEditNote(edits, i) {
    const e = edits.edits.find((x) => x.source === "plan" && x.sourceIndex === i);
    if (!e)
        return "";
    if (e.status === "anchored")
        return ` [edit gate: the anchor is in ${e.path} as cited${e.impact?.importedBy ? `, ${e.impact.importedBy} file(s) import it` : ""}]`;
    return ` [edit gate: ${e.status}${e.detail ? ` — ${e.detail}` : ""}]`;
}
async function prune(dir, keep) {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep)))
        await fs.rm(path.join(dir, f), { force: true });
}
export async function loadDossier(root, id) {
    const clean = id.replace(/[^a-z0-9-]/gi, "");
    const dir = missionsDir(root);
    const files = await fs.readdir(dir).catch(() => []);
    const hit = files.find((f) => f === `${clean}.md`) ?? files.filter((f) => f.startsWith(clean)).sort().at(-1);
    if (!hit) {
        const existing = files.map((f) => f.replace(/\.md$/, "")).join(", ");
        throw new Error(`No mission dossier "${id}" in .design-mcp/collective/${existing ? `. Existing: ${existing}` : " (none have been run in this project yet)"}`);
    }
    return fs.readFile(path.join(dir, hit), "utf8");
}
export async function listDossiers(root) {
    const dir = missionsDir(root);
    const files = await fs.readdir(dir).catch(() => []);
    const out = [];
    for (const f of files.filter((x) => x.endsWith(".md")).sort().reverse()) {
        const st = await fs.stat(path.join(dir, f)).catch(() => null);
        out.push({ id: f.replace(/\.md$/, ""), bytes: st?.size ?? 0 });
    }
    return out;
}
