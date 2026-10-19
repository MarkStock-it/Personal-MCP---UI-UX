#!/usr/bin/env node
/**
 * Build, gate, commit and push — on demand, or whenever the source changes.
 *
 * The server is edited on the same machine that runs it, so "is the running build the current one?"
 * should never be a question answered by hand. This closes the loop:
 *
 *   source changes -> debounce -> tsc -> the gate -> git add/commit -> git push
 *
 * The rules, and why each one exists:
 *   - **Nothing is committed unless it compiles and the gate passes.** An automated committer that
 *     records broken work is worse than no automation: it turns the history into noise and hides real
 *     failures behind a green-looking timestamp. A failed build or a failed check stops here, loudly,
 *     and leaves the working tree exactly as it found it.
 *   - **Only known paths are staged.** `git add -A` on a machine that keeps `.env` files around is a
 *     secret leak with a cron job. Untracked files are added only under the directories below; tracked
 *     edits are picked up with `-u`; anything else (a stray `.env`, a local notes file) is left alone.
 *   - **No merge, rebase or detached HEAD.** Automating a commit in the middle of somebody's conflict
 *     resolution is how work gets lost.
 *   - **A failed push keeps the commit.** The work is safe locally and the next run pushes it; the log
 *     says which part failed.
 *
 * Usage:
 *   node tools/autosync.mjs            # watch, sync after a quiet period
 *   node tools/autosync.mjs --once     # one pass, then exit (same thing `npm run sync` does)
 *   node tools/autosync.mjs --no-test  # skip the gate (only for a docs-only change you trust)
 *   node tools/autosync.mjs --debounce 5000
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const once = args.includes("--once");
const skipTests = args.includes("--no-test");
const debounceArg = args.indexOf("--debounce");
const DEBOUNCE_MS = debounceArg >= 0 ? Math.max(1000, Number(args[debounceArg + 1]) || 15_000) : 15_000;

/** Untracked files are staged only inside these, never repo-wide. */
const STAGE_DIRS = ["src", "smoke", "scripts", "tools", "dist"];
const STAGE_FILES = ["AGENTS.md", "README.md", "package.json", "package-lock.json", "tsconfig.json", "design-mcp.config.json"];

const log = (m) => process.stdout.write(`[autosync ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

function git(...argv) {
  const r = spawnSync("git", argv, { cwd: ROOT, encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

function build() {
  if (!fs.existsSync(tscBin)) return { ok: false, why: "typescript is not installed (node_modules/typescript missing)" };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [tscBin], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, why: `tsc failed (${((Date.now() - t0) / 1000).toFixed(1)}s)\n${(r.stdout ?? "") + (r.stderr ?? "")}` };
  }
  return { ok: true, why: `built in ${Date.now() - t0} ms` };
}

function gate() {
  for (const file of ["smoke/smoke.mjs", "smoke/arithmetic.mjs"]) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) return { ok: false, why: `${file} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)` };
  }
  return { ok: true, why: "gate green" };
}

function blockedReason() {
  if (git("rev-parse", "--is-inside-work-tree").out !== "true") return "not a git work tree";
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
  if (!branch || branch === "HEAD") return "detached HEAD";
  if (fs.existsSync(path.join(ROOT, ".git", "MERGE_HEAD"))) return "a merge is in progress";
  if (fs.existsSync(path.join(ROOT, ".git", "rebase-merge")) || fs.existsSync(path.join(ROOT, ".git", "rebase-apply"))) return "a rebase is in progress";
  return null;
}

const changed = () => git("status", "--porcelain").out.split("\n").filter(Boolean);

function sync(reason) {
  const blocked = blockedReason();
  if (blocked) {
    log(`skipped (${blocked})`);
    return false;
  }
  const dirty = changed();
  if (!dirty.length) {
    log("nothing to sync");
    return false;
  }

  log(`${dirty.length} path(s) changed (${reason}) — building`);
  const b = build();
  if (!b.ok) {
    log(`STOPPED: ${b.why}`);
    log("the working tree is untouched; fix the error and save again");
    return false;
  }
  log(b.why);

  if (!skipTests) {
    log("running the gate");
    const g = gate();
    if (!g.ok) {
      log(`STOPPED: ${g.why} — nothing committed`);
      return false;
    }
    log(g.why);
  } else {
    log("gate skipped (--no-test)");
  }

  // Tracked edits everywhere; new files only under the directories this project owns.
  git("add", "-u");
  git("add", "-A", "--", ...STAGE_DIRS, ...STAGE_FILES);
  const staged = git("diff", "--cached", "--name-only").out.split("\n").filter(Boolean);
  if (!staged.length) {
    log("nothing staged after the filter — no commit");
    return false;
  }

  const message = [
    `autosync: ${staged.length} file(s) — build${skipTests ? "" : " + gate"} green`,
    "",
    staged.slice(0, 40).map((f) => `- ${f}`).join("\n") + (staged.length > 40 ? `\n- ... and ${staged.length - 40} more` : ""),
    "",
    `Triggered by: ${reason}`,
  ].join("\n");
  const c = git("commit", "-m", message);
  if (c.code !== 0) {
    log(`commit failed: ${c.err || c.out}`);
    return false;
  }
  log(`committed ${git("rev-parse", "--short", "HEAD").out}`);

  const p = git("push");
  if (p.code !== 0) {
    log(`committed but NOT pushed: ${p.err || p.out}`);
    log("the commit is safe locally; the next successful sync pushes it");
    return true;
  }
  log("pushed");
  return true;
}

if (once) {
  const ok = sync("manual --once");
  process.exit(ok ? 0 : 1);
}

// The watch set: source, checks, the scripts that run them, and the docs that describe them.
const WATCH_DIRS = ["src", "smoke", "scripts", "tools"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
const WATCH_FILES = ["AGENTS.md", "README.md", "package.json", "tsconfig.json", "design-mcp.config.json"].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));

let timer = null;
let running = false;
let queued = null;

function schedule(reason) {
  queued = queued ?? reason;
  if (running) return; // the run in flight will re-schedule when it finishes
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const why = queued ?? reason;
    queued = null;
    running = true;
    try {
      sync(why);
    } finally {
      running = false;
      if (queued) schedule(queued);
    }
  }, DEBOUNCE_MS);
}

log(`watching ${WATCH_DIRS.map((d) => path.relative(ROOT, d)).join(", ")} — debounce ${DEBOUNCE_MS} ms${skipTests ? ", gate OFF" : ""}`);
log("press Ctrl+C to stop; a running sync always finishes first");

for (const dir of WATCH_DIRS) {
  try {
    fs.watch(dir, { recursive: true }, (_e, file) => {
      if (!file) return;
      if (file.includes(`${path.sep}.design-mcp`) || file.startsWith(".design-mcp")) return;
      schedule(`${path.relative(ROOT, path.join(dir, file.toString()))} changed`);
    });
  } catch (e) {
    log(`cannot watch ${dir}: ${e.message}`);
  }
}
for (const file of WATCH_FILES) {
  try {
    fs.watch(file, () => schedule(`${path.basename(file)} changed`));
  } catch (e) {
    log(`cannot watch ${file}: ${e.message}`);
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("stopped");
    process.exit(0);
  });
}
