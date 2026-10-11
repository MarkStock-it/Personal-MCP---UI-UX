import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
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
/** Page weight from the built dist folder (deterministic, no network needed). */
export async function weightGate(distDir, b) {
    let jsGz = 0, cssGz = 0, images = 0, total = 0;
    for (const f of await walk(distDir)) {
        const buf = await fs.readFile(f);
        const ext = path.extname(f).toLowerCase();
        total += buf.length;
        if (ext === ".js" || ext === ".mjs")
            jsGz += zlib.gzipSync(buf).length;
        else if (ext === ".css")
            cssGz += zlib.gzipSync(buf).length;
        else if ([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg"].includes(ext))
            images += buf.length;
    }
    const kb = (n) => Math.round(n / 1024);
    const problems = [];
    if (kb(jsGz) > b.jsGzKB)
        problems.push(`JavaScript is ${kb(jsGz)} KB gzipped (budget ${b.jsGzKB} KB).`);
    if (kb(cssGz) > b.cssGzKB)
        problems.push(`CSS is ${kb(cssGz)} KB gzipped (budget ${b.cssGzKB} KB).`);
    if (kb(images) > b.imagesKB)
        problems.push(`Images total ${kb(images)} KB (budget ${b.imagesKB} KB).`);
    if (kb(total) > b.totalKB)
        problems.push(`Everything totals ${kb(total)} KB (budget ${b.totalKB} KB).`);
    return {
        id: "page-weight", group: "perf", title: "Page weight within budget", pass: problems.length === 0,
        details: [...problems, `JS ${kb(jsGz)} KB gz, CSS ${kb(cssGz)} KB gz, images ${kb(images)} KB, total ${kb(total)} KB.`],
    };
}
