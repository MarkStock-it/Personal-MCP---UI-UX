/**
 * Who declares a name, and who uses it.
 *
 * The index could say what a file declares and which files import it. It could not answer the two
 * questions that decide whether a change is safe: *what calls this?* and *what has to move with it?* A
 * file-level import graph answers neither — a file that imports `format.ts` may use one export out of five,
 * and a file that never imports it can still name the symbol in a comment, a test title or a string. So a
 * rename sweep built on the import graph is either too big (every importer) or wrong (a caller reached by a
 * re-export), and the edit gate's impact line had the same blind spot.
 *
 * This is a word-boundary text scan over the indexed files, and it is deliberately not sold as more than
 * that. Language servers answer this properly through a *find references* request, and that interface is
 * worth copying — but an LSP server is language- and setup-dependent and, by its own specification, offers
 * no guarantee that dynamic or reflective uses appear
 * (https://github.com/Microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md).
 * What a text scan gives up is precision: a match inside a comment or a string literal counts, and a
 * same-named local in an unrelated file counts. What it gives back is completeness over the whole repo with
 * no build, no language server and no model — which is the right trade for the two jobs it is used for here:
 * showing a reader every place a name appears so they can judge, and giving a rename its full candidate
 * surface instead of a guess. The reading is left to the reader, and the report says so.
 *
 * Two callers:
 *   - `code_refs { name }` scans every indexed file: declarations with their kind and export status, and
 *     every use with its file and line, ordered so the declaration comes first.
 *   - The edit gate uses the bounded form (`only`) on one surface — the declaring file and the files that
 *     import it — because that is exactly what a rename has to sweep, and it stays cheap inside a mission.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isCode, type Lang } from "./symbols.js";
import type { RepoIndex } from "./store.js";
import { pLimit } from "../util/limit.js";

export interface Reference {
  path: string;
  line: number;
  /** The line as it is, trimmed and shortened: a reader can tell a call from a mention, a scan cannot. */
  text: string;
  /** True when the file's own symbol table says a declaration of this name starts on this line. */
  declaration: boolean;
  /** For a declaration: whether it is exported, and what kind of thing it is. */
  exported?: boolean;
  kind?: string;
  /** The file's language, so a mention in a document can be told from a call in code. */
  lang?: string;
}

export interface ReferenceReport {
  name: string;
  declarations: Reference[];
  uses: Reference[];
  /** Files that mention the name at all, most-mentioned first. */
  files: { path: string; declarations: number; uses: number }[];
  /** Files actually read, and files the scan could not read. */
  scanned: number;
  unreadable: string[];
  /** True when a cap stopped the scan: the report is then a prefix, and says which cap bit. */
  truncated: string[];
  notes: string[];
  ms: number;
}

export interface ReferenceInput {
  projectRoot: string;
  index: RepoIndex;
  name: string;
  /** Restrict the scan to these paths (the edit gate's rename surface). Default: every indexed file. */
  only?: string[];
  /** Shared with the citation and edit gates, so a file read once is not read again. */
  cache?: Map<string, string | null>;
  /** Bytes of source to read before stopping. Defaults to 32 MB, which covers a large repo. */
  budgetBytes?: number;
  /** Uses recorded per file before the rest are counted but not quoted. Defaults to 20. */
  maxPerFile?: number;
  /** How many files to read at once. Defaults to 8. */
  concurrency?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A plain identifier is matched on word boundaries; anything else is matched as literal text. */
const matcherFor = (name: string): RegExp =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(name)}(?![A-Za-z0-9_$])`, "g") : new RegExp(escapeRe(name), "g");

export function refsInText(text: string, name: string, symbols: { name: string; line: number; kind: string; exported: boolean }[]): Reference[] {
  const re = matcherFor(name);
  // Only a symbol with THIS name makes a line a declaration. A line that declares something else and uses
  // this name is a use, and confusing the two would hide the very call sites the report exists to show.
  const byLine = new Map(symbols.filter((s) => s.name === name).map((s) => [s.line, s]));
  const out: Reference[] = [];
  text.split("\n").forEach((raw, i) => {
    re.lastIndex = 0;
    if (!re.test(raw)) return;
    const decl = byLine.get(i + 1);
    out.push({ path: "", line: i + 1, text: raw.trim().slice(0, 160), declaration: !!decl, exported: decl?.exported, kind: decl?.kind });
  });
  return out;
}

/**
 * The files a rename has to consider for one name: where it is declared, plus everything that imports those
 * files. Deterministic, from the index's own graph, and small — which is why the edit gate can afford it
 * inside a mission while the full `code_refs` scan stays a deliberate, user-started call.
 */
export function referenceSurface(index: RepoIndex, name: string, cap = 24): { files: string[]; declaredIn: string[] } {
  const declaredIn = index.files.filter((f) => f.symbols.some((s) => s.name === name)).map((f) => f.path);
  const files = new Set(declaredIn);
  for (const p of declaredIn) for (const importer of index.graph[p]?.importedBy ?? []) files.add(importer);
  return { files: [...files].sort().slice(0, cap), declaredIn };
}

export async function findReferences(input: ReferenceInput): Promise<ReferenceReport> {
  const t0 = Date.now();
  const root = path.resolve(input.projectRoot);
  const cache = input.cache ?? new Map<string, string | null>();
  const maxPerFile = input.maxPerFile ?? 20;
  const budget = input.budgetBytes ?? 32 * 1024 * 1024;
  const truncated: string[] = [];
  const notes: string[] = [];
  const name = input.name.trim();
  // With `only` the caller has already decided the surface (the edit gate does); otherwise it is every
  // indexed file, in index order so two runs on one repo produce the same report.
  const wanted = input.only ? [...new Set(input.only)].sort() : input.index.files.map((f) => f.path);
  const byPath = new Map(input.index.files.map((f) => [f.path, f]));

  const unreadable: string[] = [];
  let bytes = 0;
  let scanned = 0;
  const declarations: Reference[] = [];
  const uses: Reference[] = [];
  const fileCounts = new Map<string, { path: string; declarations: number; uses: number }>();
  const limit = pLimit(Math.max(1, input.concurrency ?? 8));

  await Promise.all(
    wanted.map((rel) =>
      limit(async () => {
        if (bytes > budget) return;
        let text: string | null;
        if (cache.has(rel)) text = cache.get(rel)!;
        else {
          try {
            text = await fs.readFile(path.join(root, rel), "utf8");
          } catch {
            text = null;
          }
          cache.set(rel, text);
        }
        if (text === null) {
          unreadable.push(rel);
          return;
        }
        bytes += Buffer.byteLength(text, "utf8");
        scanned++;
        const file = byPath.get(rel);
        const hits = refsInText(text, name, file?.symbols ?? []);
        if (!hits.length) return;
        let quoted = 0;
        for (const h of hits) {
          const ref = { ...h, path: rel, lang: file?.lang };
          if (ref.declaration) declarations.push(ref);
          else if (quoted < maxPerFile) {
            uses.push(ref);
            quoted++;
          }
          const entry = fileCounts.get(rel) ?? { path: rel, declarations: 0, uses: 0 };
          if (ref.declaration) entry.declarations++;
          else entry.uses++;
          fileCounts.set(rel, entry);
        }
        if (hits.filter((h) => !h.declaration).length > maxPerFile) {
          if (!truncated.some((t) => t.startsWith("per-file"))) truncated.push(`per-file cap (${maxPerFile} uses quoted per file)`);
        }
      })
    )
  );

  if (bytes > budget) truncated.push(`byte budget (${Math.round(budget / 1024 / 1024)} MB of source read)`);
  if (input.only) notes.push(`scanned the rename surface only: ${wanted.length} file(s) where this name is declared or which import a file that declares it`);
  notes.push("Text scan, not a type checker: a match inside a comment, a string or a same-named local counts, and a name reached dynamically is invisible. Read the lines before acting on them.");

  // Code first, prose last, and each file's own count: a reader looking for call sites should not have to
  // wade through the documentation that mentions the name.
  const prose = (p: string) => !fileIsCode(byPath.get(p)?.lang);
  const files = [...fileCounts.values()].sort(
    (a, b) => Number(prose(a.path)) - Number(prose(b.path)) || b.uses + b.declarations - (a.uses + a.declarations) || a.path.localeCompare(b.path)
  );
  declarations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  uses.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { name, declarations, uses, files, scanned, unreadable, truncated, notes, ms: Date.now() - t0 };
}

const fileIsCode = (lang?: string): boolean => (lang ? isCode(lang as Lang) : true);

export function renderReferences(r: ReferenceReport, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 40;
  const lines = [
    `# References to \`${r.name}\``,
    `${r.declarations.length} declaration(s), ${r.uses.length} use(s) quoted across ${r.files.length} file(s); ${r.scanned} file(s) scanned in ${r.ms} ms, no model involved.`,
  ];
  if (!r.declarations.length && !r.uses.length) {
    lines.push("", `Nothing in the indexed files mentions \`${r.name}\` on a word boundary. Either the name is spelled differently here, or it does not exist in this project — say which rather than assuming it does.`);
    if (r.unreadable.length) lines.push(`(${r.unreadable.length} file(s) could not be read: ${r.unreadable.slice(0, 6).join(", ")})`);
    return lines.join("\n");
  }
  if (r.declarations.length) {
    lines.push("", "## Declared here");
    for (const d of r.declarations) {
      lines.push(`- ${d.path}:${d.line} — ${d.exported ? "exported " : "local "}${d.kind ?? "symbol"}${d.exported ? "" : " (not exported: a rename cannot break importers, but a same-file use can)"}`, `    ${d.text}`);
    }
  } else {
    lines.push("", `No indexed file declares \`${r.name}\` (this project may declare it somewhere the index skipped, or the name may come from a dependency). It is used for real, so treat it as external until you find the definition.`);
  }
  // Code uses first so the call sites are at the top; a mention in a document is still reported, labelled.
  const ordered = [...r.uses].sort((a, b) => Number(!fileIsCode(a.lang)) - Number(!fileIsCode(b.lang)) || a.path.localeCompare(b.path) || a.line - b.line);
  const shown = ordered.slice(0, limit);
  if (shown.length) {
    lines.push("", `## Used here (${r.uses.length} use(s)${r.uses.length > shown.length ? `, first ${shown.length} shown` : ""})`);
    let current = "";
    for (const u of shown) {
      if (u.path !== current) {
        current = u.path;
        lines.push(`- ${u.path}${fileIsCode(u.lang) ? "" : " (prose file: a mention, not a call — do not treat it as a caller)"}`);
      }
      lines.push(`    ${u.line}: ${u.text}`);
    }
  } else if (r.declarations.length) {
    lines.push("", "Nothing else in the indexed files uses it: it is declared and never referenced, which is itself worth knowing before you change it.");
  }
  if (r.files.length) {
    const extra = r.files.length > 8 ? ` (and ${r.files.length - 8} more)` : "";
    lines.push("", `Files that mention it${extra}: ${r.files.slice(0, 8).map((f) => `${f.path} (${f.declarations} declared, ${f.uses} used)`).join(", ")}`);
  }
  if (r.truncated.length) lines.push("", `This list is a prefix, not the whole truth: stopped by the ${r.truncated.join(" and ")}. Raise the cap if a sweep has to be complete.`);
  if (r.unreadable.length) lines.push(`- ${r.unreadable.length} file(s) could not be read and were not scanned: ${r.unreadable.slice(0, 6).join(", ")}`);
  lines.push("", ...r.notes.map((n) => `- ${n}`), "- Files the index skipped (binary, minified, over the size cap, or outside the configured roots) were not scanned at all. The index's own skip list names them.");
  return lines.join("\n");
}
