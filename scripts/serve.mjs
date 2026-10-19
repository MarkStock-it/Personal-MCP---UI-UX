#!/usr/bin/env node
/**
 * The entry point the MCP host should run, instead of `dist/index.js` directly.
 *
 * `dist/` is committed and loaded once per session, which means an install that runs the built file
 * is only as new as the last time somebody remembered to build. That is fine for a release and wrong
 * for a server that is being worked on every day: the host restarts, the session looks normal, and the
 * tools quietly answer from a build that predates the fix being tested.
 *
 * So: check whether any TypeScript source is newer than the newest emitted file, run `tsc` when it is,
 * then hand stdio to the built server.
 *
 * Two rules, both load-bearing:
 *   - **Nothing is written to stdout.** stdout is the MCP protocol. The compiler's output is piped to
 *     stderr, and so is every log line here.
 *   - **A failed build does not take the server down.** If `tsc` fails (a half-finished edit, a type
 *     error), the output goes to stderr and the last good build is started anyway, because a working
 *     tool set with a stale build beats a session where every tool is "not found". The next spawn
 *     tries again.
 *
 * Concurrent spawns are serialised with a lock file: two sessions opening at once must not run two
 * compilers over the same output directory.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const ENTRY = path.join(DIST, "index.js");
const LOCK = path.join(ROOT, ".design-mcp", "build.lock");
const LOCK_WAIT_MS = 60_000;
const log = (m) => process.stderr.write(`[design-mcp launcher] ${m}\n`);

/** Newest mtime under a directory, or 0 when it does not exist. */
function newest(dir, accept) {
  let best = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (accept(e.name)) {
        try {
          const t = fs.statSync(p).mtimeMs;
          if (t > best) best = t;
        } catch {
          /* a file that vanished mid-walk is not a build reason */
        }
      }
    }
  };
  walk(dir);
  return best;
}

const newestSource = () =>
  Math.max(
    newest(path.join(ROOT, "src"), (n) => n.endsWith(".ts")),
    ...["tsconfig.json"].map((f) => {
      try {
        return fs.statSync(path.join(ROOT, f)).mtimeMs;
      } catch {
        return 0;
      }
    })
  );

const newestEmitted = () => newest(DIST, (n) => n.endsWith(".js"));

function locked() {
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
    fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

const unlock = () => {
  try {
    fs.unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
};

function build() {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) {
    log("typescript is not installed here (node_modules/typescript is missing) — running the existing build");
    return false;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [tsc], { cwd: ROOT, encoding: "utf8" });
  // The compiler's own stdout is diagnostics, not protocol. It must never reach our stdout.
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    log(`build failed (${Date.now() - t0} ms) — starting the last good build; the next session will retry`);
    return false;
  }
  log(`rebuilt in ${Date.now() - t0} ms`);
  return true;
}

async function ensureBuilt() {
  if (!fs.existsSync(ENTRY)) {
    log("no build found — compiling");
    build();
    return;
  }
  if (newestSource() <= newestEmitted()) return;

  // Someone else may be compiling already; wait for them rather than racing the output directory.
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (locked()) {
      try {
        if (newestSource() > newestEmitted()) build();
      } finally {
        unlock();
      }
      return;
    }
    if (newestSource() <= newestEmitted()) return; // they finished while we waited
    await new Promise((r) => setTimeout(r, 400));
  }
  log("another session is still building; starting what is on disk");
}

await ensureBuilt();

if (!fs.existsSync(ENTRY)) {
  log(`no build at ${ENTRY} and the build failed — nothing to start`);
  process.exit(1);
}

// The server process keeps the directory the host launched us from: that is rung 4 of the project-root
// resolution, and `project_root`'s `From:` line reports it. Building needs ROOT; running must not rewrite
// the caller's cwd, or every repo would report the server's own checkout as "the working directory".
const callerCwd = (() => {
  try {
    return fs.statSync(process.cwd()).isDirectory() ? process.cwd() : ROOT;
  } catch {
    return ROOT;
  }
})();
const child = spawn(process.execPath, [ENTRY, ...process.argv.slice(2)], { cwd: callerCwd, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on("error", (e) => {
  log(`could not start the server: ${e.message}`);
  process.exit(1);
});
