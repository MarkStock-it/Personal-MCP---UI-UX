/**
 * The index, and the digest built from it.
 *
 * Why this exists: an assistant that reads whole files burns its context on code it does not need,
 * and an assistant that trusts its memory of a repo invents APIs that were never there. The index is
 * the third option — a description computed from the files themselves, small enough to always fit,
 * carrying real paths, real symbol names and real line numbers, so any claim can be checked against it
 * and anything it does not contain is reported as unknown instead of guessed.
 *
 * Everything here is deterministic: no model is involved, so the digest is the same text every time
 * for the same repo state, and two workers given the same digest cannot disagree about the repo map.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CodebaseConfig } from "../config.js";
import { assertUsableRoot } from "../project.js";
import { isTestPath, lightScan, scanRepo, type Conventions, type FileIndex, type PathAlias, type Skipped } from "./scan.js";
import { outline } from "./symbols.js";

export interface RepoIndex {
  /** 2 added the project's own path aliases. Bumping this retires older caches instead of reading them wrong. */
  version: 2;
  /**
   * The git-backed stamp this index was built under, when the tree was clean (see `quickStampFor`). Absent
   * on an index built from a dirty tree or outside git, which is why it is optional: no value means the
   * next read pays the per-file stamp, never that the cache is wrong.
   */
  quickStamp?: string;
  root: string;
  name: string;
  generatedAt: string;
  buildMs: number;
  stamp: string;
  conventions: Conventions;
  files: FileIndex[];
  skipped: Skipped[];
  notes: string[];
  totals: { files: number; lines: number; bytes: number; byLang: { lang: string; files: number; lines: number }[] };
  graph: Record<string, { imports: string[]; importedBy: string[] }>;
  externals: { spec: string; count: number }[];
  /** The project's tsconfig/jsconfig `paths`, as read. Import specs matching one of these are internal edges. */
  aliases: { pattern: string; targets: string[] }[];
  entryPoints: { path: string; why: string }[];
  hotspots: { path: string; importedBy: number }[];
}

/** Mirrors stateDir() from config, but rooted at whatever project we were handed (so it is testable). */
export const indexFile = (root: string) => path.join(root, ".design-mcp", "codebase", "index.json");

/** ~4 characters per token. An estimate, labelled as one everywhere it surfaces. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "when", "what", "why", "how", "does", "should", "must", "can", "not", "but", "all", "any", "our", "your", "its", "it's", "add", "fix", "make", "need", "want", "use", "using", "code", "file", "files"]);

export function termsOf(query: string): string[] {
  const raw = query.toLowerCase().split(/[^a-z0-9_.\-]+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    const clean = t.replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (clean.length < 3 || STOP.has(clean)) continue;
    if (!out.includes(clean)) out.push(clean);
    // `src/components/Hero.tsx` should also match on `hero`.
    if (clean.includes("/") || clean.includes(".")) {
      for (const part of clean.split(/[/.\-_]/)) if (part.length >= 3 && !out.includes(part)) out.push(part);
    }
  }
  return out.slice(0, 24);
}

export interface Ranked {
  path: string;
  score: number;
  why: string[];
  /** True only when a query TERM matched. Structural bonuses (hotspot, entry point, test) never set it, so
   * "did anything actually match this question?" stays answerable — and that answer is what the packer
   * reports when it hands back the repo's centre of gravity instead of pretending to understand. */
  matched: boolean;
}

/** Deterministic relevance of each file to the query terms. Used for the digest's focus and the packer. */
export function rankFiles(index: RepoIndex, terms: string[]): Ranked[] {
  const hotspots = new Map(index.hotspots.map((h) => [h.path, h.importedBy]));
  const entries = new Set(index.entryPoints.map((e) => e.path));
  return index.files
    .map((f) => {
      const lowPath = f.path.toLowerCase();
      const why: string[] = [];
      let score = 0;
      let matched = false;
      for (const t of terms) {
        if (lowPath.includes(t)) {
          score += 4;
          matched = true;
          why.push(`path:${t}`);
        }
        const sym = f.symbols.find((s) => s.name.toLowerCase().includes(t));
        if (sym) {
          score += 3;
          matched = true;
          why.push(`symbol:${sym.name}`);
        } else if (f.symbols.some((s) => (s.doc ?? "").toLowerCase().includes(t))) {
          score += 1;
          matched = true;
          why.push(`doc:${t}`);
        }
      }
      if (entries.has(f.path)) score += 1.5;
      if (hotspots.has(f.path)) score += Math.min(1.5, hotspots.get(f.path)! * 0.25);
      if (isTestPath(f.path)) score += 0.25;
      return { path: f.path, score, why: [...new Set(why)], matched };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Which real file a relative import points at. TypeScript's NodeNext style imports `"./util.js"` while the
 * file on disk is `util.ts`, so a `.js`-spelled specifier has to be tried as TypeScript source as well —
 * without this, half the edges in a modern TS repo are invisible and the graph lies about who uses what.
 * Bare specifiers go through the project's own `paths` map first (see aliasTargets): a tsconfig alias is a
 * real internal edge, and treating `@/lib/x` as a package is how a repo with aliases everywhere gets a graph
 * that says nothing about who uses what.
 */
const IMPORT_CANDIDATES = (spec: string): string[] => {
  const bases = [spec];
  const js = spec.match(/\.(js|mjs|cjs|jsx)$/);
  if (js) {
    const stem = spec.slice(0, -js[0].length);
    bases.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  return [...bases, ...bases.flatMap((b) => [`${b}.ts`, `${b}.tsx`, `${b}.js`, `${b}.jsx`, `${b}.mjs`, `${b}.cjs`, `${b}.json`, `${b}.css`, `${b}/index.ts`, `${b}/index.tsx`, `${b}/index.js`, `${b}/index.jsx`])];
};

/**
 * Where a bare specifier can live, according to the project's own `paths` map. First matching pattern wins,
 * because that is the order TypeScript resolves in, and the alias list is already sorted most-specific-first.
 */
export function aliasTargets(spec: string, aliases: { pattern: string; targets: string[]; base: string }[]): string[] {
  for (const a of aliases) {
    const star = a.pattern.indexOf("*");
    const join = (t: string) => path.posix.normalize(path.posix.join(a.base, t)).replace(/^\.\//, "");
    if (star < 0) {
      if (spec === a.pattern) return a.targets.map(join);
      continue;
    }
    const prefix = a.pattern.slice(0, star);
    const suffix = a.pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length) continue;
    const middle = spec.slice(prefix.length, spec.length - suffix.length);
    return a.targets.map((t) => join(t.replace("*", middle)));
  }
  return [];
}

function buildGraph(files: FileIndex[], aliases: PathAlias[] = []): { graph: RepoIndex["graph"]; externals: { spec: string; count: number }[] } {
  const known = new Set(files.map((f) => f.path));
  const graph: RepoIndex["graph"] = {};
  const ext = new Map<string, number>();
  for (const f of files) {
    const imports: string[] = [];
    for (const imp of f.imports) {
      if (!imp.spec.startsWith(".") && !imp.spec.startsWith("/")) {
        // `node:` builtins are the runtime, not a dependency: counting them as "third-party surface"
        // would tell the reader this project depends on the platform.
        if (imp.spec.startsWith("node:")) continue;
        const viaAlias = aliasTargets(imp.spec, aliases)
          .flatMap(IMPORT_CANDIDATES)
          .find((c) => known.has(c));
        if (viaAlias) imports.push(viaAlias);
        else ext.set(imp.spec, (ext.get(imp.spec) ?? 0) + 1);
        continue;
      }
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), imp.spec));
      const hit = IMPORT_CANDIDATES(base).find((c) => known.has(c));
      if (hit) imports.push(hit);
    }
    graph[f.path] = { imports: [...new Set(imports)], importedBy: [] };
  }
  for (const [from, g] of Object.entries(graph)) for (const to of g.imports) graph[to]?.importedBy.push(from);
  return {
    graph,
    externals: [...ext.entries()].map(([spec, count]) => ({ spec, count })).sort((a, b) => b.count - a.count || a.spec.localeCompare(b.spec)).slice(0, 24),
  };
}

function findEntryPoints(files: FileIndex[], conventions: Conventions): { path: string; why: string }[] {
  const out: { path: string; why: string }[] = [];
  const push = (p: string, why: string) => {
    if (p && files.some((f) => f.path === p) && !out.some((o) => o.path === p)) out.push({ path: p, why });
  };
  // A script runs from the directory that declares it, so `node src/server.js` in server/package.json
  // means server/src/server.js. Getting this wrong made every entry point vanish in this very repo.
  const dir = conventions.manifestDir ? `${conventions.manifestDir}/` : "";
  for (const s of conventions.scripts) {
    const m = s.command.match(/[\w./-]+\.(?:[cm]?[jt]sx?)/);
    if (m) push(`${dir}${m[0].replace(/^\.\//, "")}`, `the "${s.name}" script runs it`);
  }
  for (const p of ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "src/server.ts", "src/server.js", "src/app.ts", "src/app.js", "index.js", "server.js", "main.py", "app.py"]) {
    push(`${dir}${p}`, "conventional entry file name");
  }
  return out.slice(0, 6);
}

export async function buildIndex(projectRoot: string, cfg: CodebaseConfig, stamp: string): Promise<RepoIndex> {
  const scan = await scanRepo(projectRoot, cfg);
  const { graph, externals } = buildGraph(scan.files, scan.aliases);
  const byLangMap = new Map<string, { lang: string; files: number; lines: number }>();
  for (const f of scan.files) {
    const g = byLangMap.get(f.lang) ?? { lang: f.lang, files: 0, lines: 0 };
    g.files++;
    g.lines += f.lines;
    byLangMap.set(f.lang, g);
  }
  const hotspots = Object.entries(graph)
    .map(([p, g]) => ({ path: p, importedBy: g.importedBy.length }))
    .filter((h) => h.importedBy > 0)
    .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
    .slice(0, 12);
  return {
    version: 2,
    root: projectRoot,
    name: scan.conventions.name,
    generatedAt: new Date().toISOString(),
    buildMs: scan.ms,
    stamp,
    conventions: scan.conventions,
    files: scan.files,
    skipped: scan.skipped,
    notes: scan.notes,
    totals: {
      files: scan.files.length,
      lines: scan.files.reduce((n, f) => n + f.lines, 0),
      bytes: scan.files.reduce((n, f) => n + f.bytes, 0),
      byLang: [...byLangMap.values()].sort((a, b) => b.lines - a.lines),
    },
    graph,
    externals,
    aliases: scan.aliases.map((a) => ({ pattern: a.pattern, targets: a.targets })),
    entryPoints: findEntryPoints(scan.files, scan.conventions),
    hotspots,
  };
}

/** The cheap fingerprint that decides whether the cached index is still true. */
/** The config inputs that change which files are indexed. One definition, so the two stamps cannot drift. */
const configKey = (cfg: CodebaseConfig): string =>
  JSON.stringify({ roots: cfg.roots, maxFiles: cfg.maxFiles, maxFileKB: cfg.maxFileKB, ignore: [...cfg.ignore].sort() });

export async function stampFor(projectRoot: string, cfg: CodebaseConfig): Promise<{ stamp: string; ms: number; note?: string }> {
  const light = await lightScan(projectRoot, cfg);
  const h = crypto.createHash("sha1");
  h.update(configKey(cfg));
  for (const e of light.entries) h.update(`${e.path}:${e.bytes}:${e.mtimeMs}\n`);
  return { stamp: h.digest("hex").slice(0, 16), ms: light.ms, note: light.note };
}

/** One `git` invocation, no shell, combined output only when it succeeded. */
const gitOut = (cwd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 8000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });

/**
 * Whether git has been told to look away from any file: `assume-unchanged` (lowercase flag) and
 * `skip-worktree` (`S`) both hide an edit from `git status` completely. A repo with one of those has a
 * clean-looking tree that can still differ from the index, so it gets no git stamp at all — the stat pass
 * is the only thing that would notice, and it is what pays for this honesty. Checked when a stamp is
 * recorded, never on the fast read, so the common path stays two spawns.
 */
const gitHidesChanges = async (cwd: string): Promise<boolean> => {
  const listing = await gitOut(cwd, ["ls-files", "-v"]);
  if (listing === null) return true; // unknown means untrusted: fall back to the stat pass
  return listing.split("\n").some((line) => /^[a-z]/.test(line) || /^S /.test(line));
};

export interface QuickStamp {
  stamp: string;
  ms: number;
}

/**
 * A cheap, git-backed answer to "has anything in the tree moved?" — two spawns instead of one stat per file.
 *
 * The restriction is the design: it is offered only for a CLEAN tree. `git status` says which paths differ,
 * not what they now contain, so two different edits to the same file produce the same status line, and a
 * cache verified by that question could serve stale bytes for as long as the tree stayed dirty. A clean
 * tree at an unchanged HEAD is the opposite: it is the same statement as "every indexed file still has the
 * bytes it had", because the index is built from exactly the set git tracks plus the untracked files git
 * would list. No commits, no git, a dirty tree, or a failing git all return null, and the caller falls back
 * to the per-file stamp — never worse than before, and never wrong.
 *
 * Measured on a 4000-file repo: ~35 ms here against ~320 ms for the stat pass, which is why `getIndex`
 * consults it only above `codebase.gitStampMinFiles` files and leaves small repos on the cheaper path.
 */
export async function quickStampFor(projectRoot: string, cfg: CodebaseConfig): Promise<QuickStamp | null> {
  const t0 = Date.now();
  const head = await gitOut(projectRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head === null) return null;
  // The server's own state dir is never indexed (it is in the default ignore list), so it must not be able
  // to report the tree dirty forever — a project that does not gitignore .design-mcp/ would otherwise never
  // reach the fast path. Untracked directories collapsed to one entry are enough: any entry at all means
  // "dirty" here, and the per-file stamp decides what to do about it.
  const status = await gitOut(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", ":(exclude).design-mcp"]);
  if (status === null || status !== "") return null;
  const h = crypto.createHash("sha1");
  h.update(head.trim());
  h.update("|");
  h.update(configKey(cfg));
  return { stamp: h.digest("hex").slice(0, 16), ms: Date.now() - t0 };
}

export interface LoadedIndex {
  index: RepoIndex;
  cached: boolean;
  stampMs: number;
  /** How the cache was justified: git said the tree is clean, the per-file stamp agreed, or it was rebuilt. */
  via: "quick" | "stat" | "build";
}

/**
 * The cached index. Copying it fresh is only done when the files changed (path, size or mtime), so a
 * repeated question about an unchanged repo costs one stat pass and no reads.
 */
const writeIndexCache = async (projectRoot: string, index: RepoIndex): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(indexFile(projectRoot)), { recursive: true });
    await fs.writeFile(indexFile(projectRoot), JSON.stringify(index));
  } catch {
    /* a read-only project is not a reason to fail the question */
  }
};

/**
 * The cached index. Verification is ordered cheapest-first: git's own answer for a clean tree (two spawns),
 * then the per-file stamp (a stat per indexed file) for anything git declines to vouch for, and a rebuild
 * only when the bytes really moved. The order matters because every tool in this server reads through here.
 */
export async function getIndex(projectRoot: string, cfg: CodebaseConfig, opts: { refresh?: boolean } = {}): Promise<LoadedIndex> {
  // Every tool that reads this repo comes through here, so this is the one place the "is that even a project?"
  // refusal has to live. A home folder indexed as a repo is worse than an error: it is 2,900 plausible
  // citations from the wrong tree, and every one of them looks like an answer.
  assertUsableRoot(projectRoot);
  let precise: { stamp: string; ms: number } | null = null;
  const preciseStamp = async () => (precise ??= await stampFor(projectRoot, cfg));

  if (!opts.refresh) {
    let cached: RepoIndex | null = null;
    try {
      cached = JSON.parse(await fs.readFile(indexFile(projectRoot), "utf8")) as RepoIndex;
    } catch {
      /* no usable cache */
    }
    if (cached && cached.version === 2) {
      // Above the threshold the stat pass is the expensive part, so ask git first. Below it, spawning git
      // twice costs more than statting a few hundred files, and the cheap path stays the only path.
      const quick = cached.files.length >= cfg.gitStampMinFiles ? await quickStampFor(projectRoot, cfg) : null;
      if (quick && cached.quickStamp === quick.stamp) return { index: cached, cached: true, stampMs: quick.ms, via: "quick" };
      const { stamp, ms } = await preciseStamp();
      if (cached.stamp === stamp) {
        // The per-file stamp agreed, so this cache is good. Record the git stamp now if the tree is clean, so
        // the next read can skip this pass entirely.
        if (quick && cached.quickStamp !== quick.stamp && !(await gitHidesChanges(projectRoot))) {
          cached.quickStamp = quick.stamp;
          await writeIndexCache(projectRoot, cached);
        }
        return { index: cached, cached: true, stampMs: ms, via: "stat" };
      }
    }
  }

  const { stamp, ms } = await preciseStamp();
  const index = await buildIndex(projectRoot, cfg, stamp);
  const quick = await quickStampFor(projectRoot, cfg);
  if (quick && !(await gitHidesChanges(projectRoot))) index.quickStamp = quick.stamp;
  await writeIndexCache(projectRoot, index);
  return { index, cached: false, stampMs: ms, via: "build" };
}

const kb = (n: number) => Math.round(n / 1024);

export function summarizeIndex(loaded: LoadedIndex): string {
  const { index, cached } = loaded;
  const syms = index.files.reduce((n, f) => n + f.symbols.filter((s) => s.exported).length, 0);
  const ago = Math.round((Date.now() - Date.parse(index.generatedAt)) / 1000);
  return [
    `${index.name}: ${index.totals.files} files, ${index.totals.lines} lines, ${syms} exported symbols (${index.totals.byLang.map((l) => `${l.lang} ${l.files}`).join(", ")})`,
    cached
      ? `index reused (verified unchanged ${ago}s ago${loaded.via === "quick" ? " by git, without a stat per file" : ""}, ${index.buildMs} ms to build it the first time)`
      : `index built in ${index.buildMs} ms`,
    ...index.notes.map((n) => `note: ${n}`),
  ].join("\n");
}

export interface DigestOptions { tokens: number; focus?: string }

/**
 * The compact map. Sections are ordered by how much they change a decision, and the tail is dropped
 * (with the drop reported) rather than truncated mid-sentence.
 */
export function renderDigest(index: RepoIndex, opts: DigestOptions): string {
  const terms = opts.focus ? termsOf(opts.focus) : [];
  const ranked = terms.length ? rankFiles(index, terms) : [];
  const rankOf = new Map(ranked.map((r, i) => [r.path, i]));

  const order = index.files
    .slice()
    .sort((a, b) => {
      if (terms.length) return (rankOf.get(a.path) ?? 999) - (rankOf.get(b.path) ?? 999);
      const hot = new Map(index.hotspots.map((h) => [h.path, h.importedBy]));
      return (hot.get(b.path) ?? 0) - (hot.get(a.path) ?? 0) || b.lines - a.lines;
    })
    .filter((f) => f.symbols.some((s) => s.exported) || isTestPath(f.path));

  const head = [
    `# ${index.name} — codebase digest`,
    `${index.totals.files} files, ${index.totals.lines} lines, ${kb(index.totals.bytes)} KB, ${index.totals.byLang.map((l) => `${l.lang} ${l.files}`).join(" / ")}`,
    `Everything below is computed from the files at ${index.root}. If something is not listed, it is not known — read the file, do not assume.`,
    "",
    "## How this project is built and run",
    `stack: ${[index.conventions.typescript ? `typescript${index.conventions.tsStrict ? " (strict)" : ""}` : null, index.conventions.moduleSystem, index.conventions.packageManager, ...index.conventions.frameworks].filter(Boolean).join(", ") || "unknown"}`,
    index.conventions.manifestPath ? `manifest: ${index.conventions.manifestPath}${index.conventions.packageName ? ` (${index.conventions.packageName})` : ""}` : "manifest: no package.json anywhere in the indexed files",
    ...index.conventions.scripts.slice(0, 8).map((s) => `run${index.conventions.manifestDir ? ` (in ${index.conventions.manifestDir}/)` : ""}: ${s.name} -> \`${s.command}\``),
    index.conventions.test ? "" : "warning: the nearest package.json declares no test script",
    "",
    "## The project's own rules (read these files in full before changing behaviour)",
    ...index.conventions.notes.map((n) => `- ${n.path} — ${n.heading}`),
    ...(index.entryPoints.length ? ["", "## Entry points", ...index.entryPoints.map((e) => `- ${e.path} — ${e.why}`)] : []),
    ...(index.hotspots.length ? ["", "## Most imported (change these carefully)", ...index.hotspots.slice(0, 8).map((h) => `- ${h.path} — imported by ${h.importedBy}`)] : []),
    ...(index.conventions.tests.length
      ? ["", "## Tests", `- ${index.conventions.tests.slice(0, 8).join("\n- ")}${index.conventions.tests.length > 8 ? `\n- ... and ${index.conventions.tests.length - 8} more` : ""}`]
      : []),
    ...(index.aliases?.length ? ["", "## Path aliases the project declared", `- ${index.aliases.map((a) => `${a.pattern} → ${a.targets.join(", ")}`).join(", ")} (resolved, so these edges are internal)`] : []),
    ...(index.externals.length ? ["", "## Third-party surface", `- ${index.externals.slice(0, 10).map((e) => `${e.spec} ×${e.count}`).join(", ")}`] : []),
    "",
    "## Map (line numbers are real; use them for citations)",
  ];

  const budget = opts.tokens;
  const TAIL_ALLOWANCE = 70; // tokens for the closing lines, so the total honours the budget
  const map: string[] = [];
  const dropped: string[] = [];
  const roomForMap = budget - estimateTokens(head.join("\n")) - TAIL_ALLOWANCE;
  if (roomForMap < 80) {
    // Be loud about it rather than quietly handing back more tokens than the caller budgeted for.
    head.push(`note: the sections above (commands, rule files, entry points, tests, third-party surface) already fill the ${budget}-token budget, so no per-file map is included. Raise codebase.digestTokens to see it.`);
  }
  let used = 0;
  for (const f of order) {
    const syms = outline(f.symbols.filter((s) => s.exported || s.kind === "heading" || s.kind === "key"), { exportedOnly: true }).slice(0, 12);
    const block = [`### ${f.path}${isTestPath(f.path) ? "  (test)" : ""} — ${f.lines} lines`, ...syms.map((s) => `   ${s}`)];
    const cost = estimateTokens(block.join("\n"));
    if (used + cost > Math.max(0, roomForMap)) {
      dropped.push(f.path);
      continue;
    }
    used += cost;
    map.push(...block);
  }

  const tail = [
    ...(dropped.length ? ["", `${dropped.length} more files did not fit the ${budget}-token budget: ${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", ..." : ""}`] : []),
    ...(index.skipped.length ? ["", `${index.skipped.length} files were skipped by the index: ${index.skipped.slice(0, 6).map((s) => `${s.path} (${s.reason})`).join("; ")}`] : []),
    "",
    `digest ~${estimateTokens([...head, ...map].join("\n"))} tokens (budget ${budget}, estimate at ~4 chars/token).`,
    estimateTokens([...head, ...map].join("\n")) > budget
      ? `This one is over budget: the fixed sections (how it runs, its rule files, tests, third-party surface) are kept whole on purpose because they change decisions. Raise codebase.digestTokens, or narrow codebase.ignore/roots, to fit the file map in as well.`
      : "Symbol lines come from lightweight extraction, not a type checker: treat a missing symbol as unknown, not as absent.",
  ];
  return [...head, ...map, ...tail].join("\n");
}

/** The whole file/symbol map, for hosts that want the detail without the source. */
export function renderMap(index: RepoIndex, focus?: string): string {
  const terms = focus ? termsOf(focus) : [];
  const ranked = terms.length ? rankFiles(index, terms) : [];
  const rankOf = new Map(ranked.map((r, i) => [r.path, i]));
  const files = index.files.slice().sort((a, b) => (terms.length ? (rankOf.get(a.path) ?? 999) - (rankOf.get(b.path) ?? 999) : a.path.localeCompare(b.path)));
  return [
    `# ${index.name} — file and symbol map (${index.totals.files} files)`,
    "",
    ...files.map((f) => {
      const syms = outline(f.symbols, { exportedOnly: false }).slice(0, 40);
      return [`## ${f.path} (${f.lang}, ${f.lines} lines)`, ...syms.map((s) => `   ${s}`)].join("\n");
    }),
  ].join("\n");
}

export function renderGraph(index: RepoIndex): string {
  const rows = Object.entries(index.graph).filter(([, g]) => g.imports.length || g.importedBy.length);
  return [
    `# ${index.name} — import graph (relative imports, plus bare specifiers the project's own tsconfig \`paths\` map resolved; everything else is listed as third-party)`,
    ...(index.aliases?.length ? [`aliases in force: ${index.aliases.map((a) => `${a.pattern} → ${a.targets.join(", ")}`).join(", ")}`] : []),
    "",
    ...rows.map(([p, g]) => `- ${p}\n    imports: ${g.imports.join(", ") || "(none)"}\n    imported by: ${g.importedBy.join(", ") || "(nobody)"}`),
    "",
    "## Third-party packages actually imported",
    ...index.externals.map((e) => `- ${e.spec} — used ${e.count}×`),
  ].join("\n");
}

export function renderConventions(index: RepoIndex): string {
  const c = index.conventions;
  return [
    `# ${c.name} — how this project is actually built`,
    "",
    `- typescript: ${c.typescript ? "yes" : "no"}${c.tsStrict ? " (strict: true in tsconfig)" : ""}`,
    `- module system: ${c.moduleSystem}`,
    `- package manager: ${c.packageManager ?? "unknown (no lockfile found)"}`,
    `- manifest: ${c.manifestPath ?? "none found"}${c.packageName ? ` — ${c.packageName}` : ""}`,
    `- frameworks/libraries in package.json: ${c.frameworks.join(", ") || "none detected"}`,
    `- commands${c.manifestDir ? ` (run inside ${c.manifestDir}/)` : " (run at the repo root)"}: ${c.scripts.map((s) => `${s.name}=\`${s.command}\``).join(", ") || "none"}`,
    `- tests: ${c.tests.join(", ") || "no test files matched"}`,
    "",
    "## Notes and rule files",
    ...c.notes.map((n) => `- ${n.path} — ${n.heading}`),
    "",
    "## Everything the index skipped",
    ...(index.skipped.length ? index.skipped.map((s) => `- ${s.path} — ${s.reason}`) : ["- (nothing)"]),
  ].join("\n");
}
