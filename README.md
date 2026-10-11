# design-mcp (Phase 6: your own assistant as the model)

Switchable text + image provider layer behind an MCP server. Design generation arrives in later phases.

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
No API keys needed: `npm run build && npm test` runs the stdio smoke suite (15 checks: tool list, config report, brief create/validate/never-overwrite, and every graceful error path).
With keys, in Cursor chat: "run providers_config", then "run providers_test for each role", then "usage_report".
Or: `npm run inspect`.

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

## Phase 5 workflow
9. `design_critique <id>`: sends the variation's approved concept, its test report and up to 3 screenshots (first desktop, first mobile, last desktop) to the critic model for an art-director review — concept drift first, then what the gates missed. Saved to `.design-mcp/critiques/<id>.md`. Uses critic-model tokens; very long pages may have frames skipped (noted in the output).

Gates (blocking unless noted):
- **Mobile:** no sideways scroll at 390px and 360px, tap targets at least 24x24px, no text under 11px.
- **Accessibility:** axe audit (serious/critical block; minor listed), keyboard focus visibly changes, `prefers-reduced-motion` respected (no smooth scroll, no infinite animations), text never left invisible after scrolling, lang/title/one h1.
- **Runtime:** script errors and broken local files always block.
- **Performance (warning only by default):** page weight, LCP/CLS/blocking time, scroll frame times. Headless numbers are relative, not absolute.

Change which groups block with `test.strictGroups` (e.g. add "perf"), and budgets with `test.budgets`.
