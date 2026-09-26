// 裁决性对比：同一元素，page.click(ref) vs page.mouse.click(x,y)
// 用法: ego-browser nodejs < bench/probe-click.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/probe-click.js | ego-browser nodejs
// ② 直接 `< bench/probe-click.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const KEY = await loadBenchApiKey();

const FIND = () => {
  const link = [...document.querySelectorAll("a")].find((a) => (a.textContent || "").trim() === "new" && a.href.includes("newest"));
  if (!link) return null;
  const r = link.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: link.href };
};

const out = { rows: [] };
for (const mode of ["ref", "mouse"]) {
  for (let i = 0; i < 3; i++) {
    const task = await taskSpace(`ego-probe-click-${mode}-${i}-${Date.now()}`);
    const page = task.page("p1");
    await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(900);
    // 用 ego 自己的快照拿到 ref（与引擎同路径）
    const snap = await page.snapshot();
    const ref = (snap.split("\n").find((l) => /"new"/.test(l) && /url=.*newest/.test(l))?.match(/ref=(\d+)/) || [])[0];
    const pt = await page.evaluate(FIND);
    const t0 = Date.now();
    let err = null;
    try {
      if (mode === "ref") await page.click(ref, { label: "probe" });
      else await page.mouse.click(pt.x, pt.y, { label: "probe" });
    } catch (e) { err = String(e).slice(0, 120); }
    const ms = Date.now() - t0;
    const url = await page.url();
    out.rows.push({ mode, run: i + 1, ms, ref, point: pt && { x: Math.round(pt.x), y: Math.round(pt.y) }, url, err, ok: url.includes("newest") });
    console.log(`  ${mode} #${i + 1}: ${ms}ms | ${ref} @(${pt && Math.round(pt.x)},${pt && Math.round(pt.y)}) → ${url.replace("https://news.ycombinator.com", "")} ${err ? "ERR:" + err : ""}`);
    await task.finish({ keep: [] });
  }
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/probe-click-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/probe-click-${stamp}.json`);
