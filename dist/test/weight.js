import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { decodeWindowMiB } from "../builder/sequences.js";
async function walk(dir) {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory())
            out.push(...(await walk(full)));
        else
            out.push(full);
    }
    return out;
}
const bytesIn = async (dir) => {
    let total = 0;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.isFile())
            total += (await fs.stat(path.join(dir, e.name))).size;
        else if (e.isDirectory())
            total += await bytesIn(path.join(dir, e.name));
    }
    return total;
};
const isSequenceAsset = (file) => file.split(path.sep).join("/").includes("/sequences/");
const exists = (p) => fs.access(p).then(() => true, () => false);
/** Page weight from the built dist folder (deterministic, no network needed). */
export async function weightGate(distDir, b) {
    let jsGz = 0, cssGz = 0, images = 0, sequences = 0, total = 0;
    for (const f of await walk(distDir)) {
        const buf = await fs.readFile(f);
        const ext = path.extname(f).toLowerCase();
        total += buf.length;
        if (ext === ".js" || ext === ".mjs")
            jsGz += zlib.gzipSync(buf).length;
        else if (ext === ".css")
            cssGz += zlib.gzipSync(buf).length;
        else if ([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg"].includes(ext)) {
            // A scroll sequence is one asset group with its own budget; it must not hide inside the image budget.
            if (isSequenceAsset(f))
                sequences += buf.length;
            else
                images += buf.length;
        }
    }
    const kb = (n) => Math.round(n / 1024);
    const problems = [];
    if (kb(jsGz) > b.jsGzKB)
        problems.push(`JavaScript is ${kb(jsGz)} KB gzipped (budget ${b.jsGzKB} KB).`);
    if (kb(cssGz) > b.cssGzKB)
        problems.push(`CSS is ${kb(cssGz)} KB gzipped (budget ${b.cssGzKB} KB).`);
    if (kb(images) > b.imagesKB)
        problems.push(`Images total ${kb(images)} KB (budget ${b.imagesKB} KB).`);
    if (kb(sequences) > b.sequenceKB)
        problems.push(`Scroll sequences total ${kb(sequences)} KB (budget ${b.sequenceKB} KB).`);
    if (kb(total) > b.totalKB)
        problems.push(`Everything totals ${kb(total)} KB (budget ${b.totalKB} KB).`);
    return {
        id: "page-weight", group: "perf", title: "Page weight within budget", pass: problems.length === 0,
        details: [
            ...problems,
            `JS ${kb(jsGz)} KB gz, CSS ${kb(cssGz)} KB gz, images ${kb(images)} KB${sequences ? `, scroll sequences ${kb(sequences)} KB` : ""}, total ${kb(total)} KB.`,
        ],
    };
}
/** Mirrors src/motion/sequence.tsx: printf-style pattern, frame indices start at 1. */
const frameName = (pattern, index) => pattern.replace(/%0?(\d*)d/, (_m, width) => String(index).padStart(Number(width) || 1, "0"));
/**
 * A scroll scene is the one asset group a screenshot cannot judge: if the frames are truncated,
 * unnamed or too heavy, it fails silently on a phone. This checks the built folder instead —
 * count, naming, poster, bytes and the decoded working set — and stays quiet when a page has
 * no scene at all.
 */
export async function sequenceGate(distDir, b) {
    const root = path.join(distDir, "sequences");
    const names = await fs
        .readdir(root, { withFileTypes: true })
        .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(), () => []);
    if (!names.length) {
        return { id: "scroll-sequence", group: "perf", title: "Scroll sequence assets are complete", pass: true, details: ["No scroll sequence in this build."] };
    }
    const problems = [];
    const info = [];
    for (const name of names) {
        const dir = path.join(root, name);
        let manifest;
        try {
            manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
        }
        catch {
            problems.push(`${name}: no readable manifest.json, so the scene cannot know its frame count or pattern.`);
            continue;
        }
        const frames = manifest.frames ?? 0;
        if (frames < 2) {
            problems.push(`${name}: the manifest has no usable frame count.`);
            continue;
        }
        if (frames > b.sequenceFrames)
            problems.push(`${name}: ${frames} frames (budget ${b.sequenceFrames}) — a longer sequence costs bytes and gives nothing back.`);
        if (!manifest.pattern || !/%0?\d*d/.test(manifest.pattern))
            problems.push(`${name}: the manifest pattern "${manifest.pattern ?? ""}" has no %d placeholder.`);
        if (!manifest.poster)
            problems.push(`${name}: no poster in the manifest, so there is nothing to show under reduced motion or while loading.`);
        else if (!(await exists(path.join(dir, manifest.poster))))
            problems.push(`${name}: the poster "${manifest.poster}" is missing from the build.`);
        if (!manifest.width || !manifest.height) {
            problems.push(`${name}: the manifest does not record the frame width and height.`);
        }
        else {
            const decoded = decodeWindowMiB({ width: manifest.width, height: manifest.height });
            if (decoded > b.sequenceDecodeWindowMB) {
                problems.push(`${name}: about ${Math.round(decoded)} MB of decoded frames held at once (budget ${b.sequenceDecodeWindowMB} MB) — lower the long edge.`);
            }
            info.push(`${name}: ${frames} frames at ${manifest.width}x${manifest.height}, decoded window about ${Math.round(decoded)} MB.`);
        }
        const onDisk = new Set(await fs.readdir(dir));
        const missing = [];
        if (manifest.pattern && /%0?\d*d/.test(manifest.pattern)) {
            for (let i = 1; i <= Math.min(frames, b.sequenceFrames); i++) {
                const file = frameName(manifest.pattern, i);
                if (!onDisk.has(file))
                    missing.push(file);
            }
        }
        if (missing.length)
            problems.push(`${name}: ${missing.length} frame(s) named by the pattern are missing (first: ${missing.slice(0, 3).join(", ")}). Re-run sequence_extract.`);
        const kb = Math.round((await bytesIn(dir)) / 1024);
        if (kb > b.sequenceKB)
            problems.push(`${name}: ${kb} KB of sequence assets (budget ${b.sequenceKB} KB) — lower frames, quality or long edge.`);
        info.push(`${name}: ${kb} KB on disk.`);
    }
    return { id: "scroll-sequence", group: "perf", title: "Scroll sequence assets are complete", pass: problems.length === 0, details: [...problems, ...info] };
}
