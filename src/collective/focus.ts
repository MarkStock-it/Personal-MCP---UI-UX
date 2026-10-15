/**
 * The focus contract.
 *
 * The owner's requirement was blunt: the assistant should work on this codebase and nothing else, and
 * should stop inventing. A rule is only worth stating if something enforces or measures it, so each
 * clause here names the tool that carries it and the command that proves it. The conventions, commands
 * and rule files are read out of the repo, so a new project gets its own contract instead of a generic
 * lecture about good practice.
 */
import type { RepoIndex } from "../codebase/store.js";

export function renderFocusContract(index: RepoIndex, task?: string): string {
  const c = index.conventions;
  const gates = [c.test ? `\`${c.test}\`` : null, c.build ? `\`${c.build}\`` : null, c.lint ? `\`${c.lint}\`` : null].filter(Boolean) as string[];
  // Every top-level doc, not just the ones with famous names: a repo's own notes are its rules for working in it.
  const docs = c.notes.filter((n) => n.path.endsWith(".md"));
  return [
    `# Working in ${c.name}${task ? ` on: ${task}` : ""}`,
    `Scope: this repository only (${index.totals.files} files, ${index.totals.lines} lines indexed, root ${index.root}). Nothing outside it is yours to change.`,
    "",
    "## The contract",
    "1. Ground first, always. Read `code_digest` once per session, then `code_context { query }` for the specific area you are about to touch. Working from your memory of this repo is the failure mode this contract exists to prevent: the digest and the packs are computed from the files, your recollection is not.",
    "2. Every statement of fact about this code is a citation: `path:line`, and it must be checkable. Before you tell the owner something about their code, put it through `code_verify_cites`. A claim you cannot cite is a question, not a fact.",
    "3. Never invent a file, symbol, config key, script or dependency. If the digest does not list it and `code_context` did not return it, read the file — and if you still cannot find it, say \"not in the codebase\".",
    `4. Obey this project's own rules before your habits. Read in full: ${docs.length ? docs.map((r) => `${r.path} (${r.heading})`).join(", ") : "(no top-level documentation exists — say so rather than assuming conventions)"}.`,
    "5. Prefer the smallest change that makes the behaviour correct, inside the module that already owns that behaviour (see the map and the import graph).",
    "6. Prove it by running it. A change with no gate run is unfinished. This project's gates: " + (gates.length ? gates.join(", ") : "(none declared in package.json — that is itself a finding worth reporting)") + ".",
    "7. Report the difference between checked and assumed. \"I verified X by running Y\" and \"I did not check Z\" are both required; a summary that hides the second one is a defect.",
    "8. When the work splits into independent questions, do not do it serially in one head: `collective_plan` splits it, `collective_run` runs the copies in parallel, and the server checks every quote they make before you read their conclusions.",
    "",
    "## Stop conditions",
    "- The answer is not in the context: say so and name the file you would need. Do not fill the gap with a plausible guess.",
    "- The change would require touching something outside this repository, or widening the dependency surface: stop and ask.",
    "- The gates cannot be run in this environment: say which ones and why, and mark the work unverified rather than done.",
    "",
    "## What is available",
    `- commands${c.manifestDir ? ` (run inside ${c.manifestDir}/)` : ""}: ${c.scripts.map((s) => `${s.name} -> \`${s.command}\``).join(", ") || "none declared"}`,
    `- manifest: ${c.manifestPath ?? "no package.json found"}`,
    `- tests: ${c.tests.length ? c.tests.slice(0, 8).join(", ") : "no test files matched"}`,
    `- entry points: ${index.entryPoints.map((e) => e.path).join(", ") || "none identified"}`,
    `- most imported files (what your change can break): ${index.hotspots.slice(0, 6).map((h) => `${h.path} (${h.importedBy})`).join(", ") || "none"}`,
  ].join("\n");
}
