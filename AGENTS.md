# design-mcp — agent notes

MCP server (stdio) that generates, tests and critiques anti-slop website designs, plus an offline
**design playbook** of curated knowledge for motion, colour, type, layout, material and quality floors.
Node >= 20, TypeScript, ESM. `dist/` is committed because the host runs `dist/index.js` directly.

## Verified commands
```bash
npm install
npm run build          # tsc -> dist/
npm test               # 159-check keyless stdio suite (smoke/smoke.mjs); no API keys needed
DESIGN_MCP_PROJECT_DIR=<dir> node smoke/call.mjs <tool> '[json]'   # call one tool
npm run inspect        # MCP inspector
npx tsx tools/lab/run.ts   # the memory experiment; see tools/lab/README.md (not a gate)
```
`npm test` is the gate: it asserts the tool/resource/prompt inventory, the playbook tools, the
deterministic checks, the codebase layer against a fixture repo, two whole collective missions (driven by a
stub host that answers sampling, including one deliberately invented quote that must be rejected, an
unevidenced rebuttal that must be labelled unproven, and a memory entry whose code changes and must retire
itself), the session greeting and the skills layer (a fixture SKILL.md that must be found, read, and pasted
into exactly the worker that was assigned it), the session-block installer (idempotent, and it must not
touch text outside its markers), and every graceful error path. It must be 159/159 before any change is
called done.

## Map
- `src/index.ts` — the MCP surface: 15 generating/testing tools, 6 playbook tools, 8 codebase/collective
  tools (code_index, code_digest, code_context, code_verify_cites, collective_plan, collective_run,
  collective_report, collective_memory), 4 session/skill tools (collective_hello, collective_install,
  skills_list, skills_read), 11 `design://` + 7 `code://` resources, 5 prompts. Registered at
  the bottom; the codebase and collective blocks are clearly marked. The smoke suite asserts these counts,
  so adding a tool means updating it as well as this line.
- `src/codebase/` — ground truth about the repo, computed from the files, no model involved. `symbols.ts`
  extracts declarations and imports (**read the header before changing it**: line-oriented comment
  stripping and span rules exist because two real bugs came from getting them wrong), `scan.ts` lists and
  reads files (git ls-files so `.gitignore` decides, walk otherwise) and detects conventions, `store.ts`
  is the cached index + digest/map/graph/conventions renderers, `pack.ts` turns a question into
token-budgeted source slices with the file's own line numbers.
- `src/collective/` — the multi-agent layer. `roles.ts` holds the contracts and prompts (the citation
  contract lives there and is repeated to every worker), `ask.ts` is one schema-checked model call with a
  single repair round, `verify.ts` re-reads every quote and is the only thing allowed to call a claim
  true, `run.ts` is the mission loop and the dossier, `focus.ts` is the ground-rules brief.
  `personas.ts` gives each seat a stance and a voice (Scout/Mason/Wrench/Thorn/Judge, Keystone leads —
  prompt interventions that change what gets said, not independent minds), `peer.ts` is round two where the
  copies read each other's **verified** findings and must answer with evidence, and `memory.ts` is what
  survives between missions. `hello.ts` is the session greeting ("Hello collective.": one pass, no model,
  ~150 ms, and it must stay that cheap because it runs at the top of every session) and `install.ts` writes
  the marked block that tells a host to call it.
- `src/skills/` — the owner's installed SKILL.md collections: discovery under the configured roots (a
  duplicate name is one skill, with the extra copies named), front-matter parsing, and reading one into a
  prompt. **It never executes anything a skill suggests**, and skill text is never evidence about the code
  — see the section below before changing it.
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

## The collective (leader, workers, verified quotes)
`collective_run` never lets the leader read file contents: it reads the digest and plans units. Each unit
then runs as one model call on its own `code_context` slice, and every finding a worker reports is
re-verified by `src/collective/verify.ts` — path inside the project, file read from disk, quote present at
the cited lines (whitespace-insensitive, otherwise exact). Anything that fails is **rejected** and removed
from what the leader is allowed to build on; `found-elsewhere` keeps a real quote with wrong line numbers
and says where it actually is. The dossier keeps the rejected list, the conflicts and the unknowns, so a
future reader can disagree with the conclusion.
- Roles `leader` and `worker` default to the `session` provider (host sampling): the copies are instances
  of the host's own model and no key is needed. `providerNeedsKey` guards `collective_run` so a key-based
  provider fails fast with a clear message instead of mid-mission.
- Budgets live under `codebase` and `collective` in `src/config.ts`. If you change a cap, change it there,
  not in the loop.
- The leader naming a file that does not exist is caught before dispatch; a worker whose reply breaks the
  contract is dropped whole and listed under "workers that produced nothing usable". Never let a failed
  worker be silently smoothed over: the dossier's honesty about that is the point.
- `smoke/smoke.mjs` drives two whole missions with a stub host. If you change the schemas in `roles.ts` or
  `peer.ts`, the stub in the smoke suite must change with them — that coupling is deliberate, it is what
  keeps the contract testable without keys or network.

## Round two, and what the copies remember
- Round two (`collective.peerRound`, one extra model call per unit) exchanges **verified findings only** —
  a worker never sees another's unchecked claims — and a rebuttal that carries a quote is put through the
  same gate as round one. Do not add a path that lets agreement between copies count as verification: they
  are the same weights, and models give the same wrong answer about 60% of the time when both are wrong
  (Kim et al., ICML 2025). Rebuttals without a quote are recorded as unproven; dissent is kept for the
  owner. This is the whole point of the section, so treat "the agents agreed" as a non-result.
- `memory.ts` admits only quote-verified claims from a mission that reached a conclusion, plus rejections
  (so they are not reinvented) and the owner's rulings. On load, **every entry is re-read from the file**;
  anything whose quote is gone is marked stale, reported, and excluded from prompts. Two traps live here:
  the freshness check must skip `rejected` entries (they are *supposed* to be absent — applying it to them
  retired every rejection, which the smoke suite caught), and nothing from memory may ever be treated as a
  citation. Keep the admission gate narrow: adding everything measurably made agents worse (Xiong et al.,
  ACL 2026), and stale beliefs survive retrieval (STALE benchmark).
- Personas are prompt text only. If you are tempted to give them hidden state, private channels or a way to
  influence the verifier, re-read the README section on what the "AI society" experiments actually were:
  the one that matches the story is reward hacking, and it is a failure mode, not a capability.

## "Hello collective." and the owner's skills
- `collective_hello` is the session bootstrap: index cache, memory freshness, recent dossiers, one
  `git status`, the skills scan, then the digest — all computed or attributed, no model call, no key. It is
  the answer to a greeting, so it must stay fast and it must not invent work: if the owner only said hello,
  it hands the assistant the facts to say back and one question to ask.
- An MCP server cannot open a conversation, so "runs every time I open a session" is carried by
  `collective_install`, which writes a marked block into the repo's own instruction file (AGENTS.md, plus
  CLAUDE.md when present). Keep it that way, and keep the block short: the alternative — a tool that
  magically fires on session start — does not exist, and claiming otherwise would be the one thing this
  codebase does not do. `remove` takes it back out; the smoke suite asserts the text outside the markers is
  never touched and that a second install writes nothing.
- Skills are instructions to follow and are **never evidence about the code**: `workerSystem` says so in as
  many words, and the dossier repeats it. A unit is assigned one with `skill` on the plan (or `skills` on
  `collective_run` to shortlist what the leader may offer); the text is read at dispatch time and only for
  the units that asked, and a skill the leader names that cannot be found is a warning, never a silent
  no-op. Do not add a path where a skill's own claims get cited as facts about the repository, and do not
  give the server a general command runner to "run" a skill with: the host already has a terminal, and a
  tool that executes whatever a model asks for is a hole in every project this server is pointed at.
- Default roots cover the Freebuff account skills and the usual project/home skill folders (`skills.roots`
  in the config, `~` allowed). Discovery walks a few directory levels and stops at symlinks.

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
- Do not let a skill's text, or a memory entry, count as a citation. Quotes from files do that, and only
  the files.

## Related work
The blog this server is currently being used on lives in a sibling repo, `../Personal-Blog/`, and its
`handoff.md` is the cross-session memory for that work (this file is the pointer).

<!-- design-mcp:collective:start -->
<!-- managed by design-mcp: edit inside these markers only by asking the collective to reinstall -->
## Session start: the collective

This repository has a codebase-grounded collective available over MCP (server `design-mcp`).

- **At the start of a session in this repo, and whenever the owner says "Hello collective.", call
  `collective_hello` first, before any other work.** It returns the repo digest, what the collective
  already established or already got wrong here, the open missions and the skills the owner installed.
  Answer from that, never from memory of this repo.
- Ground every statement about this code in `code_digest` / `code_context`, check it with
  `code_verify_cites`, and run real work through `collective_plan` / `collective_run`. The full ground
  rules are the resource `code://focus`.
- The owner's installed skills are `skills_list` (resource `code://skills`); `skills_read` returns one in
  full. A collective unit can be assigned a skill, whose text then goes into that worker's prompt.
- Finish by running this project's own gates and reporting what was verified by running, what only by
  reading, and what was not checked.
<!-- design-mcp:collective:end -->
