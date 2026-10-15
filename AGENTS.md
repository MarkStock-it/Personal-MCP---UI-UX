# design-mcp — agent notes

MCP server (stdio) that generates, tests and critiques anti-slop website designs, plus an offline
**design playbook** of curated knowledge for motion, colour, type, layout, material and quality floors.
Node >= 20, TypeScript, ESM. `dist/` is committed because the host runs `dist/index.js` directly.

## Verified commands
```bash
npm install
npm run build          # tsc -> dist/
npm test               # 57-check keyless stdio suite (smoke/smoke.mjs); no API keys needed
DESIGN_MCP_PROJECT_DIR=<dir> node smoke/call.mjs <tool> '[json]'   # call one tool
npm run inspect        # MCP inspector
npx tsx tools/lab/run.ts   # the memory experiment; see tools/lab/README.md (not a gate)
```
`npm test` is the gate: it asserts the tool/resource/prompt inventory, the playbook tools, the
deterministic checks and every graceful error path. It must be 57/57 before any change is called done.

## Map
- `src/index.ts` — the MCP surface: 15 generating/testing tools, 6 playbook tools, 11 `design://`
  resources, 2 prompts. Registered at the bottom; the playbook block is clearly marked.
- `src/playbook/` — the offline knowledge. `types.ts` is the contract (**read it before adding an entry**),
  `index.ts` is the registry/search/render, `check.ts` is deterministic maths (contrast, soft palettes,
  the anti-slop scanner). Topic modules: motion, scroll, organic, typography, color, layout, floor, rubric, slop.
- `src/rules.ts` — the original anti-default list and banned fonts. `src/playbook/slop.ts` builds on it;
  never duplicate those lists.
- `src/builder/`, `src/providers/`, `src/test/`, `src/critique`-side files (`concepts.ts`, `critic.ts`,
  `jobs.ts`, `brief.ts`) — the existing generate-and-test pipeline.
- `src/test/gates.ts` — the real automated gates. **Any threshold stated in `src/playbook/floor.ts` must
  match the numbers here and the budgets in `src/config.ts`.** If they disagree, fix the playbook.

## Scroll scenes (the one moment driven by scroll)
`sequence_extract` turns a local video into the asset a scroll scene needs: evenly sampled frames, a
poster still and a manifest in `.design-mcp/sequences/<name>/` (`src/builder/sequences.ts` + `src/util/ffmpeg.ts`).
`installSequences` copies every prepared sequence into each variation as `/sequences/<name>/` and tells the
builder about it, and the scaffold ships the consumer, `src/motion/sequence.tsx` (sticky viewport, frame
from scroll progress, poster underneath, decoded window of 10 frames). The builder prompt allows **one**
scene per site, only with a sequence from that list.
- ffmpeg is required. Encoders differ per build, so the format is chosen from what `ffmpeg -encoders`
  reports (libwebp → mjpeg → png) and recorded in the manifest; no WebP encoder means bigger frames, said
  out loud and fitted to the budget by lowering the long edge once.
- Gates: `sequenceGate` (static: frame count, naming, poster, poster existence, decoded-window MiB, bytes)
  and `scrollSceneGate` (runtime: the frame index actually advances with scroll, canvas drawn at device
  resolution, still present and described). Both are `perf`, so warnings unless `perf` is in `test.strictGroups`.
- Budgets live in `test.budgets` (`sequenceKB`, `sequenceFrames`, `sequenceDecodeWindowMB`) and the frame
  format defaults in `build.sequence`. Keep `DECODE_WINDOW` in `sequences.ts` in step with the AHEAD/BEHIND
  constants in the scaffolded component — the memory budget depends on them.
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
