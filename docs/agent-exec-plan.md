# Phase 9 — `agent_run`: an opt-in model with hands

**Status:** **built** (M0–M6). `src/agent/` exists, `agent_run` is the 38th tool, and the keyless gate is 511
checks: 306 (stdio) + 174 (arithmetic, including the agent's resolver, command policy, revert and a scripted
loop) + 31 (`smoke/agent-e2e.mjs`: three whole runs against a stub Ollama — one kept, one reverted
byte-for-byte, one kept in worktree isolation whose change never reaches the owner's checkout). It was written against the tree at `97a87ad` and every file reference below was read, not
remembered.

**Deviations from the plan, all named rather than hidden**
- **M5 (worktree isolation) is built differently from the sketch.** Instead of handing back a patch and leaving a
  worktree behind, the run removes its scratch checkout once the record and the patch are written; `node_modules`
  is symlinked from the real tree so the project's own tests can run there. It is tidiness, not a sandbox, and
  the report says so.
- **The council diff review fails closed.** It needs a host that answers MCP sampling; where it cannot (Freebuff's
  MCP client, Cursor) a run is reverted unless `agent.gates.councilReview: false`, and the report says the diff
  was never read. This is the honest behaviour, not the convenient one.
- **`allowlist` matching is argv-prefix on whitespace-split tokens**, with shell metacharacters refused first;
  an entry like `node` therefore allows `node <anything>`. The defaults keep `npm test` / `git status` in
  front of that, and the plan's own note applies: an allow list is a guard rail, not a sandbox.
- **Two config fields became real checks rather than documentation:** `maxDiffFiles` / `maxDiffLines` now fail
  a run at the gate, and `agent_run` with no task returns the mode, model, roots and lifetime counters.
- **The gate's diff review is one `askJson` call on the host model**, the same shape as `delegate.ts`'s spec
  review; the patch a refused run keeps is `git diff` plus the full text of files that git does not track yet.

**What it is:** a second, separate way to use the local model — not a change to `local_mode` / `delegate.ts`.
`delegate.ts` gives a model one blind turn over a slice the server chose and keeps the output only if a
deterministic ladder approves it. `agent_run` gives a model a loop over `/api/chat` where it can read, search,
write inside named directories and run commands, and then it must pass **the same end-of-run gate** before a
byte of it stays.

**What it is not:** a rewrite of delegation, a replacement for the collective, or a sandbox.

---

## 1. The rule this asks you to change

`AGENTS.md:313` currently says:

> do not give the server a general command runner to "run" a skill with: the host already has a terminal, and a
> tool that executes whatever a model asks for is a hole in every project this server is pointed at.

That rule is right, and this feature is the exception to it — so it gets amended explicitly rather than
quietly routed around. Proposed replacement, to live in `AGENTS.md` under a new **`## Hands: agent_run`**
section, with the old sentence kept as the reason the default is what it is:

```markdown
## Hands: `agent_run` (opt-in, config-gated, diff-gated)
The server does not expose a general command runner. `agent_run` is the single, deliberate exception, and
it exists only when the owner turns it on in `design-mcp.config.json` (`agent.enabled: true`). There is no
runtime flip and no tool that enables it: a model must never be one call away from giving itself a shell.
When it runs, it is confined to the project, its writes are restricted to `agent.writeRoots`, every command
is journaled with its exit status, every file it touches is snapshotted before the first write, and the
whole run is reverted byte-for-byte unless the edit gate, one council diff review and the project's own
tests all pass. It is not a sandbox: `agent.bash.mode: "shell"` is equivalent to handing that model your
terminal in that directory, and the honest protection is the revert plus the review, not the path checks.
The rule above still governs everything else: skills, missions and memory get no command runner.
```

Two follow-on edits that the same change requires:

- `README.md` gains **Phase 9** next to Phase 7½, with the same "off by default, zero calls when off" promise.
- `AGENTS.md` **Map** gains `src/agent/`, and the tool count line changes from 37 to 38
  (`15 + 6 + 10 + 5 + 1 local_mode + 1 agent_run`), because `smoke/smoke.mjs` asserts the inventory from its
  own list (`smoke/smoke.mjs:327` and the block around it) and has drifted twice before.

If you are not willing to make that rule change in writing, stop here: option A (read-only loop) is the
version that needs no exception, and it is a different, smaller plan.

---

## 2. Non-goals

- **Not a network client.** No `fetch`, no package installs, no `git push` / `git commit` / `git reset`.
- **Not a background daemon.** One run at a time per project, bounded by wall clock, then it reports.
- **Not a second model provider path.** It speaks Ollama (`/api/chat`) only. Host sampling stays the
  collective's, and no API key is involved.
- **Not a sub-agent spawner.** The tool surface has no `spawn`.
- **Not the default.** `enabled: false`. With it off, zero Ollama calls, exactly like `local_mode`.

---

## 3. Threat model, in one page

| Risk | Defence | Residual |
|---|---|---|
| Writes outside the project | `realpath` containment + `..`/absolute refusal + symlink-escape check, on **every** path argument | A shell command can write anywhere the OS user can. Path checks only bind the file tools. |
| Reads your secrets | read-deny list (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `.git/config`, `.design-mcp/*`) | A shell command can `cat` them. Same caveat. |
| Runs `rm -rf` | `bash.mode` default `allowlist`; `shell` needs config **and** `DESIGN_MCP_AGENT_SHELL=1`; deny-patterns still applied in shell mode | A shell is a shell. |
| Corrupts your uncommitted work | clean-tree requirement by default; per-file pre-image snapshot on first touch; revert restores bytes exactly and deletes files it created | A command that rewrites a file *and* the snapshot itself is impossible (snapshot dir is read-denied to tools, outside `writeRoots`), but a command can write outside `writeRoots` — the end-of-run `git status` diff catches it, after the fact. |
| Ships a bad change | end-of-run gate: `verifyEdits` anchors → council diff review → project tests → else revert + patch kept | The gate judges the diff, not the intent. |
| Gives the model a foothold it keeps | no config writes, no `agent.enabled` toggle, no memory writes, no skill execution | — |
| Runs forever | `maxRounds`, `maxWallClockSec`, per-command timeout, stall reporting in `design_status` | — |
| Leaks your code | model choice is the owner's; `:cloud` models send slices to `ollama.com` (`isCloudModel`) and the status line says so | — |

The sentence to keep wherever this is described: **this is confinement and reversibility, not isolation.**
A real sandbox means running the server inside one (container, `firejail`, a VM); `isolation: "worktree"` is
for tidiness, not security.

---

## 4. Configuration

New top-level block in `src/config.ts`, after `local` (`src/config.ts:177`), defaulted so that an old config
file changes nothing:

```ts
agent: z.object({
  // The one flip. Config file only, on purpose: no tool and no runtime toggle may turn this on, because a
  // model that can enable its own executor has no gate left in front of it.
  enabled: z.boolean().default(false),
  host: z.string().default("http://127.0.0.1:11434"),
  // Must be a tools-capable model (qwen2.5-coder, qwen3, devstral, llama3.1). Checked against /api/tags
  // at start, and refused with the list Ollama actually has when it is missing.
  model: z.string().default("qwen2.5-coder:14b"),
  // Tool transcripts are bigger than one file slice: this is the reason the default is larger than local's.
  numCtx: z.number().int().min(4096).max(262144).default(32768),
  temperature: z.number().min(0).max(2).default(0.1),
  numThread: z.number().int().min(1).max(64).default(5),
  keepAliveM: z.number().int().min(1).max(240).default(5),
  maxOutputTokens: z.number().int().min(256).max(32768).default(4096),
  timeoutSec: z.number().int().min(30).max(900).default(180),   // one model call
  maxRounds: z.number().int().min(1).max(60).default(24),       // model turns, not tool calls
  maxToolCalls: z.number().int().min(1).max(200).default(60),   // total tool invocations
  maxWallClockSec: z.number().int().min(60).max(3600).default(900),
  // Every write must land under one of these, relative to the project root. Empty = the file tools refuse
  // to write anything at all (read-only run), which is the honest default for a repo you have not named.
  writeRoots: z.array(z.string()).default([]),
  requireClean: z.boolean().default(true),
  // "worktree" runs on a throwaway git worktree so the owner's tree is never touched; "in-place" writes here
  // and relies on the snapshot. Neither is a security boundary.
  isolation: z.enum(["in-place", "worktree"]).default("in-place"),
  maxWriteKB: z.number().int().min(1).max(2048).default(256),    // one written file
  maxDiffFiles: z.number().int().min(1).max(64).default(8),
  maxDiffLines: z.number().int().min(10).max(4000).default(400),
  bash: z.object({
    // "off" = no command tool at all; "allowlist" = argv-matched allow list; "shell" = a real shell, opt-in.
    mode: z.enum(["off", "allowlist", "shell"]).default("allowlist"),
    allow: z.array(z.string()).default([
      "npm test", "npm run build", "npm run smoke", "npx tsc --noEmit", "npx eslint",
      "node ", "git status", "git diff", "git log", "git show", "ls", "cat", "rg", "find", "wc",
    ]),
    timeoutSec: z.number().int().min(5).max(900).default(120),
    maxOutputKB: z.number().int().min(1).max(256).default(32),
    // Passed through from the server's env. Anything not named is dropped, which is how an API key in the
    // shell does not become an API key in the transcript.
    env: z.array(z.string()).default(["PATH", "HOME", "TMPDIR", "LANG"]),
  }).default({}),
  // Reuses local.audit's commands; separate only because the agent may run them during the loop.
  gates: z.object({
    runTests: z.boolean().default(true),
    runTypecheck: z.boolean().default(true),
    councilReview: z.boolean().default(true),
    timeoutSec: z.number().int().min(30).max(3600).default(600),
  }).default({}),
}).default({}),
```

Example opt-in, and the only way to do it:

```jsonc
// design-mcp.config.json
"agent": {
  "enabled": true,
  "model": "qwen2.5-coder:14b",
  "writeRoots": ["src/playbook", "smoke"],
  "bash": { "mode": "allowlist" }
}
```

`writeRoots` is deliberately not defaulted to `["src"]`: a repo whose owner never thought about it should get
refusals, not a model editing `src` because it was convenient.

---

## 5. Tool surface

Every tool returns a JSON object (never prose) plus a `journaled` flag; failures are returned to the model as
text with a reason it can act on — the same feedback discipline as `delegate.ts`'s retry, except the model
gets it immediately instead of after an audit.

| Tool | Mutates | Input | Notes |
|---|---|---|---|
| `read_file` | — | `{path, startLine?, endLine?}` | 400-line default window, `maxFileKB` cap, read-deny list |
| `list_files` | — | `{path?, depth?, limit?}` | reuses `listFiles` (`src/codebase/scan.ts:122`) so `.gitignore` still decides |
| `search` | — | `{pattern, glob?, maxResults?}` | bounded regex over indexed files; caps at 50 matches, 200 chars per match line |
| `who_refs` | — | `{name}` | wraps `findReferences` (`src/codebase/refs.ts`) and repeats its own caveat: text scan, not semantic |
| `read_context` | — | `{query, tokens?}` | wraps `packContext` (`src/codebase/pack.ts`) for "show me the area" without 20 reads |
| `write_file` | yes | `{path, content}` | full content; must be readable first if it exists; pre-image on first touch |
| `edit` | yes | `{path, anchor, replacement}` | anchor must occur **exactly once** (whitespace-normalised), same rule as the edit gate; ambiguous → refused with the count |
| `run` | yes | `{command, cwd?}` | policy per `agent.bash`; journaled with exit code, duration, truncated output |
| `run_audit` | — | `{which?: "typecheck"\|"lint"\|"test"}` | only the configured commands; the same code path as `auditDeterministic` (`src/ollama/delegate.ts:195`) |
| `finish` | — | `{summary, edits?}` | ends the loop with the model's own account; the gate does not trust it |

Deliberately absent, and the absence is the design: `delete` (a run may propose a deletion in `summary`;
the owner applies it), `git commit`/`push`/`reset`, `install`, `http`, `spawn`, `env`, and any tool whose
argument is a command string other than `run`.

`write_file` on an existing file requires it to have been read in this run. That one rule kills most
"rewrote the file from a guess" failures, and it is cheap: one Set of paths in the session.

---

## 6. The loop

`POST /api/chat`, not `/api/generate` — the latter has no `tools` parameter at all, which is why
`src/ollama/client.ts:198` cannot be extended and this needs its own client. Request shape:

```ts
{
  model, stream: false,                       // streaming comes later; not with tool calls in v1
  messages,                                   // system, user(task), then assistant/tool turns
  tools: TOOL_SCHEMAS,                        // JSON-schema function definitions
  ...(cloud ? {} : { keep_alive: `${keepAliveM}m` }),
  options: { temperature, num_ctx: numCtx, num_predict: maxOutputTokens, ...(cloud ? {} : { num_thread: numThread }) },
}
```

`format: "json"` is **not** sent in this mode: structured-output mode and tool calling fight over the same
token stream, and the tool calls are already structured.

Turn handling (`src/agent/loop.ts`):

1. Send `messages`. Read `message.tool_calls`.
2. **No tool calls** → the assistant text is the run's account; break to the gate.
3. For each call, in order: validate against the schema, execute, append
   `{role: "assistant", content, tool_calls}` then one `{role: "tool", tool_name, content}` per result.
   Read-only calls may run in parallel; mutating calls never do (order is part of the record).
4. A refused call (bad path, policy, ambiguity) returns `{"refused": "<reason>"}` — it is fed back, not
   fatal. Three refusals of the same tool with the same arguments is a stall: the loop ends and reports it.
5. Stop on: `finish`, no tool calls, `maxRounds`, `maxToolCalls`, `maxWallClockSec`, a model-call timeout,
   `cancelAll()` (agent mode shares the transport's generation counter), or the tree going dirty underneath
   us (checked before each write, cheap: the same stamp logic in `store.ts`).

**Context policy, deterministic and stated in the log.** Transcripts outgrow `numCtx` long before
`maxRounds`. Rule: system + task + the last 6 tool results verbatim; older tool results are clipped to their
first 20 and last 40 lines with a `… clipped N lines (aged out of context) …` marker; a file already sent
and unchanged is not re-sent (one content hash per path); `estimateTokens` (`src/codebase/store.ts:53`) is
the meter. No model-side summarisation: it costs a call and it makes two runs of the same task
irreproducible.

**No retries.** One model call, one chance; a timeout ends the run with the transcript intact. Retrying
inside a loop that already re-reads the world is how a 15-minute run becomes an hour.

---

## 7. Confinement

`src/agent/sandbox.ts`, one door for every path, mirroring `src/ollama/delegate.ts:107`'s
`resolveInProject` and strengthening it:

```ts
// Returns null (refused) or an absolute path whose REAL path is inside the project root.
export async function resolveRead(root: string, rel: string): Promise<string | null>;
export async function resolveWrite(root: string, rel: string, writeRoots: string[]): Promise<string | null>;
```

- Reject absolute paths, drive letters, `..` after normalisation, empty paths, NUL bytes.
- `realpath` the deepest **existing** ancestor (a write to a not-yet-created file resolves its parent), then
  require the result to be inside the project root. That is the symlink-escape check, and it must be
  `realpath`, not `path.resolve` — the difference is the whole bug.
- Writes additionally require the resolved path to be under one of `writeRoots` (resolved the same way), and
  should not segfault on `writeRoots` entries that do not exist yet.
- Hard deny, read and write, regardless of config: `.git/`, `node_modules/`, `.design-mcp/`, `dist/` (a build
  output is regenerated, not edited), and the secret list in §3.
- A refusal names the rule it hit (`outside the project`, `outside writeRoots (src/playbook, smoke)`,
  `write to .env is refused: secrets are not readable by this tool`), because the model can only correct what
  it is told.

**Command policy** (`src/agent/bash.ts`):

```ts
export type Verdict = { ok: true; argv: string[] } | { ok: false; reason: string };
export function judge(command: string, cfg: AgentConfig["bash"]): Verdict;
```

- `off` → the `run` tool is not advertised at all.
- `allowlist` → normalise whitespace, refuse shell metacharacters outright (`|`, `&&`, `;`, `>`, `<`, backtick,
  `$(`, `\n`), split argv, then require the argv prefix to match one of `allow` (so `npm test -- sm` is
  allowed and `npm test; curl …` is not). No shell, `shell: false` in `run()`.
- `shell` → a real `/bin/sh -c` **only** when `process.env.DESIGN_MCP_AGENT_SHELL === "1"` (a second,
  out-of-band switch, so a config file copied from a gist cannot arm it). Deny patterns still apply
  (`rm -rf /`, `sudo`, `git push`, `git reset --hard`, `git clean`, `chmod 777`, `curl … | sh`, `npm i -g`).
  The plan is honest that this is advisory.
- Both modes: `cwd` must resolve inside the project; env is the `agent.bash.env` subset plus
  `CI=1 NO_COLOR=1 FORCE_COLOR=0`; output is tail-truncated to `maxOutputKB` with a `… truncated` marker;
  every call is journaled (`command`, `cwd`, `code`, `ms`, `timedOut`, `verdict`, first 2000 chars of output).

`run_audit` bypasses the allowlist because the commands come from the owner's config, not from the model —
but it is journaled the same way and refuses a `which` that is not configured.

---

## 8. Snapshot, journal, revert

Two files under `.design-mcp/agent/<runId>/`:

- `journal.jsonl` — append-only, one line per event: `tool_call`, `write` (with `beforeSha`, `afterSha`,
  `existed`), `command`, `refusal`, `gate`. Written before the effect, not after, so a crash mid-write is
  recoverable.
- `pre-images/` — the first bytes of every file the run touches, keyed by sha256, plus an index. Written by
  the **server** directly (`fs.writeFile`, not through the tool layer), so no tool can read or rewrite them.
  Capped at 20 MB per run; exceeding the cap ends the run with `snapshot-cap` rather than silently skipping a
  pre-image.

Revert is exact: for every path in the journal with a pre-image, restore the bytes; for every path recorded
`existed: false`, unlink. Then `git status --porcelain` again and compare to the start — anything left is
named in the report as `outside the journal` (which is what a shell-writing-outside-writeRoots looks like).

`requireClean: true` refuses to start on a dirty tree, same rationale as `local.allowDirty` in
`src/ollama/delegate.ts`: a revert must never be able to eat work that was never ours. When the owner sets
`requireClean: false`, the snapshot covers files the tools touch, and the report says plainly that the run
started dirty.

`isolation: "worktree"` (M5): `git worktree add .design-mcp/agent/<runId>/tree HEAD` on a throwaway branch,
run there, and on success hand back a patch (`git diff` against the tree's base) instead of touching the
owner's checkout. Caveats to document: `node_modules` is not there (symlink it, and say so), so a test run in
that mode may need `npm ci` first; and it is *tidiness*, not a security boundary.

---

## 9. End-of-run gate (the reason this is allowed to exist)

Four steps, in this order, and any failure reverts:

1. **Edit gate.** Build a `ProposedEdit[]` from the journal (`source: "agent"`, `sourceIndex` = position,
   `anchor` = the replaced text for `edit` calls; `write_file` calls are `unanchored` and say only that the
   path exists) and call `verifyEdits` (`src/collective/edits.ts:208`) against the **pre-run** index. Refuse
   to keep a run with any `broken` edit. This is reuse, not a new gate.
2. **Council diff review.** One `askJson` call at temperature 0 (the same shape as `specReview`,
   `src/ollama/delegate.ts:424`), given the task, the diff, and the write scopes: does it do the task, no
   invented APIs, no scope creep, no silent behaviour change. `pass`/`fail` + issues. Called out in the
   dossier as one reading, not proof.
3. **The project's own gates.** `npm test` (this repo's real gate) and a typecheck, through `run()`, with the
   tail of the output in the dossier. Same discipline as any other change here: a build is not a test.
4. **Outcome.**
   - all three pass → `kept`; the tree holds the change, the dossier names what was verified by running.
   - render or review fails → `reverted`; the diff is also written to `.design-mcp/agent/<runId>/proposed.patch`
     so the work is not destroyed, and the report says `git apply .design-mcp/agent/<id>/proposed.patch` to
     read it yourself.
   - the snapshot or the revert itself fails → `unsafe`, the loudest outcome, with the affected paths listed
     and a pointer to version control. `src/ollama/delegate.ts` already treats a failed revert this way; this
     keeps that instinct.

The dossier (`.design-mcp/agent/<runId>.json`) keeps: the task, model, rounds used, every command, every
refusal, the diff, the gate results, wall clock, and the counters. The verdict is arithmetic (rounds, refusals,
gate results), never the model's own `summary`.

---

## 10. Jobs, lock, status, counters

- `agent_run` returns immediately with a job id and the first log lines (`startJob("agent", …)`,
  `src/jobs.ts`), and the host polls `design_status`, exactly like `collective_run`. A synchronous call would
  hold one MCP request open for 15 minutes and would be indistinguishable from a hang.
- One run per project: `.design-mcp/agent/lock` holds `{pid, runId, startedAt}`; a second `agent_run` refuses
  with the age of the first, and a lock older than `2 × maxWallClockSec` is reported as stale (not silently
  stolen).
- `design_status` already reports a stalled job by its last log line (`jobIsStalled`); the agent logs every
  round and every tool call, so a stall is diagnosable without new machinery.
- Counters in `.design-mcp/agent-state.json`, same read-modify-write shape as
  `src/ollama/state.ts:bumpCounters`: `runs`, `kept`, `reverted`, `unsafe`, `rounds`, `commands`,
  `refusals`, `localMs`, `wallMs`. Reported by the greeting (`collective_hello`), by the run's report, and
  by `local_mode`'s status paragraph when agent mode is enabled — one line, so "is this thing earning its
  keep?" has a number under it, which is the same standard Phase 7½ set.

---

## 11. File map

**New — `src/agent/`**

| File | Responsibility |
|---|---|
| `config.ts` | reads/validates `agent` from config; the env second switch for shell mode; `health()` reuse |
| `sandbox.ts` | `resolveRead` / `resolveWrite`, deny lists, secret list — unit-testable, no I/O beyond `realpath` |
| `bash.ts` | `judge()`, allowlist matching, deny patterns, env subset (pure function; this is what `smoke/arithmetic.mjs` drives) |
| `journal.ts` | append-only journal, pre-image store, `revert()`, patch export |
| `tools.ts` | the ten tool implementations + `TOOL_SCHEMAS` (JSON Schema, hand-written — no new dependency) |
| `loop.ts` | `/api/chat` transport, turn loop, context policy, stop conditions |
| `gate.ts` | `verifyEdits` wiring, diff review, project gates, outcome |
| `report.ts` | the human-readable run report and the dossier writer |
| `index.ts` | `runAgent()` — the orchestration `src/index.ts` calls |

**Edited**

- `src/index.ts` — register `agent_run` (title, description that says out loud what it can do and that it is
  config-gated, `inputSchema: { task, writeRoots?, maxRounds?, dryRun?, resume? }`), stats renderer; one import.
- `src/config.ts` — the `agent` block.
- `src/collective/hello.ts` — one line in the local-delegation paragraph saying agent mode is on/off and its
  lifetime counters (cheap, already reads state files once).
- `src/jobs.ts` — nothing, probably; `kind: "agent"` rides the existing shape.
- `smoke/smoke.mjs` — inventory list (`:327`), plus the agent-mode section (§12).
- `smoke/arithmetic.mjs` — direct unit tests of `judge` and the path resolver.
- `AGENTS.md`, `README.md` — §1's rule text, map entry, Phase 9 section.
- `.gitignore` guidance in README — `.design-mcp/` already covered.

No new dependencies. No `dist/` hand edits (it is generated, though committed).

---

## 12. Invariants, and the test that holds each

These are the assertions the keyless gate must make. A stub Ollama server (an `http.createServer` returning
scripted `tool_calls`) is enough to drive the loop without a model, exactly as `smoke/smoke.mjs` drives
missions with a stub host and `smoke/arithmetic.mjs` drives the built modules directly.

| # | Invariant | Test |
|---|---|---|
| 1 | `agent.enabled: false` → the tool refuses at call time, **zero** HTTP requests | stub counts requests; expect 0 |
| 2 | No tool or argument can enable agent mode | call `agent_run` with `{enabled: true}` → schema rejects; grep that no writer sets `agent.enabled` |
| 3 | `../` , absolute, symlink-escape, `.git/`, `.env`, `node_modules/` are refused, with the matching reason | `arithmetic.mjs` on `resolveRead`/`resolveWrite` against a fixture with a symlink pointing out of the tree |
| 4 | A write outside `writeRoots` is refused and leaves the tree untouched | scripted call + `git status` before/after |
| 5 | `write_file` on an unread existing file is refused | scripted call |
| 6 | An ambiguous `edit` anchor is refused, naming the occurrence count | scripted call with a 3× anchor |
| 7 | `bash.mode: "allowlist"` refuses `npm test; curl x`, `rm -rf`, `$(...)`, and allows `npm test -- sm` | `judge()` table test |
| 8 | `bash.mode: "shell"` without `DESIGN_MCP_AGENT_SHELL=1` is refused at startup, not at call time | env-unset test |
| 9 | Revert is byte-perfect: modified, created and deleted-by-command paths all restored; hashes equal | fixture write cycle + sha256 |
| 10 | A failing project gate reverts and writes `proposed.patch` | stub with a deliberately failing test cmd |
| 11 | `verifyEdits` blocks a kept run when an anchor is not in the file | scripted edit with a fabricated anchor |
| 12 | Round/tool/wall-clock caps end the run and report which cap fired | stub that always calls a tool |
| 13 | The journal never contains an env value outside the allowlist | set a fake `ANTHROPIC_API_KEY`, assert it is not in `journal.jsonl` |
| 14 | A stale lock is reported, not stolen; a live lock refuses a second run | two sequential calls |
| 15 | `design_status` reports a running/stalled agent job with its last line | job file + clock injection |

And the ordinary gate still has to pass: `npm test`, with the tool count in `AGENTS.md` and in
`smoke/smoke.mjs` agreeing at 38.

---

## 13. Phasing

Each milestone ends with `npm run build && npm test` green and a commit; none of them is allowed to leave the
gate red for a later milestone to fix.

**M0 — the exception, in writing (½ day).** AGENTS.md rule + map, README Phase 9 (marked "not implemented"),
config block with `enabled: false` and no tool. Nothing can run yet. Acceptance: gate green, config parses,
`agent` block absent from old configs changes nothing.

**M1 — read-only loop, job, journal (1–1.5 days).** `/api/chat` client with tools, `read_file`/`list_files`/
`search`/`who_refs`/`read_context`, context policy, caps, journal, `agent_run` + `design_status` wiring,
stub-server smoke tests for #1, #3 (read half), #12, #13, #15. No write tool exists. Acceptance: a scripted
stub run reads two files and finishes; a run with `enabled: false` makes zero requests; the report names
rounds and tokens.

**M2 — writes, snapshot, revert, edit gate (1.5 days).** `write_file`/`edit`, `writeRoots`, pre-images,
journal-before-effect, `gate.ts` steps 1 and 4-minus-tests, patch export. Tests #4–#6, #9, #11. Acceptance:
a scripted run that edits a fixture file is kept; the same run against an ambiguous anchor reverts with
hashes unchanged.

**M3 — commands (1 day).** `bash.ts`, `run`, `run_audit`, both modes, env subset, deny patterns, timeouts.
Tests #7, #8. Acceptance: allowlist table passes; a refused command reaches the model as a reason and the run
continues.

**M4 — the full gate and the dossier (1 day).** Council diff review, project tests, outcome taxonomy
(`kept`/`reverted`/`unsafe`), dossier, counters, greeting line. Tests #10, #14. Acceptance: a run that breaks
the fixture's test reverts, keeps `proposed.patch`, and the report says exactly which command failed with its
tail.

**M5 — optional isolation (½ day).** `isolation: "worktree"` + patch handoff, `node_modules` caveat, docs.

**M6 — the honest paperwork (½ day).** README Phase 9 with measured numbers (rounds, wall clock, keep rate on
2–3 real tasks in this repo), AGENTS.md invariants block, tool count, and a paragraph titled "what this does
not protect you from" (§3's residual column, in prose).

Estimated total: **5–6 focused days**, of which M1+M2 are the ones worth doing alone — read-only plus
snapshot/revert is already a useful, safe tool, and M3 is where you should stop and reconsider if the keep
rate is poor.

---

## 14. Decisions only you can make

1. **Default `bash.mode`.** Recommended: `allowlist`, with `npm test` and `git status` in it. `shell` is a
   different product with a different risk statement.
2. **May it install packages / touch lockfiles?** Recommended: no in v1 — an install is the one command that
   makes the audit environment non-reproducible, and it is easy to add later.
3. **May it delete files?** Recommended: no; `summary` proposes, you delete. A file deletion is the only
   change a revert is least likely to be noticed in time.
4. **`writeRoots` default.** Recommended: empty (read-only until named). The alternative — `["src"]` — is
   convenient and is exactly how a model ends up editing a directory you were not thinking about.
5. **In-place or worktree default?** Recommended: in-place with `requireClean: true`; worktree for anyone who
   wants to run this on a repo they care about while they are also working in it.

---

## 15. What this buys, and what it costs

**Buys:** the local model can look things up instead of being handed a slice — which is the single largest
quality difference between `delegate.ts` and a coding agent — and a run leaves a reviewable artifact (journal,
diff, gate results, patch) even when it is reverted.

**Costs:** wall clock. Each round re-sends the transcript; at `numCtx 32768` and one model at
`maxConcurrent 1`, a 12-round run is 12 generations plus the diff review, which on a 14B model on a laptop is
10–20 minutes. On `beam:cloud` it is faster and no longer local, and the slices leave the machine — the status
line must keep saying so, as it does for `local_mode` today.

**Does not buy:** correctness. The gate judges the diff against the task and the tests; it cannot tell you the
change is the right design. That is the owner's reading, and the dossier is written for it.
