/**
 * The command policy: one function, called before anything is spawned.
 *
 * Three modes, and the difference between them is the whole risk statement:
 *   - `off` — the tool is not advertised at all;
 *   - `allowlist` — no shell is involved (`spawn` with an argv array), so nothing concatenates. Shell
 *     metacharacters are refused BEFORE the argv split, because `npm test; curl …` must not become two
 *     commands that happen to start with an allowed one;
 *   - `shell` — a real `/bin/sh -c`. It needs the config AND `DESIGN_MCP_AGENT_SHELL=1`, because a config file
 *     copied from a gist must not be able to arm it on its own. The deny patterns below still apply, and they
 *     are advisory: a shell is a shell.
 *
 * The allow list matches argv PREFIXES, so `npm test -- smoke` passes when `npm test` is allowed and
 * `npm testx` does not. An entry that ends in a space (`node `) means "any arguments" and is kept for the
 * defaults, where the intent is the interpreter, not one exact invocation.
 *
 * Exported as a pure function so the gate can assert the table without spawning anything.
 */

export type BashMode = "off" | "allowlist" | "shell";

export interface BashPolicy {
  mode: BashMode;
  allow: string[];
}

export type Verdict =
  | { ok: true; argv: string[]; shell: boolean }
  | { ok: false; reason: string };

/** A shell metacharacter makes the command ambiguous to this module, so it is refused, not parsed. */
const META = /[|&;<>`$\n\r]/;

/** Commands refused even in `shell` mode. Advisory by construction: patterns cannot be a sandbox. */
const DANGEROUS: { re: RegExp; why: string }[] = [
  { re: /(^|\s)rm\s+-[a-zA-Z]*[rR]/, why: "recursive delete" },
  { re: /(^|\s)(sudo|doas)\b/, why: "privilege escalation" },
  { re: /(^|\s)git\s+(push|reset\s+--hard|clean|rebase\s+--abort)/, why: "git history or remote changes" },
  { re: /(^|\s)git\s+checkout\s+(--\s+)?\./, why: "discarding the working tree" },
  { re: /\bcurl\b[^|]*\|\s*(sh|bash|zsh)/, why: "piping a download into a shell" },
  { re: /(^|\s)chmod\s+777/, why: "world-writable permissions" },
  { re: /(^|\s)npm\s+(i|install)\s+-g/, why: "global install" },
  { re: /:\s*\(\s*\)\s*\{/, why: "fork bomb" },
  { re: />\s*\/dev\/(sd|nvme)/, why: "writing to a block device" },
];

/** The env a command sees: only the names the owner allowed, and none of them may look like a credential. */
export function envSubset(source: NodeJS.ProcessEnv, allow: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allow) {
    const value = source[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * The file tools cannot read a secret; a command must not be the way around that. This is a name check on the
 * command text — it catches `cat .env` and `rg token .npmrc`, and it does not catch an obfuscated path. That is
 * why `allowlist` is the default and `shell` is armed twice: the check is a guard rail, not a sandbox.
 */
export function secretMention(command: string): string | null {
  const secrets = /(^|[\s"'=:])(\.env(\.[\w.-]+)?|\.npmrc|\.netrc|id_rsa[\w.-]*|id_ed25519[\w.-]*|[\w./-]*\.(pem|key|p12))(?=\s|"|'|$)/i;
  const deniedDirs = /(^|[\s"'=:/])(\.git|node_modules|\.design-mcp)(\/|\s|$)/i;
  const secret = command.match(secrets);
  if (secret) return `refused — "${secret[0].trim()}" is a secret file or a name that matches one; commands do not read credentials here`;
  const dir = command.match(deniedDirs);
  if (dir) return `refused — ${dir[2]}/ is not readable by a command either (the same list the file tools use)`;
  return null;
}

export function dangerousReason(command: string): string | null {
  for (const d of DANGEROUS) if (d.re.test(command)) return d.why;
  return null;
}

export function judge(command: string, policy: BashPolicy): Verdict {
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "an empty command runs nothing" };
  if (policy.mode === "off") return { ok: false, reason: "commands are disabled for this server (agent.bash.mode is off)" };

  const pathRefusal = secretMention(cmd);
  if (pathRefusal) return { ok: false, reason: pathRefusal };

  if (policy.mode === "allowlist") {
    if (META.test(cmd)) {
      return {
        ok: false,
        reason: `refused — ${cmd.slice(0, 60)} contains a shell metacharacter; in allowlist mode a command is one argv, not a pipeline`,
      };
    }
    const argv = cmd.split(/\s+/);
    const head = argv[0];
    const matched = policy.allow
      .map((entry) => entry.trim().split(/\s+/).filter(Boolean))
      .filter((entry) => entry.length > 0)
      .find((entry) => entry.every((tok, i) => argv[i] === tok));
    if (!matched) {
      return {
        ok: false,
        reason: `refused — "${head}" is not in agent.bash.allow. Allowed prefixes: ${policy.allow.join(" | ")}. Ask the owner to add it, or use the file tools.`,
      };
    }
    return { ok: true, argv, shell: false };
  }

  const danger = dangerousReason(cmd);
  if (danger) return { ok: false, reason: `refused — ${danger} (${cmd.slice(0, 60)})` };
  return { ok: true, argv: ["-c", cmd], shell: true };
}

/** `shell` mode is armed only when the config says so AND the process was started with the second switch. */
export function shellArmed(policy: BashPolicy, env: NodeJS.ProcessEnv = process.env): boolean {
  return policy.mode === "shell" && env.DESIGN_MCP_AGENT_SHELL === "1";
}
