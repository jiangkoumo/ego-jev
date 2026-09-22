// 只读：X 时间线上引擎实际看到的元素表（决定任务设计是否可行）
// 用法: ego-browser nodejs < bench/reveal-probe-x-table.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const JE = "/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs";
const src = await readFile(JE, "utf8");
const observeDom = new Function("return " + src.slice(src.indexOf("function observeDom(payload)"), src.indexOf("/**\n * 页面内：执行前的最后一刻检查")).trim().replace(/;\s*$/, ""))();
const { buildActionMenu } = await import(JE);

const space = await taskSpace("reveal-probe-xtable-" + Date.now());
const page = space.page("p1");
await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);

const out = { probedAt: new Date().toISOString() };
const dump = async (label) => {
  const obs = await page.evaluate(observeDom, { limit: 60, maxText: 2500 });
  const menu = buildActionMenu(obs.targets);
  const info = {
    label, scrollY: obs.scroll.y, docH: obs.scroll.height, viewportH: obs.scroll.viewportH,
    canScrollDown: obs.scroll.canScrollDown, targets: obs.targets.length, newCount: obs.newCount,
    textChars: obs.text.length,
    names: obs.targets.map((t) => `${t.role}|${t.name.slice(0, 34)}|${(t.url || "").slice(-24)}`),
    textSample: obs.text.replace(/\s+/g, " ").slice(0, 300),
  };
  console.log(`\n=== ${label} ===  元素 ${info.targets} 项, 可见文本 ${info.textChars} 字符, scrollY=${info.scrollY}/${info.docH - info.viewportH}, 新元素 ${info.newCount}`);
  console.log("  元素表前 18 项:");
  for (const n of info.names.slice(0, 18)) console.log("    " + n);
  const statusLinks = obs.targets.filter((t) => /\/status\/\d+$/.test(t.url || ""));
  console.log(`  指向具体帖子(/status/id)的链接: ${statusLinks.length} 项 → ${statusLinks.map((t) => `"${t.name.slice(0, 12)}"`).join(", ").slice(0, 160)}`);
  console.log(`  可见文本样本: ${info.textSample.slice(0, 160)}`);
  return info;
};

out.top = await dump("顶部（首屏）");
await page.evaluate(() => window.scrollBy({ top: Math.round(innerHeight * 0.9), behavior: "instant" }));
await page.waitForTimeout(1200);
out.mid1 = await dump("下滚 1 屏");
await page.evaluate(() => window.scrollBy({ top: Math.round(innerHeight * 0.9), behavior: "instant" }));
await page.waitForTimeout(1200);
out.mid2 = await dump("下滚 2 屏");

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/reveal-probe-xtable-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("\nRAW: " + `${BENCH}/raw/reveal-probe-xtable-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
