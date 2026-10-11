import fs from "node:fs/promises";
import path from "node:path";

export interface ParsedFile { path: string; content: string }

const START = /^===\s*FILE:\s*(.+?)\s*===\s*$/;
const END = /^===\s*END FILE\s*===\s*$/;

function clean(lines: string[]): string {
  let t = lines.join("\n").trim();
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1];
  return t + "\n";
}

/** Parse "=== FILE: path === ... === END FILE ===" blocks. Safer than JSON for code. */
export function parseFileBlocks(text: string): { files: ParsedFile[]; unterminated: string | null } {
  const files: ParsedFile[] = [];
  let unterminated: string | null = null;
  let cur: { path: string; lines: string[] } | null = null;

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const start = line.match(START);
    if (!cur) {
      if (start) cur = { path: start[1].trim(), lines: [] };
      continue;
    }
    if (END.test(line)) {
      files.push({ path: cur.path, content: clean(cur.lines) });
      cur = null;
    } else if (start) {
      unterminated = cur.path; // previous block never closed: don't trust it
      cur = { path: start[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur) unterminated = cur.path;
  return { files, unterminated };
}

const ALLOWED_EXT = /\.(tsx?|jsx?|css|svg|json|md|txt|html)$/i;

/** Returns a clean relative path, or null if it is unsafe or not an allowed file type. */
export function safeRel(p: string): string | null {
  const n = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split("/");
  if (parts.some((s) => s === "" || s === ".." || s === "node_modules" || s.startsWith(".git"))) return null;
  return ALLOWED_EXT.test(n) ? n : null;
}

export async function writeFiles(root: string, files: ParsedFile[]): Promise<void> {
  for (const f of files) {
    const rel = safeRel(f.path);
    if (!rel) throw new Error(`Refusing to write unsafe path: ${f.path}`);
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`Path escapes variation folder: ${f.path}`);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.content);
  }
}

export const exportLines = (content: string) =>
  content.split("\n").filter((l) => /^export\s/.test(l)).join("\n");
