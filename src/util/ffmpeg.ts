import path from "node:path";
import { run } from "./exec.js";

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
}

export interface FfmpegStatus {
  ok: boolean;
  version?: string;
  error?: string;
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";

/** Is this tool usable at all? Called before promising anything, so failures read as setup, not as bugs. */
export async function ffmpegStatus(ffmpegBin: string, ffprobeBin: string, cwd: string): Promise<FfmpegStatus> {
  const ffmpeg = await run(ffmpegBin, ["-version"], cwd, 15_000);
  if (ffmpeg.code !== 0) return { ok: false, error: `Could not run "${ffmpegBin}": ${firstLine(ffmpeg.out) || "command not found"}` };
  const probe = await run(ffprobeBin, ["-version"], cwd, 15_000);
  if (probe.code !== 0) return { ok: false, error: `Could not run "${ffprobeBin}": ${firstLine(probe.out) || "command not found"}` };
  return { ok: true, version: firstLine(ffmpeg.out).replace(/^ffmpeg version\s*/i, "").split(" ")[0] };
}

/** Duration and pixel size of the first video stream. */
export async function probeVideo(ffprobeBin: string, file: string, cwd: string): Promise<ProbeResult | null> {
  const r = await run(ffprobeBin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], cwd, 60_000);
  if (r.code !== 0) return null;
  try {
    const json = JSON.parse(r.out);
    const stream = (json.streams ?? []).find((s: any) => s.codec_type === "video" && s.width);
    const durationSec = Number(json.format?.duration ?? stream?.duration ?? 0);
    if (!stream || !(durationSec > 0)) return null;
    return { durationSec, width: Number(stream.width), height: Number(stream.height) };
  } catch {
    return null;
  }
}

/** Every encoder this ffmpeg actually has. Builds vary enormously, so never assume a codec. */
export async function imageEncoders(ffmpegBin: string, cwd: string): Promise<Set<string>> {
  const r = await run(ffmpegBin, ["-hide_banner", "-encoders"], cwd, 30_000);
  const names = new Set<string>();
  for (const line of r.out.split("\n")) {
    const m = line.match(/^ [A-Z.]{6} (\S+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

export interface FrameFormat {
  encoder: string;
  ext: string;
  pattern: string;
  /** Encoder args, with Q standing for the quality number and QV for its JPEG-scale equivalent. */
  qualityArgs: string[];
  /** Bytes per frame relative to WebP, very roughly — used to warn before a build fails the budget. */
  weight: number;
}

const FORMATS: FrameFormat[] = [
  { encoder: "libwebp", ext: "webp", pattern: "frame-%03d.webp", qualityArgs: ["-quality", "Q", "-compression_level", "5"], weight: 1 },
  { encoder: "mjpeg", ext: "jpg", pattern: "frame-%03d.jpg", qualityArgs: ["-q:v", "QV", "-pix_fmt", "yuvj420p"], weight: 3.5 },
  { encoder: "png", ext: "png", pattern: "frame-%03d.png", qualityArgs: ["-compression_level", "6"], weight: 9 },
];

/** WebP if this build has it (smallest frames), then JPEG, then PNG. Null when it has none of them. */
export function pickFrameFormat(encoders: Set<string>): FrameFormat | null {
  return FORMATS.find((f) => encoders.has(f.encoder)) ?? null;
}

export const qualityArgsFor = (f: FrameFormat, quality: number) =>
  f.qualityArgs.map((arg) => {
    if (arg === "Q") return String(quality);
    // mjpeg takes -q:v 2 (best) to 31 (worst), which is not the same scale as WebP quality.
    if (arg === "QV") return String(Math.max(2, Math.min(20, Math.round(2 + (100 - quality) * 0.25))));
    return arg;
  });

export interface ExtractPlan {
  ffmpegBin: string;
  file: string;
  outDir: string;
  frames: number;
  longEdge: number;
  quality: number;
  durationSec: number;
  pattern: string;
  cwd: string;
  format?: FrameFormat;
}

const sh = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Even sampling across the whole clip, scaled to the long edge, WebP-encoded. One frame per step. */
export function extractArgs(o: ExtractPlan): string[] {
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
export function printableCommand(o: ExtractPlan): string {
  return [o.ffmpegBin, ...extractArgs(o)].map(sh).join(" ");
}

export async function extractFrames(o: Omit<ExtractPlan, "pattern"> & { pattern?: string; timeoutMs?: number }): Promise<{ ok: boolean; out: string }> {
  const plan: ExtractPlan = { ...o, pattern: o.pattern ?? (o.format ?? FORMATS[0]).pattern };
  const r = await run(o.ffmpegBin, extractArgs(plan), o.cwd, o.timeoutMs ?? 180_000);
  return { ok: r.code === 0, out: r.timedOut ? "ffmpeg timed out" : r.out.slice(-2000) };
}

/** Intrinsic size of a single encoded frame (used to record the manifest honestly, after scaling). */
export async function probeImage(ffprobeBin: string, file: string, cwd: string): Promise<{ width: number; height: number } | null> {
  const r = await run(ffprobeBin, ["-v", "error", "-select_streams", "v:0", "-print_format", "json", "-show_streams", file], cwd, 30_000);
  if (r.code !== 0) return null;
  try {
    const stream = (JSON.parse(r.out).streams ?? [])[0];
    if (!stream?.width) return null;
    return { width: Number(stream.width), height: Number(stream.height) };
  } catch {
    return null;
  }
}
