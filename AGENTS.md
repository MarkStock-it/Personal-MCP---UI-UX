# design-mcp — agent notes

MCP server (stdio) that generates, tests and critiques anti-slop website designs, plus an offline
**design playbook** of curated knowledge for motion, colour, type, layout, material and quality floors.
Node >= 20, TypeScript, ESM. `dist/` is committed because the host runs `dist/index.js` directly.

## Verified commands
```bash
npm install
npm run build          # tsc -> dist/
npm test               # 50-check keyless stdio suite (smoke/smoke.mjs); no API keys needed
DESIGN_MCP_PROJECT_DIR=<dir> node smoke/call.mjs <tool> '[json]'   # call one tool
npm run inspect        # MCP inspector
npx tsx tools/lab/run.ts   # the memory experiment; see tools/lab/README.md (not a gate)
```
`npm test` is the gate: it asserts the tool/resource/prompt inventory, the playbook tools, the
deterministic checks and every graceful error path. It must be 50/50 before any change is called done.

## Map
- `src/index.ts` — the MCP surface: 14 generating/testing tools, 6 playbook tools, 10 `design://`
  resources, 2 prompts. Registered at the bottom; the playbook block is clearly marked.
- `src/playbook/` — the offline knowledge. `types.ts` is the contract (**read it before adding an entry**),
  `index.ts` is the registry/search/render, `check.ts` is deterministic maths (contrast, soft palettes,
  the anti-slop scanner). Topic modules: motion, organic, typography, color, layout, floor, rubric, slop.
- `src/rules.ts` — the original anti-default list and banned fonts. `src/playbook/slop.ts` builds on it;
  never duplicate those lists.
- `src/builder/`, `src/providers/`, `src/test/`, `src/critique`-side files (`concepts.ts`, `critic.ts`,
  `jobs.ts`, `brief.ts`) — the existing generate-and-test pipeline.
- `src/test/gates.ts` — the real automated gates. **Any threshold stated in `src/playbook/floor.ts` must
  match the numbers here and the budgets in `src/config.ts`.** If they disagree, fix the playbook.
- `tools/lab/` — an **experiment, not part of the MCP surface**: does a learned preference layer earn
  its place, and what would a session save by reading a digest instead of the notes? It reads the two
  repos, trains a tiny model offline, and prints numbers with intervals. Not covered by the smoke gate.
  Its README records the method, the results and the rule for when to delete the learner.

## Adding playbook knowledge
Every entry carries `sources` with a real URL, the exact licence name and a `change` note. Rules:
- Write **original prose**. Never paste or closely paraphrase a source.
- Cite-only (never adapt text): W3C/WAI (no derivatives permitted), MDN (CC BY-SA), Apple HIG,
  Microsoft Fluent 2, GSAP docs, Refactoring UI, Josh Comeau, easings.net (GPL-3.0).
- Safe to adapt with attribution: web.dev / Google developer docs (CC BY 4.0), Material Components and
  IBM Carbon repositories (Apache-2.0), Motion (MIT), Robert Penner's easing set (BSD-3-Clause/MIT).
- Prefer few, usable entries over a data dump. No duplication between entries or topics.

## Do not
- Do not commit `node_modules/` (it is gitignored; two packages were tracked historically — do not add more).
- Do not write to stdout in `src/index.ts` (it carries the protocol); use `console.error`.
- Do not weaken a smoke check to make a build pass.

## Related work
The blog this server is currently being used on lives in a sibling repo, `../Personal-Blog/`, and its
`handoff.md` is the cross-session memory for that work (this file is the pointer).
