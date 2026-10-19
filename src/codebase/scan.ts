/**
 * Reading the repo: which files exist, what they contain, and what the project's own rules are.
 *
 * Two speeds, because they are used for different things:
 *   lightScan  — stat only, no reads. Used to invalidate the cached index cheaply.
 *   scanRepo   — reads every kept file once and extracts its symbols. Used to build the index.
 *
 * The file list comes from `git ls-files -co --exclude-standard` when the root is a git repo, so the
 * project's own .gitignore decides what is source, and the walk is one process instead of thousands of
 * stats. Outside a repo it falls back to a walk with the configured ignore list. Either way, nothing
 * outside the configured roots is ever read.
 *
 * It also reads the project's own tsconfig/jsconfig `paths` map, because an unresolved alias makes the
 * import graph quietly wrong (see readPathAliases).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { extractSymbols, langOf, MINIFIED_LINE, type ImportRef, type Lang, type Sym } from "./symbols.js";

export interface FileIndex {
  path: string; // relative to the project dir, forward slashes
  lang: Lang;
  bytes: number;
  lines: number;
  symbols: Sym[];
  imports: ImportRef[];
}

export interface Skipped { path: string; reason: string }

export interface Note { path: string; heading: string }

export interface Conventions {
  name: string;
  /** The nearest package.json, which is not always at the root (e.g. a repo whose app lives in server/). */
  manifestPath: string | null;
  manifestDir: string | null;
  packageName: string | null;
  packageManager: string | null;
  scripts: { name: string; command: string }[];
  test: string | null;
  build: string | null;
  lint: string | null;
  dev: string | null;
  typescript: boolean;
  tsStrict: boolean;
  moduleSystem: "esm" | "cjs" | "unknown";
  frameworks: string[];
  tests: string[];
  notes: Note[];
}

export interface ScanResult {
  root: string;
  files: FileIndex[];
  skipped: Skipped[];
  notes: string[];
  conventions: Conventions;
  /** The project's own `paths` map from tsconfig/jsconfig, so `@/x` is not mistaken for a package. */
  aliases: PathAlias[];
  ms: number;
}

/** One entry of a tsconfig `paths` map, with the directory its targets are relative to. */
export interface PathAlias {
  pattern: string;
  targets: string[];
  base: string;
}

export interface LightEntry { path: string; bytes: number; mtimeMs: number }
export interface LightScan { entries: LightEntry[]; note?: string; ms: number }

export interface ScanOptions { roots: string[]; ignore: string[]; maxFiles: number; maxFileKB: number }

const ALWAYS_SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

const runGit = (args: string[], cwd: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.split("\0").filter(Boolean));
    });
  });

/** Files in one root, repo-relative, honouring .gitignore when git is available. */
async function listOne(root: string, ignore: string[], maxFiles: number): Promise<{ files: string[]; note?: string }> {
  try {
    const rel = await runGit(["ls-files", "-co", "--exclude-standard", "-z"], root);
    if (rel.length) return { files: rel.map((f) => f.replace(/\\/g, "/")), note: "file list from git ls-files (respects .gitignore)" };
  } catch {
    /* not a repo, or git missing: walk it */
  }
  const skip = new Set(ignore);
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith(".git")) continue;
        await walk(abs, depth + 1);
      } else if (e.isFile() && !ALWAYS_SKIP_FILES.has(e.name)) {
        out.push(path.relative(root, abs).replace(/\\/g, "/"));
      }
    }
  };
  await walk(root, 0);
  return { files: out, note: "no git repo here, so the configured ignore list chose the files" };
}

/** Every readable source path under the configured roots, relative to the project dir. */
export async function listFiles(projectRoot: string, opts: ScanOptions): Promise<{ files: string[]; notes: string[] }> {
  const files: string[] = [];
  const notes: string[] = [];
  const root = path.resolve(projectRoot);
  for (const r of opts.roots) {
    const abs = path.resolve(root, r);
    // Containment by path.relative, not by string prefix: a prefix test accepts a SIBLING whose name merely
    // starts with the project's (`../proj-old` next to `proj`), which would index files outside the project
    // and cite them as if they were inside it, and it breaks outright when the two sides are spelled
    // differently (`E:/x` against `E:\\x`, or a trailing separator). The edit gate and the citation gate
    // already guard this way; the scanner was the one that did not.
    const rel = path.relative(root, abs); // "" for the project root itself, which is inside
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      notes.push(`root "${r}" is outside the project and was ignored`);
      continue;
    }
    const base = rel.replace(/\\/g, "/");
    const { files: found, note } = await listOne(abs, opts.ignore, opts.maxFiles - files.length);
    if (note) notes.push(`${r}: ${note}`);
    for (const f of found) {
      const rel = base ? `${base}/${f}` : f;
      const parts = rel.split("/");
      if (parts.some((p) => opts.ignore.includes(p))) continue;
      if (langOf(rel) === "other") continue;
      files.push(rel);
    }
  }
  const uniq = [...new Set(files)].sort();
  if (uniq.length > opts.maxFiles) {
    notes.push(`${uniq.length} files found, capped at codebase.maxFiles=${opts.maxFiles}; raise it to index more`);
  }
  return { files: uniq.slice(0, opts.maxFiles), notes };
}

export async function lightScan(projectRoot: string, opts: ScanOptions): Promise<LightScan> {
  const t0 = Date.now();
  const { files, notes } = await listFiles(projectRoot, opts);
  const entries: LightEntry[] = [];
  for (const f of files) {
    try {
      const st = await fs.stat(path.join(projectRoot, f));
      entries.push({ path: f, bytes: st.size, mtimeMs: Math.round(st.mtimeMs) });
    } catch {
      /* vanished between listing and stat */
    }
  }
  return { entries, note: notes[0], ms: Date.now() - t0 };
}

const looksBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);

/** Read paths that listFiles just found (used by the context packer for the few files it keeps). */
export async function readSource(projectRoot: string, rel: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path.join(projectRoot, rel));
    if (looksBinary(buf)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** tsconfig.json is JSON with comments in it, and jsconfig.json is the same for JS projects. */
function stripJsonNoise(text: string): string {
  return text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("/") ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The project's own path aliases (tsconfig/jsconfig `paths` + `baseUrl`).
 *
 * Without this, an import of `@/lib/util` is indistinguishable from an import of `lodash`: it lands in the
 * "third-party surface" list and — worse — the edges that decide who breaks when a file changes are missing
 * from the graph, so `code_context`'s one hop never leaves the seed file in a repo that uses `@/` everywhere.
 * Only `paths` and `baseUrl` are read, from the shallowest config, and `extends` is not followed: this is a
 * path map, not a type checker, and anything it cannot see is reported as unresolved rather than guessed at.
 */
export async function readPathAliases(projectRoot: string, files: { path: string }[]): Promise<PathAlias[]> {
  const config = files
    .filter((f) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(f.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))[0];
  if (!config) return [];
  let raw: string;
  try {
    raw = await fs.readFile(path.join(projectRoot, config.path), "utf8");
  } catch {
    return [];
  }
  let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    parsed = JSON.parse(stripJsonNoise(raw)) as typeof parsed;
  } catch {
    return [];
  }
  const opts = parsed.compilerOptions ?? {};
  const dir = path.posix.dirname(config.path);
  const base = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, opts.baseUrl ?? ".")).replace(/^\.\//, "");
  return Object.entries(opts.paths ?? {})
    .filter(([pattern, targets]) => pattern.length > 0 && Array.isArray(targets) && targets.length > 0)
    // Most specific first: an exact pattern beats a wildcard, and a longer wildcard beats a shorter one.
    .map(([pattern, targets]) => ({ pattern, targets: targets.filter((t) => typeof t === "string"), base }))
    .sort((a, b) => (a.pattern.includes("*") ? 1 : 0) - (b.pattern.includes("*") ? 1 : 0) || b.pattern.length - a.pattern.length);
}

export async function scanRepo(projectRoot: string, opts: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now();
  const { files: list, notes } = await listFiles(projectRoot, opts);
  const files: FileIndex[] = [];
  const skipped: Skipped[] = [];
  const maxBytes = opts.maxFileKB * 1024;

  for (const rel of list) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(projectRoot, rel));
    } catch {
      skipped.push({ path: rel, reason: "not readable" });
      continue;
    }
    if (buf.length > maxBytes) {
      skipped.push({ path: rel, reason: `${Math.round(buf.length / 1024)} KB is over codebase.maxFileKB=${opts.maxFileKB}` });
      continue;
    }
    if (looksBinary(buf)) {
      skipped.push({ path: rel, reason: "binary" });
      continue;
    }
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const lang = langOf(rel);
    const minified = lines.some((l) => l.length > MINIFIED_LINE);
    if (minified && lang !== "json") skipped.push({ path: rel, reason: "minified (one very long line), symbols not extracted" });
    // One unreadable file must never cost the whole index: keep the file, drop its symbols, say why.
    let extracted = { symbols: [] as ReturnType<typeof extractSymbols>["symbols"], imports: [] as ReturnType<typeof extractSymbols>["imports"] };
    if (!(minified && lang !== "json")) {
      try {
        extracted = extractSymbols(text, lang, rel);
      } catch (e) {
        skipped.push({ path: rel, reason: `the lightweight extractor could not read it (${e instanceof Error ? e.message : String(e)})` });
      }
    }
    files.push({ path: rel, lang, bytes: buf.length, lines: lines.length, symbols: extracted.symbols, imports: extracted.imports });
  }

  return { root: projectRoot, files, skipped, notes, conventions: await conventionsFor(projectRoot, files), aliases: await readPathAliases(projectRoot, files), ms: Date.now() - t0 };
}

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.|smoke\/|(^|\/)test/i;

export function isTestPath(p: string): boolean {
  return TEST_PATH.test(p);
}

const FRAMEWORKS: [string, string[]][] = [
  ["next", ["next"]],
  ["react", ["react"]],
  ["vue", ["vue"]],
  ["svelte", ["svelte"]],
  ["vite", ["vite"]],
  ["express", ["express"]],
  ["fastify", ["fastify"]],
  ["hono", ["hono"]],
  ["mcp-sdk", ["@modelcontextprotocol/sdk"]],
  ["zod", ["zod"]],
  ["playwright", ["playwright", "@playwright/test"]],
  ["tailwind", ["tailwindcss"]],
  ["gsap", ["gsap"]],
];

async function conventionsFor(projectRoot: string, files: FileIndex[]): Promise<Conventions> {
  const read = async (rel: string) => {
    try {
      return await fs.readFile(path.join(projectRoot, rel), "utf8");
    } catch {
      return null;
    }
  };

  // The manifest is not always at the root (a repo's app can live in server/), so take the shallowest one
  // and report where it was: a digest that claims "no test script" about a repo that has one is a lie.
  const shallowest = (name: string) =>
    files
      .filter((f) => f.path === name || f.path.endsWith(`/${name}`))
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))[0]?.path ?? null;

  const manifestPath = shallowest("package.json");
  const tsPath = shallowest("tsconfig.json");
  const pkgRaw = manifestPath ? await read(manifestPath) : null;
  const tsconfig = tsPath ? await read(tsPath) : null;

  let packageName: string | null = null;
  let scripts: { name: string; command: string }[] = [];
  let deps: Record<string, string> = {};
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      packageName = pkg.name ?? null;
      scripts = Object.entries(pkg.scripts ?? {}).map(([n, command]) => ({ name: n, command }));
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      /* an unreadable package.json is reported by the project's own tests, not here */
    }
  }

  const lock = files.find((f) => /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json)$/.test(f.path));
  const packageManager = !lock ? null : /pnpm-lock/.test(lock.path) ? "pnpm" : /yarn\.lock/.test(lock.path) ? "yarn" : /bun\.lock/.test(lock.path) ? "bun" : "npm";
  const script = (n: string) => scripts.find((s) => s.name === n)?.command ?? null;
  const has = (n: string) => files.some((f) => new RegExp(`(^|/)${n}(\\.|$)`, "i").test(f.path));

  return {
    name: path.basename(projectRoot),
    manifestPath,
    manifestDir: manifestPath ? path.posix.dirname(manifestPath).replace(/^\.$/, "") : null,
    packageName,
    packageManager,
    scripts,
    test: script("test"),
    build: script("build"),
    lint: script("lint") ?? (has("eslint") || has(".eslintrc") ? "eslint is configured here" : null),
    dev: script("dev") ?? script("start"),
    typescript: !!tsPath || Object.keys(deps).includes("typescript"),
    tsStrict: !!tsconfig && /"strict"\s*:\s*true/.test(tsconfig),
    moduleSystem: /"type"\s*:\s*"module"/.test(pkgRaw ?? "") ? "esm" : tsconfig && /"module"\s*:\s*"(NodeNext|ESNext|ES2022)"/.test(tsconfig) ? "esm" : pkgRaw ? "cjs" : "unknown",
    frameworks: FRAMEWORKS.filter(([, pkgs]) => pkgs.some((p) => p in deps)).map(([n]) => n),
    tests: files.filter((f) => isTestPath(f.path)).map((f) => f.path).slice(0, 40),
    // Markdown only: a repo's own docs are its rules for working in it. The manifest is reported above.
    notes: await Promise.all(
      files
        .filter((f) => f.lang === "md")
        .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
        .slice(0, 12)
        .map(async (f) => {
          const text = (await read(f.path)) ?? "";
          const heading = text.split("\n").find((l) => l.trim().startsWith("#"))?.replace(/^#+\s*/, "").trim();
          return { path: f.path, heading: heading ?? "present" };
        })
    ),
  };
}
