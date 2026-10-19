# design-mcp — agent notes

MCP server (stdio) that generates, tests and critiques anti-slop website designs, plus an offline
**design playbook** of curated knowledge for motion, colour, type, layout, material and quality floors.
Node >= 20, TypeScript, ESM. `dist/` is committed because the host runs `dist/index.js` directly.

## Verified commands
```bash
npm install
npm run build          # tsc -> dist/
npm test               # 432-check keyless gate: smoke/smoke.mjs (298, stdio suite) + smoke/arithmetic.mjs (134, the built modules driven directly); no API keys needed
DESIGN_MCP_PROJECT_DIR=<dir> node smoke/call.mjs <tool> '[json]'   # call one tool
npm run inspect        # MCP inspector
npx tsx tools/lab/run.ts   # the memory experiment; see tools/lab/README.md (not a gate)
npm run serve          # the launcher the MCP host runs: rebuild a stale dist, then start the server
npm run sync           # build + gate + commit + push, once (what `autosync` does on a change)
npm run autosync       # the same, watching src/smoke/tools/scripts and the docs until stopped
```
`npm test` is the gate: it asserts the tool/resource/prompt inventory, the playbook tools, the
deterministic checks, the codebase layer against a fixture repo (including a tsconfig alias that must come
back as an internal edge and not as a package), four whole collective missions (driven by a stub host that
answers sampling, including one deliberately invented quote that must be rejected and then handed back in
the repair pass — one unit re-cites it, one withdraws it with a reason, one never addresses it, and the
three outcomes must stay distinguishable — a quote that is real but shares no wording with its claim, an
unevidenced rebuttal that must be labelled unproven, two of the four missions with the closing paragraph
armed so it asserts that deleted finding as fact and names a file that does not exist — one mission with the
conclusion pass off, where both sentences stand and the grade cannot reach `STRONG`, and one with it on,
where the stub rewrites one sentence into wording that restates the rejection and gives the other up with a
reason — and a memory entry whose code changes and must retire itself), the computed verdict the mission
counts for itself, the session greeting and the skills layer (a
fixture SKILL.md that must be found, read, and pasted into exactly the worker that was assigned it), the
edit gate over the edits those missions proposed (an invented file, a real anchor cited at stale lines, an
anchor that occurs three times, the snapshot hash, the closing plan's own steps), the session-block
installer (idempotent, and it must not touch text outside its markers), and every graceful
error path. `smoke/arithmetic.mjs` (115 checks) then drives the built index cache, the built edit gate, the built merge and the built verdict directly, because
neither is reachable through a mission at reasonable cost: the full status matrix (anchored, stale,
ambiguous, not found, out of range, missing, refused, unindexed, and the import-graph impact behind each)
and every grade rule (a clean run is `STRONG`; one unapplicable edit, one wrong citation, one thin quote, one
silent unit, no closing pass or one sentence of that paragraph that still contradicts the record are each
enough to stop it, and a step that was re-placed by the edit repair pass or a sentence the conclusion pass
rewrote to stand on the record stops counting). It must all pass — 405/405 (290 + 115) — before
any change is called done.

## Map
- `src/index.ts` — the MCP surface: 37 tools — 15 generating/testing, 6 playbook, 10 codebase/collective
  (code_index, code_digest, code_context, code_refs, code_verify_cites, code_verify_edits, collective_plan, collective_run,
  collective_report, collective_memory), 5 session/skill (collective_hello, collective_install, skills_list,
  skills_read, project_root), 1 local-delegation (local_mode) — 11 `design://` + 7 `code://`
  resources, 5 prompts. Registered at the bottom; the codebase, collective and local_mode blocks are
  clearly marked. The smoke suite asserts this count from its own list (a hardcoded label has drifted
  twice), so adding a tool means adding it there too.
- `src/project.ts` — which repository this session is working on, and the refusal when the answer is a
  home folder. **Read its header before changing the resolution order.** One install of this server is
  used from many repos, and the host's launch directory is not the repo: `project_root` ->
  `DESIGN_MCP_PROJECT_DIR` -> the host's `roots/list` -> the working directory walked up to its repo
  marker. The refusal is load-bearing: indexing a home directory produced 2,900 plausible citations
  from the wrong tree, which is worse than an error because every one of them looked like an answer.
- `scripts/serve.mjs` — the entry point the host should run instead of `dist/index.js`: it rebuilds when
  any `.ts` is newer than the newest emitted file, then hands stdio to the server. Nothing here writes to
  stdout (it carries the protocol), a failed build still starts the last good build and says so, and the
  child keeps the host's working directory — the launcher builds in the repo, but it must not rewrite the
  cwd that project-root resolution rung 4 reads.
- `tools/autosync.mjs` — `npm run autosync`: watch the source, then build, gate, commit and push. Only
  known paths are staged (`git add -u` plus explicit directories), a failing build or gate commits
  nothing, and a failed push leaves the commit local and says so. Read its header before loosening any
  of those three rules.
- `src/codebase/` — ground truth about the repo, computed from the files, no model involved. `symbols.ts`
  extracts declarations and imports (**read the header before changing it**: line-oriented comment
  stripping and span rules exist because two real bugs came from getting them wrong), `scan.ts` lists and
  reads files (git ls-files so `.gitignore` decides, walk otherwise) and detects conventions, `store.ts`
  is the cached index + digest/map/graph/conventions renderers, `pack.ts` turns a question into
  token-budgeted source slices with the file's own line numbers, and `refs.ts` answers "who declares this
  name, who uses it" with a word-boundary text scan (`code_refs`) plus the bounded rename surface the edit
  gate uses. Read its header before trusting it as more than a scan: it counts a match in a comment, a
  string or an unrelated same-named local, and it cannot see a dynamic reference — never present it as
  semantic analysis, and never let anything rename or delete on its word alone.
- `src/codebase/store.ts` — the index cache is verified **cheapest-first**: for a clean tree above
  `codebase.gitStampMinFiles` (default 300) git itself answers "nothing moved" in two spawns (359 ms → 43 ms
  warm on a 4000-file repo, +10 ms on a dirty one), then one stat per file decides for a dirty tree, and only
  real byte changes rebuild. Read `quickStampFor`'s header before widening it: git's status names a path, not
  the bytes, so a dirty tree is never trusted to it, and a repo with `assume-unchanged`/`skip-worktree` files
  gets no git stamp at all.
- `src/collective/edits.ts` — the edit gate: the same re-read-the-file suspicion as `verify.ts`, pointed at
the edits a mission proposes instead of the claims it makes. Read its header before widening it: line
numbers belong to the snapshot it records, an ambiguous anchor is not placed, and the import-graph impact
comes from the index rather than from the intent's wording.
- `src/collective/editrepair.ts` — the edit repair pass: a step the edit gate could not place goes back to
its own source ONCE, with the server's reason, and what comes back is re-gated at the same standard. Read
its header before widening it, because every rule there is load-bearing: one pass, repair-only-adds (a step
that already landed is never re-sent), a returned step is matched to a rejected one by its `fixes` number
rather than by a model's memory, a withdrawal with a reason is a recorded outcome, and a path outside the
project is a refusal rather than something to iterate on.
- `src/collective/conclusion.ts` — the conclusion gate: the closing paragraph against the mission's own
record, one sentence at a time. Read its header before widening it, because the boundaries are the design:
`unverified` is exempt (it is where a rejection belongs), hedged wording is not an assertion, matching is
content-word overlap and deliberately one-sided, only a file that is in neither the index nor on disk counts
as invented, and the split is deterministic so a repair can answer by number. It decides whether a paragraph
contradicts the record, never whether it is right. `conclusionrepair.ts` is the one pass that hands a flagged
sentence back to the leader with the record's words and the real file list, then re-checks the *whole*
paragraph (a rewrite can put a new contradiction where the old one was), keeping the two honest outcomes
distinct: rewritten-and-re-checked, or given up with a reason that is shown next to the sentence it removes.
- `src/collective/` — the multi-agent layer. `roles.ts` holds the contracts and prompts (the citation
  contract lives there and is repeated to every worker), `ask.ts` is one schema-checked model call with a
  single repair round, `verify.ts` re-reads every quote and is the only thing allowed to call a claim
  true, `run.ts` is the mission loop and the dossier, `focus.ts` is the ground-rules brief.
  `repair.ts` is the one bounded second chance a rejected citation gets (read its header before widening
  it: one pass, repair-only-adds, the same gate decides), and `verdict.ts` is the arithmetic the mission
  counts for itself — it grades a run from the gate's results and never from the closing paragraph.
  `personas.ts` gives each seat a stance and a voice (Scout/Mason/Wrench/Thorn/Judge, Keystone leads —
  prompt interventions that change what gets said, not independent minds), `peer.ts` is round two where the
  copies read each other's **verified** findings and must answer with evidence, and `memory.ts` is what
  survives between missions. `owner.ts` is the other half of what carries over: deterministic history of the
  missions run here (counts, grades, the files they kept landing on, the skills that reached a worker),
  written on the way out, read by the greeting and by the leader, and labelled history rather than
  evidence. It holds no preferences — those are `ruling` entries in `memory.ts`, in the owner's own words.
  `hello.ts` is the session greeting ("Hello collective.": one pass, no model,
  ~150 ms, and it must stay that cheap because it runs at the top of every session) and `install.ts` writes
  the marked block that tells a host to call it.
- `src/ollama/` — optional local-model delegation through Ollama, everything OFF by default: `client.ts`
  is transport only (a counting-semaphore queue capped by `local.maxConcurrent`, queue-time-inclusive
  timeouts, a generation counter so `cancelAll` refuses queued work instead of running it later,
  warn-once reporting, a health check), `state.ts` is the runtime toggle the flip persists under
  `.design-mcp/local-mode.json` plus the owner's counters, and `delegate.ts` is the one write path:
  the local model returns FULL file contents, the previous bytes are snapshotted, the write is audited
  in the fixed order (deterministic checks: configured typecheck/lint/tests, then the mechanical
  import/API-existence check against the index, then ONE council spec review), a failure reverts
  byte-for-byte and feeds the concrete errors back ONCE, a second failure reverts and hands the unit
  to the council with the reason. The gate checks that nothing was merged on the local model's word;
  it does not check that the change is right — the council review and the project's own gates read
  after the merge do that. Nothing here runs with local mode off: zero Ollama calls, identical mission
  behaviour.
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

## What this server expects of its host
- **Every host answer has a deadline.** `host.samplingTimeoutSec` (default 300) bounds one sampling reply,
  and a client that never advertised the capability is refused before the request is sent (`sampling.ts`).
  Both exist because MCP gives sampling no deadline at all: one mission sat on its leader plan for hours
  while `design_status` said RUNNING, and the only thing that ever ended it was a server restart. Do not
  remove the capability check on the grounds that the timeout catches it — the check is what turns a
  five-minute hang into an instant, actionable error.
- **A silent job is named.** `design_status` reports a running job whose log has not moved for
  `host.stallSeconds` (default 90) as STALLED, with the last line it managed. It cannot kill the call
  (there is nothing here to kill); it stops the status line from lying.
- **The project root is a decision, not an assumption.** See `src/project.ts`: a session `project_root`
  call, then `DESIGN_MCP_PROJECT_DIR`, then the host's `roots/list`, then the working directory walked up
  to its repo marker. The guard that refuses a home folder is the point, not a nicety.

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
- **A rejected quote is not a dead end and not a softer claim.** `repair.ts` hands a repairable rejection
  back to its own unit exactly once, with the reason and the line the quote really lives at, and the reply
  goes through `verifyReports` at the same standard. The rules that must not be relaxed: one pass (repairs
  stop paying and start breaking things), never a finding that already verified (a correction round that can
  edit good findings breaks them), only the statuses a worker can act on (`quote-not-found`,
  `found-elsewhere`), the first attempt stays in `rejected` for the record, and a claim the worker
  withdraws is recorded as withdrawn rather than deleted. A repair ADDS evidence; it never upgrades a
  rejection.
- **An anchor is checked like a citation, or not at all.** Every proposed edit goes through `edits.ts`:
the path must exist, an anchor must really be in that file at the cited lines, an anchor that occurs more
than once with no line range is `anchor-ambiguous` rather than assumed, and each checked edit carries the
file's snapshot hash so a stale line number is detectable. When the anchor is a plain identifier the impact
line also names the call sites it found (`refs.ts`, bounded to the rename surface), and those are a text
scan like everything else in that module. The rules that must not be relaxed: `broken`
(no such file, anchor not found, lines past the end) stops a run grading `STRONG`, an `unanchored` edit says
only that its path exists, and the gate never claims to have applied or judged the change. If you add a way
for an edit to reach the dossier without passing here, you have removed the point of the module.
- **A step that could not be placed gets one second chance, not an infinite one.** `editrepair.ts` hands the
step back with the gate's own reason (where the anchor really is, how many times it occurs, that the range is
past the end) and re-gates the answer. Never let it loop, never let a returned step skip the gate, never count
a step as settled because its author said it was: only `verifyEdits` decides, and the settled keys are what
stop a superseded step from holding the verdict down.
- **A found quote is only half of a citation.** `verify.ts` labels a verified quote that shares no content
  word with its claim as thin support, and that label is one-sided on purpose: it can only ever downgrade.
  Never report it as entailment, never let a thin claim into memory (see `memory.ts`), and keep the
  "wording in common is not proof either" sentence wherever the flag is explained. A real support check
  needs a reading model; what is here is the part that is honest without one.
- The verdict's grade is a function of counts only (`missionVerdict`), and the downgrade rules are stated
  in `verdict.ts`. If you add a way to make a mission look better without adding verified quotes, you have
  changed the wrong thing.
- The leader naming a file that does not exist is caught before dispatch; a worker whose reply breaks the
  contract is dropped whole and listed under "workers that produced nothing usable". Never let a failed
  worker be silently smoothed over: the dossier's honesty about that is the point.
- `smoke/smoke.mjs` drives two whole missions with a stub host. If you change the schemas in `roles.ts` or
  `peer.ts`, the stub in the smoke suite must change with them — that coupling is deliberate, it is what
  keeps the contract testable without keys or network.

## Local delegation (Ollama, off by default)
`local_mode { set: "on" | "off" }` flips local delegation at runtime; the config's `local.enabled`
(default OFF) is only the seed the flip overrides, and the flip survives server restarts. With the mode
off the workflow is byte-identical to before it existed — zero Ollama calls, not one.
- **Routing is the leader's, and it is narrow.** Only `role: "implementer"` units the leader marks
  `local: true` are eligible, and only when the work is well-scoped (boilerplate, types, utilities,
  CRUD, tests, docs, repetitive refactors). Architecture, cross-file logic, security and debugging stay
  with the council; the leader unsure keeps the unit. The server also refuses anything beyond the
  unit's own scope, above `maxFilesPerUnit`, or outside the project — refused, not clamped.
- **The audit ladder is the merge gate.** Snapshot first, write, then deterministic checks in the
  owner's order (typecheck → lint → tests, commands configurable per repo), then the mechanical
  import/API existence check (an import the index cannot resolve, or a name nothing declares, is a
  reject — no model), then ONE council spec review on the host model. A retry is fed the concrete
  errors once. A second failure reverts the bytes and the council re-runs the unit, told explicitly not
  to copy the rejected code.
- **Reverts are byte-perfect and the rejected output is kept in the dossier** — labelled as not built
  on. Delegation refuses to run into an uncommitted tree unless `local.allowDirty`: a revert must never
  be able to eat the owner's uncommitted work.
- **Counters over vibes.** delegated / audit-passed / audit-rejected / fell-back persist with the
  state file; `local_mode`, the greeting and each dossier report them, plus the wall-clock and token
  cost of every local attempt, so the owner can judge whether delegation saves time.
- The model is a config value (`local.model`) and a flip-time override — swap it for qwen2.5-coder and
  A/B without touching code. Ollama's own env (`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`)
  belong to the daemon, not to this server; the config notes them.
- **A `:cloud` tag is an Ollama cloud model, and "local" is then only a routing mode.** `beam:cloud`
  (501B, 1M context) runs on `ollama.com`; the daemon at `local.host` proxies it, so the host stays the
  same and only `model` changes. `isCloudModel` is the one predicate for this. Three rules go with it:
  `keep_alive` and `num_thread` describe a machine the owner has, so they are not sent to a cloud model;
  the status line and the flip-on message say out loud that the file slices leave the machine, because
  the private-by-default promise is exactly what a remote model breaks; and the audit ladder, the import
  gate and the council review are unchanged, since nothing about where the bytes were generated says
  whether they are right. `health` reports `remote`/`parameterSize` from `/api/tags` (`remote_host`, no
  local size), so a cloud model is never mistaken for a missing one.

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
- The greeting also reads `.design-mcp/collective/owner.json` (one small file, one read, no model): how many
  missions have run here, what they graded, which files they kept landing on, and which skills actually
  reached a worker. That record is written at the end of every mission by `owner.ts` and handed to the
  leader as a labelled history block. Keep it bounded and best-effort — a corrupt or unwritable record must
  return empty rather than break a greeting or a mission, and nothing in it is ever evidence about the
  code. The owner's preferences are not stored there: they are `ruling` entries in memory, so there is one
  place to edit and no second copy to drift.
- An MCP server cannot open a conversation, so "runs every time I open a session" is carried by
  `collective_install`, which writes a marked block into the instruction files the hosts actually read.
  Which files those are is documented rather than guessed, and the table lives in
  `src/collective/install.ts` with its sources: AGENTS.md (Codex, Cursor, Copilot, Windsurf, Freebuff),
  CLAUDE.md / .claude/CLAUDE.md (Claude Code — its default *skips* AGENTS.md when a CLAUDE file exists, so
  a repo with both needs the block in both), GEMINI.md (Gemini CLI, which does not read AGENTS.md unless
  `context.fileName` is configured), .github/copilot-instructions.md, and the legacy .windsurfrules.
  One file per host family, `create` only ever produces AGENTS.md, and hosts whose file is absent are named
  in the report as gaps instead of created silently. Keep it that way, and keep the block short: the
  alternative — a tool that magically fires on session start — does not exist, and claiming otherwise would
  be the one thing this codebase does not do. `remove` takes it back out; the smoke suite asserts the text
  outside the markers is never touched, that each host's own file is written once, and that a second
  install writes nothing.
- Skills are instructions to follow and are **never evidence about the code**: `workerSystem` says so in as
  many words, and the dossier repeats it. A unit is assigned one with `skill` on the plan (or `skills` on
  `collective_run` to shortlist what the leader may offer); the text is read at dispatch time and only for
  the units that asked, and a skill the leader names that cannot be found is a warning, never a silent
  no-op. Do not add a path where a skill's own claims get cited as facts about the repository, and do not
  give the server a general command runner to "run" a skill with: the host already has a terminal, and a
  tool that executes whatever a model asks for is a hole in every project this server is pointed at.
- Default roots cover the Freebuff account skills and the usual project/home skill folders (`skills.roots`
  in the config, `~` allowed). Discovery walks a few directory levels and stops at symlinks.
- **A host that does not answer MCP sampling can still run a mission, on the `manual` provider.** Freebuff's
  MCP client is constructed with no capabilities, so `sampling/createMessage` is refused there and
  `roles.leader`/`roles.worker` = `session` cannot work; Cursor does not grant sampling either. Point those
  two roles at `manual` and set `DESIGN_MCP_MANUAL_WAIT_MS` (e.g. 1800000) in the server's env, then keep
  the job's client open: `collective_run` returns a job id, `manual_pending` lists the parked prompt,
  `manual_answer { id, text }` stores the reply and the waiting job continues, and `design_status` reports
  the dossier. One answer per model call (plan, each worker, round two, synthesis, any repair pass). This
  is a host workaround, not a fourth repair pass: never describe it as sampling, and never make it the
  default where the host does advertise sampling.

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
  `code_verify_cites`, check where a change would land with `code_verify_edits` before you make it,
  and run real work through `collective_plan` / `collective_run`. The full ground rules are the resource
  `code://focus`.
- The owner's installed skills are `skills_list` (resource `code://skills`); `skills_read` returns one in
  full. A collective unit can be assigned a skill, whose text then goes into that worker's prompt.
- Finish by running this project's own gates and reporting what was verified by running, what only by
  reading, and what was not checked.
<!-- design-mcp:collective:end -->
