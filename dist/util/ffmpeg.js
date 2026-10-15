import path from "node:path";
import { run } from "./exec.js";
const firstLine = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
/** Is this tool usable at all? Called before promising anything, so failures read as setup, not as bugs. */
export async function ffmpegStatus(ffmpegBin, ffprobeBin, cwd) {
    const ffmpeg = await run(ffmpegBin, ["-version"], cwd, 15_000);
    if (ffmpeg.code !== 0)
        return { ok: false, error: `Could not run "${ffmpegBin}": ${firstLine(ffmpeg.out) || "command not found"}` };
    const probe = await run(ffprobeBin, ["-version"], cwd, 15_000);
    if (probe.code !== 0)
        return { ok: false, error: `Could not run "${ffprobeBin}": ${firstLine(probe.out) || "command not found"}` };
    return { ok: true, version: firstLine(ffmpeg.out).replace(/^ffmpeg version\s*/i, "").split(" ")[0] };
}
/** Duration and pixel size of the first video stream. */
export async function probeVideo(ffprobeBin, file, cwd) {
    const r = await run(ffprobeBin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], cwd, 60_000);
    if (r.code !== 0)
        return null;
    try {
        const json = JSON.parse(r.out);
        const stream = (json.streams ?? []).find((s) => s.codec_type === "video" && s.width);
        const durationSec = Number(json.format?.duration ?? stream?.duration ?? 0);
        if (!stream || !(durationSec > 0))
            return null;
        return { durationSec, width: Number(stream.width), height: Number(stream.height) };
    }
    catch {
        return null;
    }
}
/** Every encoder this ffmpeg actually has. Builds vary enormously, so never assume a codec. */
export async function imageEncoders(ffmpegBin, cwd) {
    const r = await run(ffmpegBin, ["-hide_banner", "-encoders"], cwd, 30_000);
    const names = new Set();
    for (const line of r.out.split("\n")) {
        const m = line.match(/^ [A-Z.]{6} (\S+)/);
        if (m)
            names.add(m[1]);
    }
    return names;
}
const FORMATS = [
    { encoder: "libwebp", ext: "webp", pattern: "frame-%03d.webp", qualityArgs: ["-quality", "Q", "-compression_level", "5"], weight: 1 },
    { encoder: "mjpeg", ext: "jpg", pattern: "frame-%03d.jpg", qualityArgs: ["-q:v", "QV", "-pix_fmt", "yuvj420p"], weight: 3.5 },
    { encoder: "png", ext: "png", pattern: "frame-%03d.png", qualityArgs: ["-compression_level", "6"], weight: 9 },
];
/** WebP if this build has it (smallest frames), then JPEG, then PNG. Null when it has none of them. */
export function pickFrameFormat(encoders) {
    return FORMATS.find((f) => encoders.has(f.encoder)) ?? null;
}
export const qualityArgsFor = (f, quality) => f.qualityArgs.map((arg) => {
    if (arg === "Q")
        return String(quality);
    // mjpeg takes -q:v 2 (best) to 31 (worst), which is not the same scale as WebP quality.
    if (arg === "QV")
        return String(Math.max(2, Math.min(20, Math.round(2 + (100 - quality) * 0.25))));
    return arg;
});
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** Even sampling across the whole clip, scaled to the long edge, WebP-encoded. One frame per step. */
export function extractArgs(o) {
    const fps = Math.max(0.05, Math.min(60, o.frames / Math.max(0.2, o.durationSec)));
    const resolution = o.longEdge === 0 ? "scale=iw:-2" : `scale='min(${o.longEdge},iw)':-2:flags=lanczos`;
    const format = o.format ?? FORMATS[0];
    return [
        "-y", "-v", "error", "-nostdin",
        "-i", o.file,
        "-an",
        "-vf", `fps=${fps.toFixed(6)},${resolution}`,
        "-frames:v", String(o.frames),
        "-c:v", format.encoder,
        ...qualityArgsFor(format, o.quality),
        path.join(o.outDir, o.pattern),
    ];
}
/** The same command, quoted so a person can paste it into a terminal if ffmpeg is not installed here. */
export function printableCommand(o) {
    return [o.ffmpegBin, ...extractArgs(o)].map(sh).join(" ");
}
export async function extractFrames(o) {
    const plan = { ...o, pattern: o.pattern ?? (o.format ?? FORMATS[0]).pattern };
    const r = await run(o.ffmpegBin, extractArgs(plan), o.cwd, o.timeoutMs ?? 180_000);
    return { ok: r.code === 0, out: r.timedOut ? "ffmpeg timed out" : r.out.slice(-2000) };
}
/** Intrinsic size of a single encoded frame (used to record the manifest honestly, after scaling). */
export async function probeImage(ffprobeBin, file, cwd) {
    const r = await run(ffprobeBin, ["-v", "error", "-select_streams", "v:0", "-print_format", "json", "-show_streams", file], cwd, 30_000);
    if (r.code !== 0)
        return null;
    try {
        const stream = (JSON.parse(r.out).streams ?? [])[0];
        if (!stream?.width)
            return null;
        return { width: Number(stream.width), height: Number(stream.height) };
    }
    catch {
        return null;
    }
}
