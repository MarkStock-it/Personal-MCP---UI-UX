/**
 * Which repository this server is working on.
 *
 * The server is installed once — one entry in the host's MCP settings — and then used from whatever
 * repo the owner happens to have open. So the project root is a decision it has to make per session,
 * and, more importantly, a decision it has to make *visibly*. The old version was one line:
 * `DESIGN_MCP_PROJECT_DIR ?? process.cwd()`. That is fine for a server launched inside its project and
 * wrong everywhere else: a desktop host launched it from the home folder, so every codebase tool
 * indexed and cited 2,900 files across the owner's whole home, and no line of output said so. A wrong
 * answer that looks like a right one is the worst thing this file could do.
 *
 * Precedence, highest first:
 *
 *   1. `project_root { path }` — an explicit decision by the owner, made in this session. It outranks
 *      everything, including the env var, because the owner saying "this repo, now" is newer information
 *      than a path baked into an MCP settings file months ago (that stale path is the exact reason this
 *      tool exists). Session-scoped on purpose: a stdio server belongs to one conversation.
 *   2. `DESIGN_MCP_PROJECT_DIR` — an explicit decision at install time. Never second-guessed.
 *   3. The folder the host reports as its workspace (MCP `roots`) — the mechanism that makes a single
 *      install work in every repo, because the host knows which folder is open and the server cannot
 *      guess it. Read once, after initialize, and only if the host declares the capability. Some hosts
 *      do not advertise it, which is why (1) exists.
 *   4. The working directory, walked up to the nearest repository marker, so a server started in
 *      `repo/src/deep/dir` still indexes `repo` rather than that leaf.
 *
 * If what survives all that is a home folder or a filesystem root, there is no project: `assertProject`
 * refuses and names the three ways to fix it, instead of indexing a home directory and calling it a repo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectInfo {
  /** Absolute path the tools will treat as the project. */
  root: string;
  /** Where that came from, in words, for the report: env, host workspace, working directory. */
  source: string;
  /** True when the root is a home folder or a filesystem root: a location, not a project. */
  tooBroad: boolean;
  /** The one-line complaint and its fixes, when `tooBroad`. */
  warning?: string;
}

/** Files whose presence means "a repository starts here". `.git` covers git; the rest cover the common
 *  non-git layouts, because a folder without version control is still somebody's project. */
const MARKERS = [".git", "package.json", "pnpm-workspace.yaml", "go.mod", "Cargo.toml", "pyproject.toml", "composer.json"];

let hostRoot: string | null = null;
let sessionRoot: string | null = null;
let discovery: Promise<void> | null = null;

const cache = new Map<string, ProjectInfo>();

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** A home folder, its parent, or a drive/filesystem root is never "the project". */
export function isTooBroad(root: string): boolean {
  const abs = path.resolve(root);
  const home = os.homedir();
  if (same(abs, home) || same(abs, path.dirname(home))) return true;
  return path.dirname(abs) === abs; // "/" or "C:\"
}

const warningFor = (root: string) =>
  [
    `The project root resolved to ${root}, which is not a repository — so nothing here is being indexed or cited, on purpose.`,
    "Fix it, cheapest first:",
    '  1. Call project_root { path: "<absolute path to the repo>" }. It applies to this session immediately: no restart, no settings edit, no rebuild.',
    '  2. Or add "DESIGN_MCP_PROJECT_DIR": "<absolute path to the repo>" to the "env" block of the design-mcp server in your MCP settings, then restart the server.',
    "  3. Or open the repository folder itself as the workspace, so the host reports it to the server as a root.",
    "providers_config shows how the root was resolved and what the host reported.",
  ].join("\n");

/** Called once, from the host's `roots/list`, after initialize. Silently a no-op when the host has no roots. */
export function setHostRoot(root: string | null): void {
  hostRoot = root ? path.resolve(root) : null;
  cache.clear();
}

/**
 * `project_root { path }`: the owner pointing at a repository, mid-session. Outranks the env var, because
 * a repo named now is better information than a path from an install-time config. Not persisted: the
 * point is to stop one install from being pinned to one repo, not to pin it to a third.
 */
export function setSessionRoot(root: string | null): void {
  sessionRoot = root ? path.resolve(root) : null;
  cache.clear();
}

export const sessionRootKnown = () => sessionRoot;

export const hostRootKnown = () => hostRoot;

/** The nearest ancestor (or the folder itself) holding a repository marker; null if there is none. */
export function repoRootOf(start: string): string | null {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 24; depth++) {
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function resolve(): ProjectInfo {
  if (sessionRoot) {
    const root = sessionRoot;
    const tooBroad = isTooBroad(root);
    return { root, source: "project_root: the path the owner named in this session", tooBroad, ...(tooBroad ? { warning: warningFor(root) } : {}) };
  }

  const configured = process.env.DESIGN_MCP_PROJECT_DIR?.trim();
  if (configured) {
    const root = path.resolve(configured);
    // Explicit wins even when it looks too broad: the owner may really mean a folder that is also home.
    return { root, source: "DESIGN_MCP_PROJECT_DIR", tooBroad: false };
  }

  if (hostRoot) {
    const root = hostRoot;
    const tooBroad = isTooBroad(root);
    return { root, source: "the workspace this host reported (MCP roots)", tooBroad, ...(tooBroad ? { warning: warningFor(root) } : {}) };
  }

  const cwd = process.cwd();
  const walked = repoRootOf(cwd);
  const root = walked ?? cwd;
  const source = walked && !same(walked, cwd) ? `the working directory, walked up to its repository root (from ${cwd})` : "the working directory";
  const tooBroad = isTooBroad(root);
  return { root, source, tooBroad, ...(tooBroad ? { warning: warningFor(root) } : {}) };
}

/** Synchronous resolution. Use where the root is reported; use `assertProject` where it is relied on. */
export function projectRootInfo(): ProjectInfo {
  const key = `${sessionRoot ?? ""}|${process.env.DESIGN_MCP_PROJECT_DIR ?? ""}|${hostRoot ?? ""}|${process.cwd()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const info = resolve();
  cache.set(key, info);
  return info;
}

/**
 * Ask the host which folders it has open. One request, once per session, and only when the client
 * declared the `roots` capability — `listRoots` on a host without it is an error, not an empty list.
 * The first file root wins: a single-repo server cannot use four, and guessing among them would be
 * exactly the silent-wrong-answer problem this module exists to remove.
 */
export function adoptHostRoots(server: { getClientCapabilities(): { roots?: unknown } | undefined; listRoots(): Promise<{ roots?: { uri: string }[] }> }): Promise<void> {
  if (discovery) return discovery;
  discovery = (async () => {
    try {
      if (!server.getClientCapabilities()?.roots) return;
      const res = await server.listRoots();
      const uri = (res.roots ?? []).map((r) => r.uri).find((u) => typeof u === "string" && u.startsWith("file:"));
      if (!uri) return;
      setHostRoot(fileURLToPath(uri));
    } catch {
      /* A host that advertises roots but answers with an error leaves us on the next rung of the ladder. */
    }
  })();
  return discovery;
}

/** Wait briefly for the host's roots (they arrive after initialize), then report the root. */
export async function ensureProject(waitMs = 2000): Promise<ProjectInfo> {
  if (discovery) await Promise.race([discovery, new Promise((r) => setTimeout(r, waitMs))]);
  return projectRootInfo();
}

/** The root, or a refusal that says how to fix it. Use before reading or writing anything project-scoped. */
export async function assertProject(): Promise<string> {
  const info = await ensureProject();
  if (info.tooBroad) throw new Error(info.warning ?? warningFor(info.root));
  return info.root;
}

/**
 * Synchronous form, for a function that was handed a root and must decide before using it. It only
 * refuses when the root it was given *is* the resolved one: a caller that passed an explicit path
 * (a test fixture, a variation directory) has already made the decision this module exists to protect.
 */
export function assertUsableRoot(root: string): void {
  const info = projectRootInfo();
  if (info.tooBroad && same(root, info.root)) throw new Error(info.warning ?? warningFor(root));
}
