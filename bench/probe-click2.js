// 裁决对比 2：ref 点击 / mouse.click / 裸 CDP 派发；并区分「点击开销」与「导航等待」
// 用法: ego-browser nodejs < bench/probe-click2.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const JE = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/scripts/ego-jev.mjs";
const { parseActionTargets } = await import(JE);
const BENCH = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench";

const FIND = () => {
  const link = [...document.querySelectorAll("a")].find((a) => (a.textContent || "").trim() === "new");
  const r = link.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: link.href };
};

const fire = async (mode, page, pt, ref) => {
  const t0 = Date.now();
  if (mode === "ref") await page.click(ref, { label: "probe" });
  else if (mode === "mouse") await page.mouse.click(pt.x, pt.y, { label: "probe" });
  else {
    const p = { x: Math.round(pt.x), y: Math.round(pt.y), button: "left", clickCount: 1 };
    await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p });
  }
  return Date.now() - t0;
};

const out = { nav: [], nonav: [] };
// A. 会导航的点击
for (const mode of ["ref", "mouse", "cdp"]) {
  for (let i = 0; i < 3; i++) {
    const task = await taskSpace(`ego-pc2-${mode}-${i}-${Date.now()}`);
    const page = task.page("p1");
    await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(900);
    const snap = await page.snapshot();
    const ref = parseActionTargets(snap, { limit: 40 }).find((t) => /new/.test(t.name) && /newest/.test(t.url))?.ref;
    const pt = await page.evaluate(FIND);
    let ms = null, err = null;
    try { ms = await fire(mode, page, pt, ref); } catch (e) { err = String(e).slice(0, 100); }
    const t1 = Date.now();
    let loadMs = null;
    try { await page.waitForLoadState("load", { timeout: 3000 }); loadMs = Date.now() - t1; } catch { loadMs = -1; }
    const url = await page.url();
    out.nav.push({ mode, run: i + 1, clickMs: ms, loadMs, totalMs: (ms || 0) + (loadMs || 0), url, err });
    console.log(`  [导航] ${mode} #${i + 1}: click ${ms}ms + load ${loadMs}ms = ${(ms || 0) + (loadMs || 0)}ms → ${url.replace("https://news.ycombinator.com", "")} ${err || ""}`);
    await task.finish({ keep: [] });
  }
}
// B. 不导航的点击（点空白处）——分离「指针动作本身」的开销
for (const mode of ["mouse", "cdp"]) {
  for (let i = 0; i < 3; i++) {
    const task = await taskSpace(`ego-pc2n-${mode}-${i}-${Date.now()}`);
    const page = task.page("p1");
    await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(900);
    const pt = { x: 700, y: 600 };
    let ms = null, err = null;
    try { ms = await fire(mode, page, pt, null); } catch (e) { err = String(e).slice(0, 100); }
    out.nonav.push({ mode, run: i + 1, clickMs: ms, err });
    console.log(`  [不导航] ${mode} #${i + 1}: ${ms}ms ${err || ""}`);
    await task.finish({ keep: [] });
  }
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/probe-click2-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/probe-click2-${stamp}.json`);
