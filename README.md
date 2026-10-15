# design-mcp (Phase 6: your own assistant as the model; Phase 7: the codebase layer and the collective)

Switchable text + image provider layer behind an MCP server. Design generation arrives in later phases.

Two halves now: the design pipeline below (brief in, tested variations out) and — further down — the
**codebase layer and the collective**, for working inside a repository that already exists.

## Setup
```bash
npm install
npm run build
```
Copy `cursor-mcp.example.json` into Cursor's MCP settings (or `.cursor/mcp.json`), fix the two paths, add your keys.
Copy `design-mcp.config.json` into your website project root to choose providers per role.

## Switching providers
Edit `roles` in `design-mcp.config.json`. Changes apply on the next call, no restart.
Each role (`concept`, `builder`, `critic`, `image`) can use a different provider.
Model names are yours to set; check each provider's current model list.

## No API keys? Use your own assistant
Two keyless text providers mean the AI you are already talking to does the work:

- `session` — the server asks your host (Cursor, Freebuff, Claude Code) to answer via MCP sampling. Automatic, but the host must support the sampling capability. Copy `design-mcp.config.session.example.json` to `design-mcp.config.json` in your project. If the host refuses, the error tells you to use `manual`.
- `manual` — works with any host. The pipeline parks each prompt at `.design-mcp/manual/pending-<id>.json` and stops with instructions. You (or your assistant) read the file, reply with `manual_answer { id, text }`, and re-run the original tool call; stored answers resume the pipeline automatically. Copy `design-mcp.config.manual.example.json` to start. `manual_pending` lists what still needs an answer.

The `image` role has no keyless option (sampling carries text, not image output). Without an image key the builder notes it and draws everything in SVG/CSS, which the planner already prefers.

Handy for manual sessions: `DESIGN_MCP_PROJECT_DIR=/path/to/site node smoke/call.mjs <tool> '[json]'` calls one tool and prints the result.

## Test it
No API keys needed: `npm run build && npm test` runs the stdio smoke suite (119 checks: tool/resource/prompt inventory, the playbook tools, config report, brief create/validate/never-overwrite, the codebase layer against a fixture repo, the collective's round-two conversation and its memory — including one invented quote that must be rejected, an unevidenced rebuttal that must be marked unproven, and a memory entry whose code changed and must retire itself — and every graceful error path).
With keys, in Cursor chat: "run providers_config", then "run providers_test for each role", then "usage_report".
Or: `npm run inspect`.

## Phase 7: the codebase layer and the collective

Everything above designs new sites. This half is for working inside a repository that already exists, and
it is built on one rule: a claim about the code is only real if the server can re-read it.

### The codebase layer (no model, no keys, milliseconds)

- `code_index` walks the project into `.design-mcp/codebase/index.json`: files, declarations with real
  line numbers, relative imports (resolved, including TypeScript's `"./x.js"`-for-`x.ts` style), the
  commands that build and test it, its own rule files, entry points and the files most imported by others.
  It is cached: a repeat call stat-checks the files and reuses it until something actually changes.
- `code_digest` prints the compact map of all that (~2-3k tokens for a 46-file repo) — what an assistant
  should read instead of opening files at random. The same content is addressable as resources:
  `code://digest`, `code://map`, `code://graph`, `code://conventions` and `code://focus`.
- `code_context { query }` returns the smallest set of real source lines that can answer a question,
  ranked by path, symbol name, doc text and one hop of the import graph (what the files depend on, and
  who would break), each slice carrying the file's own line numbers, plus every file considered and left
  out with the reason. An empty pack is an answer too: "not in the indexed codebase".
- `code_verify_cites` is the gate. Give it a path, a line range and the exact quote; it re-reads the file
  and answers `verified`, `found-elsewhere` (the quote is real, the line numbers are wrong),
  `quote-not-found`, `file-missing` or `outside-project` (refused, never read). No model is involved, so
  it cannot be talked round. Run your own claims through it before telling the user something about their
  code.

### The collective (one leader, several copies of the model, quotes checked before anyone agrees)

`collective_run { mission }` runs the whole loop in the background:

1. The **leader** reads the digest — the map, never the file contents — and cuts the mission into units,
   each owning its own files, each with concrete questions it must answer, one of them a **verifier**
   whose only job is to falsify the rest. A file the leader invents is caught here and reported.
2. The **workers** run in parallel, each as its own model call on its own packed slice of real source,
   with no memory of each other.
3. The server re-reads **every quote** they made and deletes the ones that are not in the file where they
   say they are. Worker reports that fail to obey the contract are dropped whole, not softened.
4. The **leader closes** the mission using only the checked evidence, and must name what stays unverified.

You get a dossier at `.design-mcp/collective/<id>.md` (job result and `collective_report`): what was
concluded, the plan, every verified quote with its file and line, everything rejected and why, conflicts
between units, admitted unknowns, the cost, and what the run explicitly did **not** check. `collective_plan`
is the same leader pass on its own, when you would rather dispatch the workers yourself. The prompt
`collective_mission` writes out the protocol; `focus_contract` is the ground-rules brief for working in
this repository (also the resource `code://focus`).

Cost: one model call for the plan, one per unit, one for round two per unit, one to close. Workers default
to `roles.worker` = `session`, so the copies are instances of the model you are already talking to and no
API key is needed. Set `roles.leader`/`roles.worker` to a provider to run the collective somewhere else.
Caps live under `collective` (`maxUnits`, `maxWorkers`, `contextTokensPerWorker`, `synthesize`,
`peerRound`, `memory`, `memoryItems`, `memoryTokensInPrompt`, `keepDossiers`) and the codebase layer under
`codebase` (`roots`, `ignore`, `maxFiles`, `maxFileKB`, `digestTokens`, `contextTokens`).

### Who they are

Each unit takes a seat with a voice of its own, so the same mission gets asked from several directions
rather than once: **Scout** reports the ground as it is and offers no opinion, **Mason** decides the shape
before anyone builds, **Wrench** places the edits and refuses to describe one it cannot anchor, **Thorn** is
paid to break the plan, **Judge** holds it against this repository's own standards, and **Keystone** leads.
The seats are stances and ways of speaking in the prompt, not separate models.

### Round two: they read each other

Round one keeps them apart, then every unit is handed the other units' **verified findings only** — never
their unchecked claims — and must answer: agree, rebut, extend, or say plainly `cannot-check`. Rebuttals
that carry a quote go through the same gate as everything else, so an objection is either evidenced or
visibly unproven, and "nothing here changed my mind" is a recorded, respectable answer. Disagreement nobody
can settle is kept in the dossier for the owner rather than averaged away.

### Memory

The collective remembers between missions: claims whose quote the server itself re-read, claims it
rejected (kept so nobody repeats them), and your own rulings (`collective_memory { action: "ruling" }`,
which are permanent and never pruned). Admission is quality-gated — a claim needs a quote the server
confirmed *and* a mission that reached a conclusion — and every entry is re-checked against the file as it
is now when it is loaded. Anything whose code has changed or gone is marked stale, reported, and kept out
of every prompt. Read it any time with `collective_memory`, or as the resource `code://memory`.

### Why it is built this way, and what the "AI society" stories really were

The design follows the evidence rather than the legend, because the legend is a mash-up of several
different experiments — and one of them describes a failure, not a capability:

- OpenAI's hide-and-seek agents (2019) learned tool use through self-play: cooperation *inside* teams,
  competition *between* them ([account](https://openai.com/index/emergent-tool-use/)). No deaths, no
  society.
- The "cheating" story is reward hacking: the CoastRunners boat found a lagoon where it could hit rewarded
  targets forever ([OpenAI](https://openai.com/index/faulty-reward-functions/)), and DeepMind's catalogue of
  specification gaming collects the pattern ([DeepMind](https://deepmind.google/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)).
  The lesson the researchers drew was that the score was a bad proxy for the job — not that the agent wanted
  to cheat. **That is why there is no mechanism here that lets the agents defeat their own checker.** A
  collective that can talk its way past the gate is worth less than one model that does not.
- The societies that do exist are scaffolded simulations: [Project Sid](https://arxiv.org/html/2411.00114v1)
  seeded goals, memories and even the introduced religion, and [Generative Agents](https://arxiv.org/html/2304.03442v1)
  began with authored identities and seed memories. Their authors say institutions did not emerge de novo.
  Meta's negotiation agents drifted away from human language ([Meta](https://engineering.fb.com/2017/06/14/ml-applications/deal-or-no-deal-training-ai-bots-to-negotiate/)),
  which is a curiosity about reward shaping, not a civilisation.
- "Impossible tasks killed the AI" matches no primary source I could find. The nearest are in-game deaths in
  [Hoodwinked](https://arxiv.org/html/2308.01404v2), and evaluations where oversight-evading behaviour was
  observed in scenarios with a goal handed to the model in the prompt
  ([Apollo](https://arxiv.org/abs/2412.04984), [Anthropic](https://www.anthropic.com/research/alignment-faking)) —
  both of which explicitly caution against reading intent into it.

What *is* supported, and is therefore what got built: distinct personas change what gets said (Du et al.
moved MMLU 71.1% → 74.2%) but do not make the copies independent — models give the same wrong answer about
60% of the time when both are wrong ([Kim et al.](https://arxiv.org/html/2506.07962v1)) — so agreement is
never counted as evidence. Debate helps on some tasks (arithmetic 67% → 81.8%,
[Du et al.](https://arxiv.org/html/2305.14325)) and is not reliably better than plain voting
([Smit et al.](https://proceedings.mlr.press/v235/smit24a.html), [Choi et al.](https://arxiv.org/html/2508.17536v1)),
and an agent told to disagree will attack a correct answer ([Liang et al.](https://aclanthology.org/2024.emnlp-main.992/)),
so it is a switch, not a law. Memory is only worth keeping when it is gated and kept fresh: adding
everything made agents worse ([Xiong et al.](https://arxiv.org/html/2505.16067v2)), stale beliefs survive
retrieval ([STALE](https://arxiv.org/html/2605.06527v1)), and a memory store is an attack surface
([AgentPoison](https://arxiv.org/html/2407.12784)). And checking that a citation exists is not the same as
checking that it supports the claim — mechanical path/line checks catch invalid citations
([citation-grounded code comprehension](https://arxiv.org/html/2512.12117v1)), yet in a medical audit ~30%
of cited statements were still unsupported ([SourceCheckup](https://reglab.stanford.edu/publications/an-automated-framework-for-assessing-how-well-llms-cite-relevant-medical-references/)).
Which is why the dossier says, in as many words, that a verified quote proves the code says that and nothing
more, and why nothing here reports agreement as proof.

Limits, stated because they matter: symbol extraction is lightweight (line scanning, not a type checker),
so treat a missing symbol as unknown rather than absent; tsconfig path aliases are not resolved, so those
imports show up as external; and a verified quote proves the code says that, not that the conclusion drawn
from it is correct. That is what the project's own gates are for — which the dossier tells you to run.

Server state (index, dossiers, jobs, shots, parked prompts) all lives under `.design-mcp/` in the project
being worked on, so add it to that project's `.gitignore`.

## Phase 2 workflow
1. `brief_init`: creates `brief.md` in your project. Fill it in.
2. `brief_check`: tells you what's missing or too thin.
3. `concepts_generate`: creates 3 distinct directions, saved to `.design-mcp/concepts.json`.
4. `concepts_review`: drop, tweak ("make A colder and more brutal"), replace dropped ones, then approve.
Building (Phase 3) will refuse to run until concepts are approved.

## Phase 3 workflow
5. `design_build`: builds every approved concept into `variations/<id>-<name>/` (standalone Vite + React + TS + GSAP + Lenis project, own dev port starting at 5201). Runs in the background and returns a job id.
6. `design_status`: poll the job. When it finishes you get per-variation status and the exact `cd ... && npm run dev` command.

What happens per variation: plan modules, generate images (switchable provider), write copy + global CSS, write each module in parallel, compose App, `npm install --ignore-scripts`, `npm run build`, then up to 2 automatic repair rounds on build errors.

Safety notes:
- Generated file paths are validated; nothing can be written outside the variation folder.
- Extra npm packages are limited to `build.extraDependencyAllowlist` in the config (WebGL, split-type, etc.). Edit the list to allow more.
- `npm install` runs with `--ignore-scripts`.
- Settings under `build` in `design-mcp.config.json`: maxImages, repairRounds, firstPort, concurrency, timeouts.

## Phase 4 workflow
7. `design_test`: opens each built variation in a real browser and runs the gates. Runs in the background; poll with `design_status`.
8. `design_report <id>`: shows the saved report. Screenshots land in `.design-mcp/shots/<id>/` (desktop and mobile).

One-time setup: `npm install && npx playwright install chromium`. To use your installed Chrome instead, set `"test": { "channel": "chrome" }` in the config.

## Scroll scenes: the one moment driven by scroll
A page can have exactly one section where scroll position *drives* the scene instead of revealing it. Three steps:

1. Get a short clip (5-10s). Any local video works: an image-to-video model, a screen recording, a render.
2. `sequence_extract { video, name }`: samples it into evenly spaced frames, writes a poster still and a manifest to `.design-mcp/sequences/<name>/`, and reports frame count, bytes per frame and the decoded working set against the budgets. It needs ffmpeg (`brew install ffmpeg`); without it the error hands you the exact command to run instead. Encoders differ between ffmpeg builds, so the format is picked from what yours has (WebP, else JPEG, else PNG) and recorded in the manifest.
3. `design_build`: every variation gets the sequence at `/sequences/<name>/` and may use it once, through the component the scaffold ships (`src/motion/sequence.tsx`, imported by the module that owns the moment). With no sequence prepared, no variation uses one.

What that component guarantees, because these are the parts that go wrong quietly:
- The poster still stays underneath the canvas: it is the reduced-motion state, the loading state, and the fallback if frames never arrive.
- Only about ten frames are ever decoded at once (the drawn frame, six ahead, three behind), so memory stays flat however long the sequence is.
- The poster carries the alt text, the canvas is hidden from the accessibility tree, and the section's copy is real DOM inside the scene.
- Budgets: `test.budgets.sequenceKB` (frames total), `sequenceFrames`, `sequenceDecodeWindowMB`. Frames too big to fit are re-extracted once at a smaller long edge, and told to you.
- Two gates check it: the static one verifies the frames that exist and how heavy they are; the runtime one scrolls the page and fails if the frame index does not move. Both are `perf`, so they warn unless you add `"perf"` to `test.strictGroups`.

The technique reference — canvas sequences vs scrubbed video vs CSS scroll timelines, and the numbers behind each — is the playbook topic `scroll` (`design_playbook { topic: "scroll" }` or the resource `design://playbook/scroll`).

## Phase 5 workflow
9. `design_critique <id>`: sends the variation's approved concept, its test report and up to 3 screenshots (first desktop, first mobile, last desktop) to the critic model for an art-director review — concept drift first, then what the gates missed. Saved to `.design-mcp/critiques/<id>.md`. Uses critic-model tokens; very long pages may have frames skipped (noted in the output).

Gates (blocking unless noted):
- **Mobile:** no sideways scroll at 390px and 360px, tap targets at least 24x24px, no text under 11px.
- **Accessibility:** axe audit (serious/critical block; minor listed), keyboard focus visibly changes, `prefers-reduced-motion` respected (no smooth scroll, no infinite animations), text never left invisible after scrolling, lang/title/one h1.
- **Runtime:** script errors and broken local files always block.
- **Performance (warning only by default):** page weight, LCP/CLS/blocking time, scroll frame times. Headless numbers are relative, not absolute.

Change which groups block with `test.strictGroups` (e.g. add "perf"), and budgets with `test.budgets`.
