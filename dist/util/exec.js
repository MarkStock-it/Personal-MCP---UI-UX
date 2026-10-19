import { spawn } from "node:child_process";
/**
 * Run a command, capture combined output (child output is piped, never inherited, so MCP stdout stays clean).
 *
 * `shell` defaults to true on Windows because npm/npx/tsc/eslint are `.cmd` shims there and cannot be spawned
 * directly — but a shell concatenates the args instead of escaping them (Node warns about exactly this), so
 * a path with `&` or `^` in it stops being a path. A real executable such as git takes `{ shell: false }`:
 * one less process, args that stay args, and no DEP0190 on the server's stderr.
 */
export function run(cmd, args, cwd, timeoutMs, opts = {}) {
    return new Promise((resolve) => {
        const win = process.platform === "win32";
        let out = "";
        let timedOut = false;
        const child = spawn(cmd, args, { cwd, shell: opts.shell ?? win, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
        const add = (d) => {
            out += d.toString();
            if (out.length > 200_000)
                out = out.slice(-200_000);
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
