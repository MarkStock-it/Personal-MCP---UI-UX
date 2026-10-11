import type { Page } from "playwright";
import type { TestConfig } from "../config.js";

export type Group = "mobile" | "a11y" | "perf" | "runtime";
export interface GateResult { id: string; group: Group; title: string; pass: boolean; details: string[] }

const gate = (id: string, group: Group, title: string, problems: string[], info: string[] = []): GateResult => ({
  id, group, title, pass: problems.length === 0, details: [...problems, ...info],
});

/** Runs before any page script on every navigation: selector helper, style signature, perf observers. */
export const INIT = () => {
  const w = window as any;
  w.__sel = (el: Element) => {
    let s = el.tagName.toLowerCase();
    const h = el as HTMLElement;
    if (h.id) s += "#" + h.id;
    else if (typeof h.className === "string" && h.className.trim()) s += "." + h.className.trim().split(/\s+/).slice(0, 2).join(".");
    return s;
  };
  w.__sig = (el: Element) => {
    const c = getComputedStyle(el);
    return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.borderTopWidth, c.backgroundColor, c.color, c.textDecorationLine, c.opacity, c.transform].join("|");
  };
  w.__perf = { lcp: 0, cls: 0, tbt: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch { /* unsupported */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) w.__perf.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch { /* unsupported */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.tbt += Math.max(0, e.duration - 50); }).observe({ type: "longtask", buffered: true }); } catch { /* unsupported */ }
};

/** Wheel the page top to bottom so scroll-triggered animations fire and settle, then return to top. */
export async function scrollThrough(page: Page, viewportH: number): Promise<void> {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const steps = Math.min(60, Math.ceil(h / (viewportH * 0.8)));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, viewportH * 0.8);
    await page.waitForTimeout(260);
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);
}

// ---------- mobile ----------

export async function overflowGate(page: Page, width: number): Promise<GateResult> {
  const r = await page.evaluate(() => {
    const y = window.scrollY;
    window.scrollTo(10000, y);
    const can = window.scrollX > 0;
    window.scrollTo(0, y);
    const w = document.documentElement.clientWidth;
    const offenders: string[] = [];
    if (can) {
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.right > w + 1) {
          offenders.push(`${(window as any).__sel(el)} (right edge at ${Math.round(b.right)}px)`);
          if (offenders.length >= 6) break;
        }
      }
    }
    return { can, w, sw: document.documentElement.scrollWidth, offenders };
  });
  return gate(`overflow-${width}`, "mobile", `No sideways scrolling at ${width}px`,
    r.can ? [`The page scrolls sideways: content is ${r.sw}px wide in a ${r.w}px viewport.`, ...r.offenders.map((o) => `  overflowing element: ${o}`)] : []);
}

export async function tapTargetGate(page: Page): Promise<GateResult> {
  const r = await page.evaluate(() => {
    const out: string[] = [];
    let count = 0;
    const els = document.querySelectorAll("a[href], button, [role=button], input:not([type=hidden]), select, textarea, summary");
    for (const el of Array.from(els)) {
      const cs = getComputedStyle(el);
      // Inline text links are exempt; so are clipped skip links (1px by design,
      // grown on focus) — flagging them only teaches people to delete skip links.
      if (cs.display === "none" || cs.visibility === "hidden" || cs.display === "inline") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 2 && rect.height <= 2 && el.classList.contains("sr-only")) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.width < 24 || b.height < 24) {
        count++;
        if (out.length < 8) out.push(`${(window as any).__sel(el)} is ${Math.round(b.width)}x${Math.round(b.height)}px`);
      }
    }
    return { count, out };
  });
  return gate("tap-targets", "mobile", "Tap targets are at least 24x24px",
    r.count ? [`${r.count} interactive element(s) are too small to tap reliably:`, ...r.out.map((o) => `  ${o}`)] : []);
}

export async function tinyTextGate(page: Page): Promise<GateResult> {
  const r = await page.evaluate(() => {
    const out: string[] = [];
    let count = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) || el.closest("[aria-hidden='true']")) continue;
      let own = "";
      el.childNodes.forEach((n) => { if (n.nodeType === 3) own += n.textContent ?? ""; });
      if (!own.trim()) continue;
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      if (b.width <= 1 || b.height <= 1 || cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) continue;
      if (parseFloat(cs.fontSize) < 11) {
        count++;
        if (out.length < 6) out.push(`${(window as any).__sel(el)} ${cs.fontSize}: "${own.trim().slice(0, 30)}"`);
      }
    }
    return { count, out };
  });
  return gate("tiny-text", "mobile", "No text smaller than 11px",
    r.count ? [`${r.count} text element(s) are below 11px:`, ...r.out.map((o) => `  ${o}`)] : []);
}

// ---------- accessibility ----------

export async function axeGate(page: Page, label: string): Promise<GateResult> {
  let source: string;
  try {
    const mod: any = await import("axe-core");
    source = (mod.default ?? mod).source;
  } catch {
    return gate(`axe-${label}`, "a11y", `Automated accessibility audit (${label})`, ["axe-core is not installed. Run npm install in the design-mcp folder."]);
  }
  await page.addScriptTag({ content: source });
  const v: { id: string; impact: string; help: string; nodes: string[] }[] = await page.evaluate(async () => {
    const res = await (window as any).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
      resultTypes: ["violations"],
    });
    return res.violations.map((x: any) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.slice(0, 3).map((n: any) => n.target.join(" ")) }));
  });
  const hard = v.filter((x) => x.impact === "serious" || x.impact === "critical");
  const soft = v.filter((x) => !(x.impact === "serious" || x.impact === "critical"));
  return gate(`axe-${label}`, "a11y", `Automated accessibility audit (${label})`,
    hard.map((x) => `${x.impact} ${x.id}: ${x.help}. e.g. ${x.nodes[0] ?? "?"}`),
    soft.map((x) => `(minor, not blocking) ${x.id}: ${x.help}. e.g. ${x.nodes[0] ?? "?"}`));
}

export async function focusGate(page: Page): Promise<GateResult> {
  const before: Record<string, string> = await page.evaluate(() => {
    const w = window as any;
    const vis = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none";
    };
    const els = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])")).filter(vis);
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
    const map: Record<string, string> = {};
    els.forEach((el, i) => { el.setAttribute("data-dm-i", String(i)); map[i] = w.__sig(el); });
    return map;
  });
  const total = Object.keys(before).length;
  if (!total) return gate("focus-visible", "a11y", "Keyboard focus is visible", ["No focusable elements found. A page with no links or buttons has no way to act."]);

  const bad: string[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < Math.min(total, 30); t++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const i = el?.getAttribute("data-dm-i");
      if (!el || i == null) return null;
      return { i, sel: (window as any).__sel(el), now: (window as any).__sig(el) };
    });
    if (!r) continue;
    if (seen.has(r.i)) break; // wrapped around
    seen.add(r.i);
    if (r.now === before[r.i]) bad.push(r.sel);
  }
  return gate("focus-visible", "a11y", "Keyboard focus is visible",
    bad.length ? [`${bad.length} of ${seen.size} tabbed element(s) show no visible change when focused:`, ...bad.slice(0, 8).map((b) => `  ${b}`)] : [],
    [`Tabbed through ${seen.size} element(s).`]);
}

export async function contentVisibleGate(page: Page, label: string): Promise<GateResult> {
  const bad: string[] = await page.evaluate(() => {
    const out: string[] = [];
    const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "HEAD", "META", "LINK"]);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (skip.has(el.tagName) || el.closest("[aria-hidden='true']")) continue;
      let own = "";
      el.childNodes.forEach((n) => { if (n.nodeType === 3) own += n.textContent ?? ""; });
      if (!own.trim()) continue;
      const b = el.getBoundingClientRect();
      if (b.width <= 1 || b.height <= 1) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      let op = 1;
      let n: HTMLElement | null = el;
      while (n && n !== document.body) { op *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; }
      if (cs.visibility === "hidden" || op < 0.1) {
        out.push(`${(window as any).__sel(el)}: "${own.trim().slice(0, 40)}"`);
        if (out.length >= 8) break;
      }
    }
    return out;
  });
  return gate(`content-visible-${label}`, "a11y", `Text stays visible after scrolling (${label})`,
    bad.length ? ["Text is invisible after the page was scrolled through (a reveal animation never completed?):", ...bad.map((b) => `  ${b}`)] : []);
}

export async function reducedMotionGate(page: Page): Promise<GateResult> {
  const r = await page.evaluate(() => ({
    lenis: document.documentElement.classList.contains("lenis"),
    inf: document.getAnimations().filter((a) => {
      const t = a.effect?.getComputedTiming();
      return a.playState === "running" && !!t && t.iterations === Infinity;
    }).map((a) => (a as any).animationName ?? "animation"),
  }));
  const problems: string[] = [];
  if (r.lenis) problems.push("Smooth scrolling is still active when the user asks for reduced motion.");
  if (r.inf.length) problems.push(`${r.inf.length} infinite CSS animation(s) keep running with reduced motion: ${[...new Set(r.inf)].join(", ")}`);
  return gate("reduced-motion", "a11y", "Respects prefers-reduced-motion", problems);
}

export async function basicsGate(page: Page): Promise<GateResult> {
  const r = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title.trim(), h1: document.querySelectorAll("h1").length }));
  const problems: string[] = [];
  if (!r.lang) problems.push("The <html> element has no lang attribute.");
  if (!r.title) problems.push("The page has no <title>.");
  if (r.h1 !== 1) problems.push(`Expected exactly one <h1>, found ${r.h1}.`);
  return gate("basics", "a11y", "Page basics (lang, title, one h1)", problems);
}

// ---------- performance (warn-only by default) ----------

export async function loadMetricsGate(page: Page, b: TestConfig["budgets"]): Promise<GateResult> {
  const m: { lcp: number; cls: number; tbt: number } = await page.evaluate(() => (window as any).__perf);
  const problems: string[] = [];
  if (m.lcp > b.lcpMs) problems.push(`Largest paint at ${Math.round(m.lcp)} ms (budget ${b.lcpMs} ms).`);
  if (m.cls > b.cls) problems.push(`Layout shift ${m.cls.toFixed(3)} (budget ${b.cls}).`);
  if (m.tbt > 600) problems.push(`Main thread blocked ${Math.round(m.tbt)} ms during load (budget 600 ms).`);
  return gate("load-metrics", "perf", "Load metrics within budget", problems,
    [`LCP ${Math.round(m.lcp)} ms, CLS ${m.cls.toFixed(3)}, blocking time ${Math.round(m.tbt)} ms. (Headless and local, treat as relative.)`]);
}

/** Records frame times while wheel-scrolling the whole page. */
export async function smoothnessGate(page: Page, viewportH: number, b: TestConfig["budgets"]): Promise<GateResult> {
  await page.evaluate(() => {
    const w = window as any;
    w.__frames = [] as number[];
    let last = performance.now();
    const loop = (t: number) => { w.__frames.push(t - last); last = t; w.__raf = requestAnimationFrame(loop); };
    w.__raf = requestAnimationFrame(loop);
  });
  await scrollThrough(page, viewportH);
  const frames: number[] = (await page.evaluate(() => { cancelAnimationFrame((window as any).__raf); return (window as any).__frames; })).slice(1);
  if (frames.length < 20) return gate("scroll-smoothness", "perf", "Scrolling stays smooth", [], ["Too few frames recorded to judge."]);
  const sorted = [...frames].sort((a, c) => a - c);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const long = frames.filter((f) => f > 100).length;
  const problems: string[] = [];
  if (p95 > b.p95FrameMs) problems.push(`95th percentile frame time is ${p95.toFixed(1)} ms (budget ${b.p95FrameMs} ms).`);
  if (long > 3) problems.push(`${long} frames took longer than 100 ms.`);
  return gate("scroll-smoothness", "perf", "Scrolling stays smooth", problems,
    [`${frames.length} frames, p95 ${p95.toFixed(1)} ms, ${long} long frames. (Headless software rendering is slower than a real GPU.)`]);
}

export const runtimeGate = (errors: string[]): GateResult =>
  gate("runtime", "runtime", "No script errors or broken local files", errors.slice(0, 8));
