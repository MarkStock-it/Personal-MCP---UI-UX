import { spawn } from "node:child_process";

export interface RunResult { code: number | null; out: string; timedOut: boolean }

/**
 * Run a command, capture combined output (child output is piped, never inherited, so MCP stdout stays clean).
 *
 * `shell` defaults to true on Windows because npm/npx/tsc/eslint are `.cmd` shims there and cannot be spawned
 * directly — but a shell concatenates the args instead of escaping them (Node warns about exactly this), so
 * a path with `&` or `^` in it stops being a path. A real executable such as git takes `{ shell: false }`:
 * one less process, args that stay args, and no DEP0190 on the server's stderr.
 */
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  // `env` is an explicit replacement for the child's environment, used by the agent's command tool: it passes
  // only the names in `agent.bash.env`, so an API key in the server's environment never reaches a command it
  // runs, and never lands in the transcript. Omitted, the child inherits the server's environment as before.
  opts: { shell?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let out = "";
    let timedOut = false;
    const env = opts.env ? { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...opts.env } : { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
    const child = spawn(cmd, args, { cwd, shell: opts.shell ?? win, env });
    const add = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + String(e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}
