# design-mcp (Phase 6: your own assistant as the model; Phase 7: the codebase layer and the collective; Phase 8: "Hello collective." and your own skills)

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
No API keys needed: `npm run build && npm test` runs two harnesses — the stdio smoke suite (288 checks) and `smoke/arithmetic.mjs`, which drives the built modules directly (93 checks) — 381 in all: tool/resource/prompt inventory, the playbook tools, config report, brief create/validate/never-overwrite, the codebase layer against a fixture repo including a tsconfig alias that must resolve to a real file, the reference lookup (a declaration with its kind and export status, every use with its line, a use reached through a tsconfig alias, a name used but never declared, a name nothing mentions, a mention in a document labelled as a mention rather than a call), the edit gate against a fixture whose import graph is known (an anchor that is really there, one that is real but cited at stale lines, one that occurs three times, a line range past the end of the file, a path the leader invented, a path outside the project, an edit in a file the index skipped, the call sites named for an identifier anchor, and the snapshot hash each line number belongs to), the collective's repair pass, its computed verdict and the grade arithmetic behind it (a clean run grades `STRONG`, one edit that cannot be applied or one closing sentence that still contradicts the record stops that, and a claim the repair pass re-cited or withdrew no longer holds the run down), the conclusion gate turning an armed closing paragraph into two flagged sentences and the conclusion repair pass settling them one way each, its round-two conversation and its memory — including one invented quote that must be rejected and then repaired, withdrawn or left unaddressed by three different units, an unevidenced rebuttal that must be marked unproven, a memory entry whose code changed and must retire itself, and the session-install block covering each host's own instruction file — one file per host family, the host's own text never touched, and a removal that cleans every file it wrote — and every graceful error path).
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
- `code_refs { name }` answers what the import graph cannot: for one symbol, every place it is declared and
every place it is used, with the file, line and text of each, declarations first and their kind and export
status. Use it before a rename, a signature change or a deletion — a file that imports a module is not a
file that calls the function, and a file that never imports it can still name it in a test title or a string.
It is a word-boundary text scan, not a type checker, and it says so: a match inside a comment or a string
counts, a same-named local counts, and a name reached dynamically is invisible. Deterministic, keyless, and
complete over the indexed files, which is the right trade for a rename sweep and for a reader judging a diff.
- `code_verify_cites` is the gate. Give it a path, a line range and the exact quote; it re-reads the file
  and answers `verified`, `found-elsewhere` (the quote is real, the line numbers are wrong),
  `quote-not-found`, `file-missing` or `outside-project` (refused, never read). No model is involved, so
  it cannot be talked round. Run your own claims through it before telling the user something about their
  code.
- It also names the second way a citation fails, which finding the quote cannot catch: a quote that is
  really there and shares no content word with the claim on top of it is flagged as **thin support** —
  real line, wrong thing to hang on it. The label is deliberately one-sided: it can only ever downgrade a
  claim, never certify one, because words in common are not entailment (non-entailing pairs with
  near-perfect overlap are easy to construct: [HANS](https://arxiv.org/html/1902.01007v4)). Deciding that a
  passage really supports a claim takes a reader, and the audits say how badly that goes unanswered: 51.5%
  of generated sentences were fully supported by the citations attached to them and 25.5% of the citations
  did not support their sentence at all ([Liu, Zhang & Liang](https://arxiv.org/html/2304.09848v2)).

### The edit gate (the same suspicion, pointed at the work instead of the claims)


A finding whose quote is missing gets deleted. An edit whose anchor is missing used to travel straight into
the project. `code_verify_edits` closes that gap: give it the edits you or a worker are about to make — a
path, and where possible an anchor (a symbol, or the exact line the edit sits next to) and a line range — and
it re-reads each file and answers where the edit lands: `anchored`, `anchor-elsewhere` (the anchor is real,
the line numbers are stale), `anchor-ambiguous` (the anchor occurs more than once with no range to pin it
down), `anchor-not-found`, `lines-out-of-range`, `no-such-file`, `outside-project`, or `unanchored` when
there was nothing to check but the path. A path that is not there comes back with the closest path the index
does have.

It also answers the question a model is worst at, without asking one: what a change there can break. That is
read off the index's own import graph — how many files import it, which of them are tests, and whether the
anchor is declared in a *different* file, which means the edit sits at a use site and a rename would have to
sweep that declaration's importers. When the anchor is a plain identifier, the same line names where it is
actually used (the file and line of each call site on that surface), so a signature change can be judged
rather than guessed at. Every checked edit carries the sha256 of the file exactly as it was read,
so the line numbers are pinned to a snapshot: if the file hashes differently later, the numbers are stale and
the honest move is to re-check rather than to guess.

Every step a mission proposes goes through this gate, the closing plan's own steps included, and the verdict
counts the ones that cannot be applied as described — one of those is enough to stop the run grading `STRONG`.
What it does not do is apply the change, parse the result or judge the change: it says an edit lands where it
claims to land, which is the half that can be checked without reading the code or trusting a model.

### The edit repair pass (one second chance for a step that could not be placed)

A step the gate rejects is not deleted and forgotten. It goes back to whoever proposed it — the unit that
wrote it, or the leader for a step of the closing plan — carrying the server's own reason: the anchor is not
in that file, it is really at line 263, it occurs three times so cite a range, the range is past the end of
the file, the path is not in the index (with the closest one it does have). The source either re-places the
step against real source it is given, or withdraws it with a reason ("the file does not contain the symbol
this step assumes"), and what comes back is re-gated at exactly the same standard. Each returned step carries
`fixes`, the number of the step it replaces, so the server matches answers to questions by arithmetic rather
than by asking a model which is which. One pass, never a loop; nothing that already landed is ever re-sent;
the first attempt stays in the record marked as superseded; and a withdrawn step is a recorded, respectable
outcome rather than a silent deletion. Turn it off with `collective.editRepair: false`.

### The conclusion repair pass (one second chance for a sentence the record contradicts)

Every other output of a mission is gated, and the paragraph the owner actually reads was the last one that
was not: a summary could assert a finding the gate had just deleted, in confident prose, three sections above
the list saying it was rejected. `checkConclusion` closes that with the two things that can be decided without
a reader. It splits the closing paragraph into sentences (deterministically, so a repair can answer by number)
and asks of each one: does it assert a finding this mission deleted, or one its own author withdrew, or state
a **thin-support** quote as established — and does it name a file that is in neither the index nor the
repository? Two boundaries keep it honest: the `unverified` list is exempt, because that is where a rejected
finding is *supposed* to be carried, and a hedged sentence is not an assertion — "the claim about the limit
was rejected by the server and is carried as unverified" restates the record and is not flagged, while "the
leak is fixed, because truncate() slices its input to a fixed limit" repeats the deleted finding and is.

Flagged sentences go back to the leader that wrote them, once, numbered, with the record's own words and the
repository's real file list — so "a file that is not in it" is a rule it can follow. It either rewrites a
sentence so it says only what the record supports, or gives it up with a reason (kept and shown next to the
sentence it removes). Then the *whole* paragraph is re-checked, not just the answers: a rewrite can put a new
contradiction where the old one was, and that counts as one. Nothing else in the conclusion is touched, and
a sentence that was already fine is never re-sent. One pass, never a loop — the same evidence as the other two
repairs. Turn it off with `collective.conclusionRepair: false`; the check itself always runs.

### The collective (one leader, several copies of the model, quotes checked before anyone agrees)

`collective_run { mission }` runs the whole loop in the background:

1. The **leader** reads the digest — the map, never the file contents — and cuts the mission into units,
   each owning its own files, each with concrete questions it must answer, one of them a **verifier**
   whose only job is to falsify the rest. A file the leader invents is caught here and reported.
2. The **workers** run in parallel, each as its own model call on its own packed slice of real source,
   with no memory of each other.
3. The server re-reads **every quote** they made and deletes the ones that are not in the file where they
   say they are. Worker reports that fail to obey the contract are dropped whole, not softened.
4. A citation that failed goes **back to its own unit, once**, with the server's reason and the line the
   quote actually lives at. It comes back either re-cited (re-checked at the same standard), replaced by a
   different finding, withdrawn with a reason, or unaddressed — and the dossier keeps all four apart. The
   first attempt stays in the rejected list: a repaired finding is added, never promoted.
5. The **leader closes** the mission using only the checked evidence, and must name what stays unverified.
   The dossier opens with a **verdict**: counts, not prose, computed from the gate's own results, with the
   one grade they support.
6. Every **edit** the units and the closing plan propose is checked against the file as it is now — does the
   path exist, is the anchor really in it at those lines, what imports it — before the owner ever reads it.

Everything above ends in a **verdict you can check by hand**: how many quotes the server re-read, how many
findings it rejected, how many of those are still wrong at the end, how many units produced anything usable,
whether the verifier showed up, whether the closing pass ran, and whether any sentence of its paragraph still
contradicts that record. `STRONG` needs no outstanding citation, no thin support, no silent unit, no edit that
cannot be applied as described and no sentence of the conclusion the record contradicts; `THIN` means fewer than two
verified quotes or more than half the units producing nothing; with no verified quote at all it is `NOTHING`.
A model writes none of it, so the closing paragraph cannot talk the grade up.

You get a dossier at `.design-mcp/collective/<id>.md` (job result and `collective_report`): the verdict,
what was concluded, the plan, every edit the mission proposes with what the gate said about where it lands and
what imports the file, every verified quote with its file and line, the quotes that are real but
do not visibly back their claim, everything rejected and why, the repair pass and what it fixed or withdrew,
the closing paragraph checked sentence by sentence against the mission's own record and what the conclusion
repair pass settled, conflicts between units, admitted unknowns, the cost, and what the run explicitly did **not** check. `collective_plan`
is the same leader pass on its own, when you would rather dispatch the workers yourself. The prompt
`collective_mission` writes out the protocol; `focus_contract` is the ground-rules brief for working in
this repository (also the resource `code://focus`).

Cost: one model call for the plan, one per unit, one for round two per unit, one to close. Workers default
to `roles.worker` = `session`, so the copies are instances of the model you are already talking to and no
API key is needed. Set `roles.leader`/`roles.worker` to a provider to run the collective somewhere else.
Caps live under `collective` (`maxUnits`, `maxWorkers`, `contextTokensPerWorker`, `synthesize`,
`repairRound`, `editRepair`, `conclusionRepair`, `peerRound`, `memory`, `memoryItems`, `memoryTokensInPrompt`, `keepDossiers`) and the codebase layer under
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
which are permanent and never pruned).Admission is quality-gated — a claim needs a quote the server confirmed, a quote that visibly bears on the
claim (thin support is kept out and reported), *and* a mission that reached a conclusion — and every entry is
re-checked against the file as it is now when it is loaded. Anything whose code has changed or gone is marked stale, reported, and kept out
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

Two more conclusions were read the same way and are now in the loop. **Feedback has to be specific to
work**: one targeted repair after a reliable checker rejects something beats spending the same budget on
repeated attempts ([Olausson et al.](https://arxiv.org/abs/2306.09896)), refinement gains are largest in the
first round and shrink after it ([Madaan et al.](https://arxiv.org/html/2303.17651v2)), debugging
effectiveness is reported to decay 60–80% within two to three attempts
([Hao et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC12715212/)), and a model told to review its own answer
without an external signal often makes it *worse* — GPT-3.5 on CommonSenseQA went 75.8% → 38.1% after one
unguided correction round ([Huang et al.](https://arxiv.org/html/2310.01798v2)). So the server hands a rejected
citation back to its own worker exactly once, carrying the line the quote really lives at, and never lets that
pass touch a finding that already verified — correction rounds also break answers that were right
([Chen et al.](https://arxiv.org/html/2311.08516v3): losses of 0–11.4 points on initially correct answers).
And **a check that cannot see meaning must only ever downgrade**: the thin-support label fires when a real
quote shares no wording with its claim, and it never fires the other way, because overlap is not entailment.
The label is not a reading of the passage, and it says so where it is shown.

Limits, stated because they matter: symbol extraction is lightweight (line scanning, not a type checker), so
treat a missing symbol as unknown rather than absent; `tsconfig`/`jsconfig` `paths` **are** resolved (from the
shallowest config, `extends` not followed), so anything an alias cannot reach still shows up as an external
and a repo whose aliases live behind `extends` will look partly external; the repair pass is one pass by
design and gives a worker nothing that already verified; the support label is one-sided, so shared wording is
not proof of anything; the verdict is arithmetic over citations and not a judgement of the answer; and a
verified quote proves the code says that, not that the conclusion drawn from it is correct. That is what the
project's own gates are for — which the dossier tells you to run.

Server state (index, dossiers, jobs, shots, parked prompts) all lives under `.design-mcp/` in the project
being worked on, so add it to that project's `.gitignore`.

Configuration for the two phases above lives under `skills` (`enabled`, `roots`, `maxSkillKB`,
`maxInPromptKB`) alongside the `codebase` and `collective` blocks in `src/config.ts`.

### Phase 7½: local delegation through Ollama (optional, off by default)

If a small local coder model lives on the machine (`ollama`), the collective can hand its well-scoped
implementer work to that model and keep the quality control for itself. Off by default — **with the mode
off, zero Ollama calls happen and the workflow is byte-identical**:

```bash
local_mode { set: "on" }        # health check first; refuses unless Ollama answers and the model is pulled
local_mode { set: "off" }       # immediate: aborts the request in flight, refuses every queued task
local_mode { }                  # status: mode, source, model, per-request values, lifetime counters
```

- `collective.local` in the config is the seed the flip overrides: `enabled` (OFF), `host`, `model`
  (swappable — point it at `qwen2.5-coder:7b` for an A/B), `numCtx` 8192, `temperature` 0.1,
  `numThread` 5, `keepAliveM` 5, `timeoutSec` 120, `maxConcurrent` 1, `maxFilesPerUnit` 3, and the
  audit commands `audit.typecheckCmd` / `lintCmd` / `testCmd` (auto-skipped when unset).
- **Nothing merges on the model's word.** The local model returns full file contents; the previous
  bytes are snapshotted; the write is audited in order (typecheck → lint → tests → mechanical
  import/API existence against the index → one council spec review); failure reverts byte-for-byte,
  feeds the concrete errors back ONCE, and a second failure hands the unit to the council with the
  reason — and the rejected output is kept in the dossier, labelled as not built on.
- Writes are refused outside the unit's own scope, above the file cap, or when the tree has uncommitted
  changes (`allowDirty` overrides — a revert must never eat your uncommitted work).
- Every dossier carries a **Local delegation** section and the lifetime counters (delegated /
  audit-passed / audit-rejected / fell-back) are reported by `local_mode` and the greeting, so the
  question "is the local model actually saving me time?" has a number under it.

## Phase 8: "Hello collective." — and your own skills

Open a session in a repository where this server is available, say **"Hello collective."**, and the crew is
already standing in the repo. `collective_hello` answers in one pass — **no model call, no API key, ~140 ms**
measured on the two-repo checkout this was built against — with: the roll call of seats; the state of the git
tree; what the collective already established here and what it already got wrong (stale entries named); the
recent mission dossiers; your installed skills; the digest of the repo computed from its files; and the exact
next steps, so the answer is grounded rather than improvised. The prompt `hello_collective` is the same
invocation for hosts that only honour prompts.

It is cheap because it runs at the top of every session, and it is honest about one thing in particular:

> **An MCP server cannot speak first.** Nothing in the protocol lets the collective push a message into a
> conversation that has not called it, so "it runs every time I open a new session" cannot be done from the
> server side alone. It is carried by the one thing a host already reads on its own: the repository's own
> instruction file.

`collective_install` writes one short marked block into the files the hosts actually read, telling them to
call `collective_hello` at the start of a session in that repo and whenever you say "Hello collective.":

| File | Read by |
| --- | --- |
| `AGENTS.md` | Codex, Cursor, GitHub Copilot, Windsurf, Freebuff |
| `CLAUDE.md` or `.claude/CLAUDE.md` | Claude Code — its default reads the CLAUDE file *instead of* AGENTS.md when one exists |
| `GEMINI.md` | Gemini CLI (it does not read AGENTS.md unless `context.fileName` lists it) |
| `.github/copilot-instructions.md` | GitHub Copilot, repo-wide |
| `.windsurfrules` | Windsurf, legacy single file |

One file per host family — a repo with both `CLAUDE.md` and `.claude/CLAUDE.md` gets the block in the root
one only — so no host is told twice. It only ever *creates* `AGENTS.md`, because that is the file the most
hosts read; the hosts whose own file does not exist are named in the report, with the exact
`targets: ["GEMINI.md"]`-style argument if you want them created too. Rule directories are deliberately left
alone: `.cursor/rules/*.mdc` and `.windsurf/rules/*.md` are ignored without frontmatter, so a plain block
dropped there would do nothing.

It is idempotent (a second install writes nothing), it never touches a character outside its own markers,
`action: "show"` previews without writing, and `action: "remove"` takes it back out of every file it wrote.
If your host ignores instruction files, the block is inert and the greeting still works the moment anything
calls it — and if you have no API keys at all, none of this needs one.

### Your skills, and what "run a skill" can honestly mean

`skills_list` (resource `code://skills`) finds every `SKILL.md` under `skills.roots` — by default your
Freebuff account skills plus the usual `~/.claude/skills`, `~/.codex/skills` and project `.claude/skills`,
`.cursor/skills`, `skills` folders. On the machine this was written on it finds 37 distinct skills in ~140 ms
(duplicate copies of a name are reported as one skill, with the other paths named). `skills_read` returns one
in full, and `code://skills` lists them all.

A skill is **instructions**, not a tool, and not evidence. So:

- A collective unit is assigned one with `skill` on the plan (or `skills` on `collective_run` to choose which
  the leader may offer). The text is read at dispatch time — only for the units that were actually assigned
  it — and goes into that worker's prompt, where it is labelled as *how to work*, never as *what is true*:
  nothing in a skill can be cited as a fact about your code, and if the skill and the source disagree, the
  source wins. The dossier records which unit followed which skill, and a skill the leader names that cannot
  be found is a warning rather than a silent no-op.
- **Nothing executes a skill.** Not the discovery, not the assignment, not the mission. This server will walk
  your directories and paste text into a prompt; it will not run the commands a skill suggests, because a
  tool that runs whatever a model asks it to run is a hole in every project the server is pointed at. The
  execution stays with the host that already has a terminal and your approval — which is also how skills are
  meant to work: the model reads the instructions and then does the work itself.

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
