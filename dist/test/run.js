import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, projectDir, stateDir } from "../config.js";
import { serveDir } from "./server.js";
import { axeGate, basicsGate, contentVisibleGate, focusGate, INIT, loadMetricsGate, overflowGate, reducedMotionGate, runtimeGate, scrollSceneGate, scrollThrough, smoothnessGate, tapTargetGate, tinyTextGate, } from "./gates.js";
import { sequenceGate, weightGate } from "./weight.js";
const strict = (g, cfg) => g.group === "runtime" || cfg.strictGroups.includes(g.group);
async function launch(cfg) {
    let pw;
    try {
        pw = await import("playwright");
    }
    catch {
        throw new Error("Playwright is not installed. In the design-mcp folder run: npm install && npx playwright install chromium");
    }
    try {
        return await pw.chromium.launch({ headless: true, ...(cfg.channel !== "chromium" ? { channel: cfg.channel } : {}) });
    }
    catch (e) {
        throw new Error(`Could not start the browser (${cfg.channel}). ${cfg.channel === "chromium" ? "Run: npx playwright install chromium (in the design-mcp folder), or set test.channel to \"chrome\" to use your installed Chrome." : "Is that browser installed?"}\n${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
}
async function open(browser, url, opts, errors) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    await page.addInitScript(INIT);
    if (errors) {
        page.on("pageerror", (e) => errors.push(`Script error: ${e.message.split("\n")[0]}`));
        page.on("console", (m) => {
            const t = m.text();
            if (m.type() === "error" && !/Failed to load resource|net::ERR/i.test(t))
                errors.push(`Console error: ${t.slice(0, 160)}`);
        });
        page.on("response", (r) => {
            if (r.url().startsWith(url) && r.status() >= 400)
                errors.push(`Broken local file (${r.status()}): ${r.url().replace(url, "")}`);
        });
    }
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready).catch(() => { });
    await page.waitForTimeout(1200);
    return { ctx, page };
}
async function shoot(page, dir, prefix, viewportH, max) {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    const n = Math.min(max, Math.max(1, Math.ceil(h / viewportH)));
    const files = [];
    for (let i = 0; i < n; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), i * viewportH);
        await page.waitForTimeout(900);
        const file = path.join(dir, `${prefix}-${String(i + 1).padStart(2, "0")}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 78 });
        files.push(file);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    return files;
}
export async function testVariation(o) {
    const cfg = loadConfig().config.test;
    const { root, id, log } = o;
    const dist = path.join(root, "dist");
    if (!(await fs.access(path.join(dist, "index.html")).then(() => true, () => false))) {
        throw new Error(`No build found in ${path.relative(projectDir(), dist)}. Run design_build first.`);
    }
    const shotDir = path.join(stateDir(), "shots", id);
    await fs.rm(shotDir, { recursive: true, force: true });
    await fs.mkdir(shotDir, { recursive: true });
    const results = [await weightGate(dist, cfg.budgets), await sequenceGate(dist, cfg.budgets)];
    const shots = [];
    const errors = [];
    const server = await serveDir(dist);
    const browser = await launch(cfg);
    try {
        // Desktop
        log(`[${id}] desktop run`);
        const d = await open(browser, server.url, { viewport: { width: 1440, height: 900 } }, errors);
        results.push(await loadMetricsGate(d.page, cfg.budgets));
        results.push(await smoothnessGate(d.page, 900, cfg.budgets)); // also scrolls through, firing all animations
        results.push(await scrollSceneGate(d.page, 900)); // only meaningful when the page has a scroll sequence
        results.push(await contentVisibleGate(d.page, "desktop"));
        results.push(await basicsGate(d.page));
        results.push(await axeGate(d.page, "desktop"));
        results.push(await focusGate(d.page));
        shots.push(...(await shoot(d.page, shotDir, "desktop", 900, 8)));
        await d.ctx.close();
        // Mobile (390 and 360, desktop-style emulation so sideways overflow is measured honestly)
        for (const w of [390, 360]) {
            log(`[${id}] mobile ${w}px run`);
            const m = await open(browser, server.url, { viewport: { width: w, height: w === 390 ? 844 : 740 }, deviceScaleFactor: 2, hasTouch: true }, errors);
            await scrollThrough(m.page, w === 390 ? 844 : 740);
            results.push(await overflowGate(m.page, w));
            if (w === 390) {
                results.push(await tapTargetGate(m.page));
                results.push(await tinyTextGate(m.page));
                results.push(await axeGate(m.page, "mobile"));
                shots.push(...(await shoot(m.page, shotDir, "mobile", 844, 8)));
            }
            await m.ctx.close();
        }
        // Reduced motion
        log(`[${id}] reduced-motion run`);
        const r = await open(browser, server.url, { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }, errors);
        await scrollThrough(r.page, 900);
        results.push(await reducedMotionGate(r.page));
        results.push(await contentVisibleGate(r.page, "reduced-motion"));
        await r.ctx.close();
    }
    finally {
        await browser.close().catch(() => { });
        await server.close();
    }
    results.push(runtimeGate([...new Set(errors)]));
    const failing = results.filter((g) => !g.pass);
    const report = {
        id, name: o.name, at: new Date().toISOString(),
        hardFailures: failing.filter((g) => strict(g, cfg)),
        warnings: failing.filter((g) => !strict(g, cfg)),
        passed: results.filter((g) => g.pass),
        verdict: failing.some((g) => strict(g, cfg)) ? "fail" : "pass",
        shots,
    };
    await saveReport(report);
    log(`[${id}] ${report.verdict.toUpperCase()}: ${report.hardFailures.length} blocking, ${report.warnings.length} warning(s)`);
    return report;
}
export function renderReport(r) {
    const block = (g) => [`- [${g.group}] ${g.title}`, ...g.details.map((d) => `    ${d}`)].join("\n");
    return [
        `${r.id.toUpperCase()} "${r.name}": ${r.verdict.toUpperCase()}`,
        r.hardFailures.length ? `\nBLOCKING (${r.hardFailures.length}):\n${r.hardFailures.map(block).join("\n")}` : "",
        r.warnings.length ? `\nWARNINGS (${r.warnings.length}, not blocking):\n${r.warnings.map(block).join("\n")}` : "",
        `\nPASSED (${r.passed.length}): ${r.passed.map((g) => g.title).join("; ")}`,
        `\nScreenshots: ${r.shots.length ? path.dirname(r.shots[0]) : "none"}`,
    ].filter(Boolean).join("\n");
}
async function saveReport(r) {
    const dir = path.join(stateDir(), "reports");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${r.id}.json`), JSON.stringify(r, null, 2));
    await fs.writeFile(path.join(dir, `${r.id}.md`), renderReport(r));
}
export async function loadReport(id) {
    try {
        return await fs.readFile(path.join(stateDir(), "reports", `${id}.md`), "utf8");
    }
    catch {
        throw new Error(`No report for "${id}". Run design_test first.`);
    }
}
export async function findVariations() {
    const base = path.join(projectDir(), "variations");
    let dirs = [];
    try {
        dirs = await fs.readdir(base);
    }
    catch {
        return [];
    }
    const out = [];
    for (const d of dirs.sort()) {
        try {
            const m = JSON.parse(await fs.readFile(path.join(base, d, "design-mcp.json"), "utf8"));
            out.push({ id: m.conceptId, name: m.concept, root: path.join(base, d), port: m.port, status: m.status });
        }
        catch { /* not one of ours */ }
    }
    return out;
}
