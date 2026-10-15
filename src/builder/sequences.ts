import fs from "node:fs/promises";
import path from "node:path";
import type { BuildConfig, TestConfig } from "../config.js";
import { stateDir } from "../config.js";
import { extractFrames, ffmpegStatus, imageEncoders, pickFrameFormat, probeImage, probeVideo, printableCommand, type FrameFormat } from "../util/ffmpeg.js";

/** The manifest every sequence folder carries; src/motion/sequence.tsx reads exactly this. */
export interface SequenceManifest {
  frames: number;
  pattern: string;
  width: number;
  height: number;
  poster?: string;
  /** Container of the frames, as the encoder that produced them was able to write. */
  format?: string;
  source?: string;
  createdAt?: string;
}

export interface SequenceInfo extends SequenceManifest {
  name: string;
  dir: string;
  bytes: number;
}

const NAME_RE = /^[a-z0-9-]{2,32}$/;

/** Where sequences live in the project, independent of any single variation. */
export const sequencesDir = () => path.join(stateDir(), "sequences");

/** Frames the renderer holds at once: the drawn one, six ahead, three behind. Keep in sync with sequence.tsx. */
export const DECODE_WINDOW = 10;

/** Decoded working set of one scene, in MiB: width x height x 4 bytes x window. */
export const decodeWindowMiB = (m: { width: number; height: number }, window = DECODE_WINDOW) =>
  (m.width * m.height * 4 * window) / (1024 * 1024);

const bytesIn = async (dir: string): Promise<number> => {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isFile()) total += (await fs.stat(path.join(dir, e.name))).size;
    else if (e.isDirectory()) total += await bytesIn(path.join(dir, e.name));
  }
  return total;
};

async function readManifest(dir: string): Promise<SequenceManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
    if (typeof m?.frames === "number" && m.frames > 1 && typeof m.pattern === "string") return m as SequenceManifest;
  } catch {
    /* not a sequence folder */
  }
  return null;
}

/** Every sequence this project has prepared, ready coupleable to a variation. */
export async function listSequences(): Promise<SequenceInfo[]> {
  const root = sequencesDir();
  let names: string[] = [];
  try {
    names = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out: SequenceInfo[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const manifest = await readManifest(dir);
    if (manifest) out.push({ ...manifest, name, dir, bytes: await bytesIn(dir) });
  }
  return out;
}

/** Copy every prepared sequence into a variation's public folder, so /sequences/<name>/... resolves in dev and in the build. */
export async function installSequences(variationRoot: string): Promise<SequenceInfo[]> {
  const all = await listSequences();
  for (const s of all) {
    const dest = path.join(variationRoot, "public", "sequences", s.name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(s.dir, dest, { recursive: true });
  }
  return all;
}

/** One line per sequence, for the builder's context. */
export function renderSequenceList(all: SequenceInfo[]): string {
  return [
    "AVAILABLE SCROLL SEQUENCES (scroll-driven image sequences already installed at /sequences/<name>/; use at most one, and only via the ScrollSequence component)",
    ...all.map((s) => `- ${s.name}: ${s.frames} frames, ${s.width}x${s.height}, ${Math.round(s.bytes / 1024)} KB total, poster at /sequences/${s.name}/${s.poster ?? "poster.webp"}`),
  ].join("\n");
}

export interface PreparedSequence {
  name: string;
  frames: number;
  width: number;
  height: number;
  bytes: number;
  bytesPerFrame: number;
  poster: string;
  decodeMiB: number;
  format: string;
  encoder: string;
  command: string;
  notes: string[];
}

/**
 * Turn a video into a frame sequence: even sampling, one WebP per step, a poster still, and a
 * manifest. Everything the scroll-scrubbing component needs, with the numbers reported rather
 * than assumed.
 */
export async function prepareSequence(o: {
  video: string;
  name: string;
  cfg: BuildConfig;
  budgets: TestConfig["budgets"];
  cwd: string;
  frames?: number;
  longEdge?: number;
  quality?: number;
  overwrite?: boolean;
}): Promise<PreparedSequence> {
  const notes: string[] = [];
  if (!NAME_RE.test(o.name)) throw new Error(`"${o.name}" is not a valid sequence name. Use lowercase letters, digits and hyphens (2-32 characters), e.g. "hero-flight".`);

  const status = await ffmpegStatus(o.cfg.ffmpegPath, o.cfg.ffprobePath, o.cwd);
  const dest = path.join(sequencesDir(), o.name);

  const requested = Math.min(o.frames ?? o.cfg.sequence.frames, o.budgets.sequenceFrames);
  if (o.frames && o.frames > o.budgets.sequenceFrames) {
    notes.push(`${o.frames} frames were requested; capped at the sequence budget of ${o.budgets.sequenceFrames}.`);
  }
  let longEdge = o.longEdge ?? o.cfg.sequence.longEdge;
  const quality = o.quality ?? o.cfg.sequence.quality;
  const video = path.resolve(o.cwd, o.video);

  if (!status.ok) {
    const fallback: FrameFormat = { encoder: "libwebp", ext: "webp", pattern: "frame-%03d.webp", qualityArgs: ["-quality", "Q", "-compression_level", "5"], weight: 1 };
    const plan = { ffmpegBin: o.cfg.ffmpegPath, file: video, outDir: dest, frames: requested, longEdge, quality, durationSec: 0, pattern: fallback.pattern, cwd: o.cwd, format: fallback };
    throw new Error(
      `${status.error}\n\nTwo options:\n` +
        `1. Install ffmpeg (macOS: brew install ffmpeg; Windows: winget install Gyan.FFmpeg) and run this tool again.\n` +
        `2. Run the extraction yourself, then put the frames in ${path.relative(o.cwd, dest)} and re-run this tool to register them:\n   ${printableCommand(plan)}\n` +
        `Frames must be named ${fallback.pattern} starting at 1.`
    );
  }

  if (!(await fs.stat(video).then((s) => s.isFile(), () => false))) {
    throw new Error(`No video file at ${video}. sequence_extract reads a local file; generate the clip first (any tool or model), then pass its path.`);
  }
  if (!/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(video)) {
    throw new Error(`"${path.basename(video)}" does not look like a video file. Supported: mp4, mov, m4v, webm, mkv, avi.`);
  }

  const exists = await fs.stat(dest).then(() => true, () => false);
  if (exists) {
    if (!o.overwrite) throw new Error(`A sequence called "${o.name}" already exists (${path.relative(o.cwd, dest)}). Pass overwrite=true to replace it, or choose another name.`);
    await fs.rm(dest, { recursive: true, force: true });
  }

  const info = await probeVideo(o.cfg.ffprobePath, video, o.cwd);
  if (!info) throw new Error(`Could not read a video stream from ${video}. Is the file complete?`);

  // Never assume a codec: this ffmpeg may have been built without WebP entirely.
  const format = pickFrameFormat(await imageEncoders(o.cfg.ffmpegPath, o.cwd));
  if (!format) throw new Error(`This ffmpeg (${o.cfg.ffmpegPath}) has no image encoder this tool can use (looked for libwebp, mjpeg, png). Install a fuller build, or extract frames yourself.`);
  if (format.ext !== "webp") {
    notes.push(`This ffmpeg has no WebP encoder, so frames are ${format.ext.toUpperCase()} (about ${format.weight}x the bytes). Consider a smaller longEdge.`);
  }

  const extractAt = async (edge: number) => {
    await fs.mkdir(dest, { recursive: true });
    return extractFrames({ ffmpegBin: o.cfg.ffmpegPath, file: video, outDir: dest, frames: requested, longEdge: edge, quality, durationSec: info.durationSec, pattern: format.pattern, cwd: o.cwd, format });
  };

  let extraction = await extractAt(longEdge);
  if (!extraction.ok) {
    await fs.rm(dest, { recursive: true, force: true });
    throw new Error(`ffmpeg failed:\n${extraction.out}`);
  }

  const frameFiles = async () => (await fs.readdir(dest)).filter((f) => /^frame-\d+\.[a-z]+$/.test(f)).sort();

  // Frames that miss the scene budget are worse than useless: they fail the build. Trim the resolution once, and say so.
  let measured = await bytesIn(dest);
  if (measured / 1024 > o.budgets.sequenceKB && longEdge > 480) {
    const target = Math.max(480, Math.floor(longEdge * Math.sqrt((o.budgets.sequenceKB * 1024) / Math.max(1, measured))));
    if (target < longEdge) {
      await fs.rm(dest, { recursive: true, force: true });
      extraction = await extractAt(target);
      if (!extraction.ok) throw new Error(`ffmpeg failed while fitting the scene to its budget:\n${extraction.out}`);
      measured = await bytesIn(dest);
      notes.push(`Frames at ${longEdge}px were ${Math.round(measured / 1024)} KB, over the ${o.budgets.sequenceKB} KB scene budget, so the long edge was reduced to ${target}px.`);
      longEdge = target;
    }
  }

  const files = await frameFiles();
  if (!files.length) throw new Error("ffmpeg reported success but produced no frames. Does the clip actually contain video?");
  if (files.length < requested) notes.push(`The clip is short for ${requested} frames: ${files.length} were extracted. Lower the frame count or use a longer clip for a smoother scrub.`);

  const posterIndex = Math.min(files.length - 1, Math.max(0, Math.round((files.length - 1) * 0.4)));
  const poster = `poster.${format.ext}`;
  await fs.copyFile(path.join(dest, files[posterIndex]), path.join(dest, poster));

  const size = (await probeImage(o.cfg.ffprobePath, path.join(dest, files[0]), o.cwd)) ?? { width: info.width, height: info.height };
  const manifest: SequenceManifest = {
    frames: files.length,
    pattern: format.pattern,
    width: size.width,
    height: size.height,
    poster,
    format: format.ext,
    source: path.basename(video),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(dest, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const bytes = await bytesIn(dest);
  const bytesPerFrame = Math.round(bytes / files.length);
  const decodeMiB = decodeWindowMiB(size);
  const kb = Math.round(bytes / 1024);
  if (kb > o.budgets.sequenceKB) {
    notes.push(`The sequence is ${kb} KB, over the ${o.budgets.sequenceKB} KB scene budget. Lower frames, quality or longEdge — the page-weight gate will fail otherwise.`);
  }
  if (decodeMiB > o.budgets.sequenceDecodeWindowMB) {
    notes.push(`Decoded, this scene holds about ${Math.round(decodeMiB)} MB at once (${size.width}x${size.height} x ${DECODE_WINDOW} frames), over the ${o.budgets.sequenceDecodeWindowMB} MB budget. Lower longEdge.`);
  }
  if (info.durationSec < 2) notes.push(`Source clip is only ${info.durationSec.toFixed(1)}s long; a very short clip at ${files.length} steps scrubs at low effective quality.`);

  return {
    name: o.name, frames: files.length, width: size.width, height: size.height,
    bytes, bytesPerFrame, poster: `/sequences/${o.name}/${poster}`, decodeMiB,
    format: format.ext, encoder: format.encoder,
    command: printableCommand({ ffmpegBin: o.cfg.ffmpegPath, file: video, outDir: dest, frames: requested, longEdge, quality, durationSec: info.durationSec, pattern: format.pattern, cwd: o.cwd, format }),
    notes,
  };
}
