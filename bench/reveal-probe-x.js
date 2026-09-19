// X 时间线结构只读探测：帖子如何分布在各屏、能否按内容定位到「首屏之外」的目标
// 严格只读：goto + 读取 + 滚动；不点击、不输入、不发布。
// 用法: ego-browser nodejs < bench/reveal-probe-x.js
const { writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench";

const space = await taskSpace("reveal-probe-x-" + Date.now());
const page = space.page("p1");
const out = { probedAt: new Date().toISOString(), url: "https://x.com/home" };

await page.goto(out.url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);

// 读取时间线：每条帖子的 status id、文本头、在文档中的 y
const readTimeline = () => {
  const articles = [...document.querySelectorAll("article")];
  const rows = articles.map((a, i) => {
    const link = [...a.querySelectorAll('a[href*="/status/"]')].find((x) => /\/status\/\d+$/.test(x.getAttribute("href") || ""));
    const id = link ? (link.getAttribute("href").match(/\/status\/(\d+)/) || [])[1] : null;
    const rect = a.getBoundingClientRect();
    const text = (a.innerText || "").replace(/\s+/g, " ").trim();
    return { i, id, top: Math.round(rect.top + scrollY), h: Math.round(rect.height), textHead: text.slice(0, 70) };
  });
  return { scrollY: Math.round(scrollY), viewportH: innerHeight, docH: document.documentElement.scrollHeight, rows };
};

const first = await page.evaluate(readTimeline);
out.initial = { viewportH: first.viewportH, docH: first.docH, articles: first.rows.length, rows: first.rows.slice(0, 25) };
console.log(`初始: ${first.rows.length} 条帖子, docH=${first.docH}, viewportH=${first.viewportH} → 约 ${Math.round(first.docH / first.viewportH)} 屏`);
for (const r of first.rows.slice(0, 12)) console.log(`   #${r.i + 1} id=${r.id} y=${r.top} 屏${(r.top / first.viewportH).toFixed(1)} | ${r.textHead.slice(0, 40)}`);

// 往下滚 3 屏，看列表如何增长/虚拟化
for (const n of [1, 2, 3]) {
  await page.evaluate(() => window.scrollBy({ top: Math.round(innerHeight * 0.9), behavior: "instant" }));
  await page.waitForTimeout(1500);
}
const after = await page.evaluate(readTimeline);
out.afterScroll = { scrollY: after.scrollY, docH: after.docH, articles: after.rows.length };
console.log(`\n滚 3 屏后: scrollY=${after.scrollY}, docH=${after.docH} → 约 ${Math.round(after.docH / after.viewportH)} 屏, 当前 DOM 里 ${after.rows.length} 条`);
console.log("  可见帖子的 y 分布:", after.rows.filter((r) => r.top >= after.scrollY - 100 && r.top < after.scrollY + after.viewportH).map((r) => `#${r.i + 1}@屏${(r.top / after.viewportH).toFixed(1)}`).join(" "));

// 目标定位能力：能否在「首屏之外」找到一个稳定的内容锚点
out.anchorCandidates = after.rows
  .filter((r) => r.id && r.top > after.viewportH * 1.5 && r.textHead.length > 20)
  .slice(0, 6)
  .map((r) => ({ id: r.id, screen: Number((r.top / after.viewportH).toFixed(1)), textHead: r.textHead }));

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/reveal-probe-x-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("\n可作锚点的「首屏之外」帖子:");
for (const a of out.anchorCandidates) console.log(`   屏${a.screen} id=${a.id} | ${a.textHead.slice(0, 50)}`);
console.log("RAW: " + `${BENCH}/raw/reveal-probe-x-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
