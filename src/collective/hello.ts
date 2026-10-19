/**
 * "Hello collective."
 *
 * The owner's request: open a session, say three words, and the crew is already awake in the repo.
 *
 * A server cannot speak first — nothing in MCP lets the collective push a message into a conversation
 * that has not called it — so the greeting works from two ends. This module is the answer to one call:
 * a single cheap pass, no model and no API key, that returns who is here, what this repo is, what the
 * collective already established or already got wrong, which missions are open, and which of the owner's
 * skills are installed. The other end is `install.ts`, which puts a block in the repo's instruction file
 * telling the host to make that call at the start of a session. Together those are the closest honest
 * version of "it runs every time I open a session".
 *
 * It is fast on purpose (index cache, a few small files, one `git status`) because it is meant to run at
 * the top of every session rather than once. Nothing here is a claim about the code: every line is either
 * computed from the files or attributed to the mission that recorded it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { CodebaseConfig, CollectiveConfig, LocalConfig, SkillsConfig } from "../config.js";
import { readLocalState, renderLocalStatus } from "../ollama/state.js";
import { estimateTokens, getIndex, renderDigest } from "../codebase/store.js";
import { run } from "../util/exec.js";
import { loadMemory } from "./memory.js";
import { LEADER, PERSONAS } from "./personas.js";
import { listDossiers, missionsDir } from "./run.js";
import { discoverSkills, renderSkillIndex, type SkillScan } from "../skills/index.js";

export interface HelloConfig {
  codebase: CodebaseConfig;
  collective: CollectiveConfig;
  skills: SkillsConfig;
  /** Optional: present when the owner has a `local` block or a runtime flip — the greeting reports its state. */
  local?: LocalConfig;
}

export interface HelloOptions {
  /** What the owner said they want, if anything. Focuses the digest and the closing advice. */
  focus?: string;
  budgetTokens?: number;
  /** Skip the skills scan (it walks a few directories). */
  skills?: boolean;
  missions?: number;
}

export interface HelloResult {
  text: string;
  indexName: string;
  files: number;
  liveMemory: number;
  staleMemory: number;
  skills: number;
  missions: number;
  ms: number;
}

/** The newest dossier's own header, so the greeting can say what the last mission actually was. */
async function lastMissions(root: string, want: number): Promise<{ id: string; mission: string; head: string; grade: string }[]> {
  const files = await listDossiers(root);
  const out: { id: string; mission: string; head: string; grade: string }[] = [];
  for (const f of files.slice(0, want)) {
    let text = "";
    try {
      text = await fs.readFile(path.join(missionsDir(root), `${f.id}.md`), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    // The verdict the mission counted for itself. Read, never recomputed: a greeting has no business
    // grading a run it did not take part in.
    const grade = text.match(/^- Grade: ([A-Z]+) —/m)?.[1] ?? "";
    out.push({ id: f.id, mission: lines[1]?.trim() || "(unreadable)", head: lines[3]?.trim() || "", grade });
  }
  return out;
}

async function gitState(root: string): Promise<string> {
  const r = await run("git", ["status", "--porcelain=v1", "--branch"], root, 6000);
  if (r.code !== 0) return "(not a git repository, or git is unavailable — nothing else here depends on it)";
  const lines = r.out.split("\n").filter(Boolean);
  const branch = lines.find((l) => l.startsWith("##"))?.replace(/^##\s*/, "") ?? "(unknown branch)";
  const dirty = lines.filter((l) => !l.startsWith("##"));
  if (!dirty.length) return `${branch} — clean working tree`;
  const count = (c: string) => dirty.filter((l) => l.startsWith(c)).length;
  const parts = [`${count("??")} untracked`, `${count(" M") + count("M ")} modified`, `${count(" D") + count("D ")} deleted`].filter((p) => !p.startsWith("0 "));
  return `${branch} — ${dirty.length} uncommitted file(s): ${parts.join(", ")}`;
}

export async function helloCollective(projectRoot: string, cfg: HelloConfig, opts: HelloOptions = {}): Promise<HelloResult> {
  const t0 = Date.now();
  const loaded = await getIndex(projectRoot, cfg.codebase, {});
  const index = loaded.index;
  const budget = Math.min(opts.budgetTokens ?? 1100, cfg.codebase.digestTokens);
  const digest = renderDigest(index, { tokens: budget, focus: opts.focus });
  const digestTokens = estimateTokens(digest);

  const memory = cfg.collective.memory ? await loadMemory(projectRoot) : { items: [], stale: [], live: [] };
  const missions = await lastMissions(projectRoot, opts.missions ?? 3);
  const git = await gitState(projectRoot);
  // Local mode's state, one small file read — it is the answer to "is the local model in the loop?".
  const localState = cfg.local ? readLocalState(projectRoot) : null;
  const localLine = localState
    ? `\n## Local delegation${localState.note ? `\n${localState.note.replace(/\n/g, " ")}` : ""}\n${renderLocalStatus(projectRoot, cfg.local!)}\nWith the mode off, zero Ollama calls happen; with it on, units the leader marks eligible (well-scoped implementer work only) are written by the local model and audited before anything is kept.`
    : "";

  let scan: SkillScan | null = null;
  if (cfg.skills.enabled && opts.skills !== false) {
    scan = await discoverSkills(projectRoot, cfg.skills);
  }

  const lines: string[] = [
    `# The collective is here — ${index.name}`,
    `${index.totals.files} files, ${index.totals.lines} lines, root ${index.root}`,
    `index: ${loaded.cached ? "cache re-verified, nothing changed since the last mission" : `built in ${index.buildMs} ms`} · git: ${git}`,
    "",
    "## Roll call",
    `${LEADER.handle} (leader) — holds the shape of the job; plans, never reads a file, never writes code.`,
    ...Object.entries(PERSONAS).map(([role, p]) => `${p.handle} (${role}) — ${p.title}.`),
    `Seats are prompt-level stances on the same weights, so they disagree usefully but not independently: agreement between them is never counted as proof here, only a quote the server re-read from a file is.`,
    "",
    "## What the collective already knows about this repo",
    memory.items.length
      ? `${memory.live.length} live entr${memory.live.length === 1 ? "y" : "ies"}: ${memory.live.filter((m) => m.kind === "ruling").length} owner ruling(s), ${memory.live.filter((m) => m.kind === "established").length} verified claim(s), ${memory.live.filter((m) => m.kind === "rejected").length} already-rejected claim(s)${memory.stale.length ? `, and ${memory.stale.length} retired because the code they quoted changed` : ""}.`
      : cfg.collective.memory
        ? "Nothing yet — no mission has been run in this repo, so the crew starts from the code and from your words only."
        : "Memory is switched off (collective.memory is false in the config), so nothing carries over from one mission to the next.",
    ...(memory.live.length
      ? [
          ...memory.live.filter((m) => m.kind === "ruling").map((m) => `- [your ruling] ${m.text}`),
          ...memory.live.filter((m) => m.kind === "established").slice(0, 6).map((m) => `- ${m.path}${m.lines ? `:${m.lines[0]}` : ""} (confirmed ${m.hits}×): ${m.text.slice(0, 150)}`),
          ...(memory.stale.length ? [`- ${memory.stale.length} earlier entr${memory.stale.length === 1 ? "y" : "ies"} were kept out of every prompt: the code they quoted is no longer there.`] : []),
          "Memory is a hint list and never a citation: nothing in it counts until someone quotes the file again.",
        ]
      : []),
    "",
    ...(localLine ? [localLine, ""] : []),
    "## Open work",
    ...(missions.length
      ? missions.map((m) => `- ${m.id} — ${m.mission}\n    .design-mcp/collective/${m.id}.md${m.grade ? ` · verdict ${m.grade}` : ""}${m.head ? ` · ${m.head}` : ""}`)
      : ["- No mission has been run here yet. Say what to attack and the first one starts from the files."]),
    "",
    "## Your skills",
    ...(scan
      ? [renderSkillIndex(scan, { limit: 12 }).split("\n").slice(0, 1)[0], ...scan.skills.slice(0, 12).map((s) => `- ${s.name}${s.copies.length ? ` (${s.copies.length + 1} copies on disk)` : ""} — ${s.description.replace(/\s+/g, " ").slice(0, 120)}`), ...(scan.skills.length > 12 ? [`- ... and ${scan.skills.length - 12} more (skills_list / code://skills)`] : []), "Assign one to a unit in a mission (`skill` on the unit, or skills on collective_run) and its text goes into that worker's prompt. skills_read gives you the full text."]
      : ["- The skills scan is off in this config (`skills.enabled`)."]),
    "",
    "## If you were asked to do something (do not improvise past this)",
    "1. `code_context { query }` for the exact area before touching it — the digest below is a map, not the source.",
    "2. `collective_run { mission }` when the work splits into independent questions; `collective_plan` when you only want the split. Either way the server re-reads every quote a worker makes and deletes what it cannot find.",
    "3. `code_verify_cites` on anything you are about to tell the owner as a fact.",
    "4. `code_verify_edits` on the edits before you make them: every path must exist and every anchor must really be in the file at the lines it cites, and it tells you what imports the file you are about to change. An edit anchored to something that is not there is a guess, not a plan.",
    "5. `code_refs { name }` before a rename, a signature change or a deletion: it names every place the name is declared and used, so \"this file imports that one\" is not mistaken for \"this code calls that function\".",
    "6. Implement the smallest correct change, then run this project's own gates and report what you verified by running, what only by reading, and what you did not check.",
    "",
    `## Digest — this repo in ~${digestTokens} tokens (computed from the files, not written by a model)`,
    digest,
    "",
    "---",
    opts.focus
      ? `The owner's focus: ${opts.focus}. Answer with the state above, then start there.`
      : "If the owner only greeted you: answer with the repo name, the state of the tree, what the collective already knows, and the two or three most interesting things in the digest — then ask which one to attack. Do not invent work and do not describe this repo from memory.",
    `(${Date.now() - t0} ms, no model call, no API key.)`,
  ];

  return {
    text: lines.join("\n"),
    indexName: index.name,
    files: index.totals.files,
    liveMemory: memory.live.length,
    staleMemory: memory.stale.length,
    skills: scan?.skills.length ?? 0,
    missions: missions.length,
    ms: Date.now() - t0,
  };
}
