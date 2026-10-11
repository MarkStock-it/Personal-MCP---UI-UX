import { spawn } from "node:child_process";

export interface RunResult { code: number | null; out: string; timedOut: boolean }

/** Run a command, capture combined output (child output is piped, never inherited, so MCP stdout stays clean). */
export function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let out = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, shell: win, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
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
