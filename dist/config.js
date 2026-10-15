import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
const textRole = z.object({
    // "session" = your AI host answers via MCP sampling (no key). "manual" = prompts are parked as files for you to answer (no key, any host).
    provider: z.enum(["anthropic", "openai", "google", "session", "manual"]),
    model: z.string().min(1),
});
const imageRole = z.object({
    provider: z.enum(["openai", "google"]),
    model: z.string().min(1),
});
const DEFAULT_ALLOWLIST = [
    "three", "@types/three", "@react-three/fiber", "@react-three/drei", "ogl", "motion",
    "split-type", "matter-js", "@types/matter-js", "@use-gesture/react", "simplex-noise",
];
const DEFAULT_TEXT = { provider: "anthropic", model: "claude-sonnet-5-5" };
// The collective runs on the assistant you are already talking to (MCP sampling), so its workers
// really are other instances of that same model and no API key is involved. Point these roles at
// anthropic/openai/google instead to run the collective on a separate model.
const HOST_TEXT = { provider: "session", model: "host-default" };
const TestGroup = z.enum(["mobile", "a11y", "perf"]);
/** Where installed skills live. `~` is the home dir; the rest resolve inside the project. */
const DEFAULT_SKILL_ROOTS = [
    "~/.config/freebuff-desktop/account-skills",
    "~/.claude/skills",
    "~/.codex/skills",
    ".claude/skills",
    ".cursor/skills",
    "skills",
];
const DEFAULT_IGNORE = [
    "node_modules", ".git", ".cache", "dist", "build", "out", "coverage", "vendor", "target",
    ".next", ".nuxt", ".svelte-kit", ".vercel", ".turbo", ".venv", "venv", "__pycache__",
    ".design-mcp", "variations", "tmp", ".work",
];
export const ConfigSchema = z.object({
    roles: z
        .object({
        concept: textRole.default(DEFAULT_TEXT),
        builder: textRole.default(DEFAULT_TEXT),
        critic: textRole.default(DEFAULT_TEXT),
        leader: textRole.default(HOST_TEXT),
        worker: textRole.default(HOST_TEXT),
        image: imageRole.default({ provider: "openai", model: "gpt-image-1" }),
    })
        .default({}),
    limits: z
        .object({
        variations: z.number().int().min(1).max(5).default(3),
        maxFixRounds: z.number().int().min(0).max(3).default(3),
    })
        .default({}),
    build: z
        .object({
        maxImages: z.number().int().min(0).max(12).default(6),
        repairRounds: z.number().int().min(0).max(4).default(2),
        installTimeoutSec: z.number().int().min(30).default(300),
        buildTimeoutSec: z.number().int().min(30).default(240),
        firstPort: z.number().int().min(1024).max(65000).default(5201),
        concurrency: z.number().int().min(1).max(6).default(3),
        // Defaults for sequence_extract (scroll-scrubbed frame sequences). Frames are the expensive asset: ~20 KB each.
        sequence: z
            .object({
            frames: z.number().int().min(24).max(240).default(90),
            longEdge: z.number().int().min(320).max(2400).default(1280),
            quality: z.number().int().min(40).max(100).default(80),
        })
            .default({}),
        // Where ffmpeg/ffprobe live, if they are not on PATH.
        ffmpegPath: z.string().default("ffmpeg"),
        ffprobePath: z.string().default("ffprobe"),
        // Only these extra npm packages may be added to a variation (supply-chain safety). Edit to allow more.
        extraDependencyAllowlist: z.array(z.string()).default(DEFAULT_ALLOWLIST),
    })
        .default({}),
    // The codebase layer: what the collective is allowed to read, and how much of it fits in one context.
    codebase: z
        .object({
        // Roots are relative to the project dir. Nothing outside them is ever read or cited.
        roots: z.array(z.string()).default(["."]),
        maxFiles: z.number().int().min(1).max(20000).default(4000),
        maxFileKB: z.number().int().min(1).max(2048).default(512),
        // Directories never walked, on top of .gitignore (git ls-files already honours that).
        ignore: z.array(z.string()).default(DEFAULT_IGNORE),
        // The compact map of the repo that the leader and the host read instead of the files.
        digestTokens: z.number().int().min(400).max(20000).default(2500),
        // How much source one packed context answer (one worker, one question) may contain.
        contextTokens: z.number().int().min(500).max(60000).default(6000),
    })
        .default({}),
    // Skills you installed (SKILL.md collections). Discovered and read here; never executed by this server.
    skills: z
        .object({
        enabled: z.boolean().default(true),
        roots: z.array(z.string()).default(DEFAULT_SKILL_ROOTS),
        maxSkillKB: z.number().int().min(4).max(2048).default(256),
        maxInPromptKB: z.number().int().min(2).max(64).default(16),
    })
        .default({}),
    collective: z
        .object({
        // Hard cap on workstreams the leader may split a mission into.
        maxUnits: z.number().int().min(1).max(12).default(6),
        // How many workers may be in flight at once. Each worker is one model call.
        maxWorkers: z.number().int().min(1).max(6).default(3),
        contextTokensPerWorker: z.number().int().min(500).max(60000).default(4500),
        // One final leader pass that merges only what survived verification.
        synthesize: z.boolean().default(true),
        // Round two: the workers read each other's VERIFIED findings and must answer with evidence.
        // Costs one extra model call per unit. Multi-agent debate measurably helps on some tasks and not
        // others (and agreement between copies of one model is not independent evidence), so this is a
        // switch rather than a law: turn it off to halve the calls.
        peerRound: z.boolean().default(true),
        // The repair pass: a finding the citation gate rejected goes back to its unit ONCE, with the
        // server's own reason and the line the quote really lives at, and the answer is re-gated like
        // anything else. One pass, never a loop: a single targeted repair after a deterministic rejection
        // measurably beats resampling, repeated repairs do not, and debugging effectiveness decays fast.
        repairRound: z.boolean().default(true),
        // What the collective remembers between missions. Only quote-verified claims and rejections get in.
        memory: z.boolean().default(true),
        memoryItems: z.number().int().min(10).max(400).default(60),
        memoryTokensInPrompt: z.number().int().min(0).max(2000).default(400),
        // Keep every mission dossier under .design-mcp/collective/.
        keepDossiers: z.number().int().min(1).max(200).default(20),
    })
        .default({}),
    test: z
        .object({
        // "chromium" = Playwright's bundled browser. "chrome"/"msedge" = the one already installed on your machine.
        channel: z.enum(["chromium", "chrome", "msedge"]).default("chromium"),
        // Groups where a failed check blocks the variation. Anything else only warns. Runtime errors always block.
        strictGroups: z.array(TestGroup).default(["mobile", "a11y"]),
        budgets: z
            .object({
            jsGzKB: z.number().default(250),
            cssGzKB: z.number().default(60),
            imagesKB: z.number().default(2500),
            totalKB: z.number().default(4000),
            p95FrameMs: z.number().default(34),
            lcpMs: z.number().default(2500),
            cls: z.number().default(0.1),
            // A scroll scene is one asset group and one decoded working set. Both are capped here.
            sequenceKB: z.number().default(3000),
            sequenceFrames: z.number().default(180),
            sequenceDecodeWindowMB: z.number().default(256),
        })
            .default({}),
    })
        .default({}),
});
export function projectDir() {
    return path.resolve(process.env.DESIGN_MCP_PROJECT_DIR ?? process.cwd());
}
/** Where this tool keeps its own files inside your project. */
export function stateDir() {
    return path.join(projectDir(), ".design-mcp");
}
export function loadConfig() {
    const candidates = [
        process.env.DESIGN_MCP_CONFIG,
        path.join(projectDir(), "design-mcp.config.json"),
    ].filter(Boolean);
    for (const file of candidates) {
        if (fs.existsSync(file)) {
            let raw;
            try {
                raw = JSON.parse(fs.readFileSync(file, "utf8"));
            }
            catch (e) {
                throw new Error(`Config file ${file} is not valid JSON: ${e.message}`);
            }
            const parsed = ConfigSchema.safeParse(raw);
            if (!parsed.success) {
                throw new Error(`Config file ${file} is invalid:\n${parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`);
            }
            return { config: parsed.data, source: file };
        }
    }
    return { config: ConfigSchema.parse({}), source: "built-in defaults (no config file found)" };
}
const KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY" };
export function keyEnvName(provider) {
    return KEY_ENV[provider];
}
/** session/manual use your own assistant, not an API key. */
export function providerNeedsKey(provider) {
    return provider !== "session" && provider !== "manual";
}
export function apiKeyFor(provider) {
    const name = KEY_ENV[provider];
    if (!name)
        throw new Error(`The "${provider}" provider uses your own assistant, not an API key.`);
    const key = process.env[name];
    if (!key) {
        throw new Error(`Missing ${name}. Add it to the "env" block of this server in Cursor's mcp.json.`);
    }
    return key;
}
