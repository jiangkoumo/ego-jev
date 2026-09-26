// 只读诊断：X 时间线上「Jev 为什么一直滚动而不点目标」。
// 逐字复用 bench/x-scroll-tasks.js 的锚点测量与 goal 构造，但只跑 1 步，并打印：
//   ① 交给 Jev 的元素表里到底有没有目标的 /status/<id> 链接（在第几项）
//   ② Jev 实际选了哪个 operation、置信度、概率分布
//   ③ 若选 click，选中的是哪个元素
// 不点击、不输入（本脚本只调用 runJevStep，且不提供任何文本来源）。
// 用法: ego-browser nodejs < bench/x-diagnose.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/x-diagnose.js | ego-browser nodejs
// ② 直接 `< bench/x-diagnose.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { runJevStep, buildActionMenu } = await import(JE);
const src = await readFile(JE, "utf8");
const observeDom = new Function(
  "return " +
    src
      .slice(src.indexOf("function observeDom(payload)"), src.indexOf("/**\n * 页面内：执行前的最后一刻检查"))
      .trim()
      .replace(/;\s*$/, "")
)();
const KEY = await loadBenchApiKey();

const measureX = () => {
  const articles = [...document.querySelectorAll("article")];
  const rows = [];
  for (const [i, a] of articles.entries()) {
    const statusLink = [...a.querySelectorAll('a[href*="/status/"]')].find((x) => /\/status\/\d+$/.test(x.getAttribute("href") || ""));
    const id = statusLink ? (statusLink.getAttribute("href").match(/\/status\/(\d+)/) || [])[1] : null;
    if (!id) continue;
    const authorLink = [...a.querySelectorAll("a[href]")].find((x) => /^\/[A-Za-z0-9_]{1,15}$/.test(x.getAttribute("href") || ""));
    const handle = authorLink ? authorLink.getAttribute("href").slice(1) : null;
    const rect = a.getBoundingClientRect();
    const text = (a.innerText || "").replace(/\s+/g, " ").trim();
    rows.push({ i, id, handle, screen: Number(((rect.top + scrollY) / innerHeight).toFixed(2)), text: text.slice(0, 90) });
  }
  return { viewportH: innerHeight, docH: document.documentElement.scrollHeight, rows };
};
const safeText = (s) => String(s || "").replace(/[\uD800-\uDFFF]/g, "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
const snippetOf = (text, handle) => {
  const body = text.replace(new RegExp(`^.*?@${handle}\\s*`, "i"), "").replace(/^[·\s]+/, "").trim();
  const src2 = body.length >= 14 ? body : text;
  return safeText(src2.slice(0, 26)).replace(/[「」"']/g, "");
};

const space = await taskSpace(`ego-xdiag-${Date.now()}`);
const page = space.page("p1");
const out = { probedAt: new Date().toISOString(), iterations: [] };
const realFetch = globalThis.fetch;

try {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  const m = await page.evaluate(measureX);
  const first = [...m.rows].sort((a, b) => a.screen - b.screen).find((r) => r.screen <= 1) || null;
  console.log(`锚点: @${first?.handle} id=${first?.id} 屏${first?.screen} DOM内${m.rows.length}条 docH=${m.docH}`);

  const goals = {
    exact: `不要使用搜索框。打开 @${first.handle} 发的这条帖子的详情页（正文含「${snippetOf(first.text, first.handle)}」，点它的时间戳链接）`,
    nohint: `不要使用搜索框。打开 @${first.handle} 发的这条帖子的详情页（点它的时间戳链接）`,
    byurl: `打开 https://x.com/${first.handle}/status/${first.id} 这个帖子的详情页`,
  };

  // ① 元素表里有没有目标的 /status/<id>（不需要 Jev 调用）
  for (let i = 1; i <= 2; i++) {
    const obs = await page.evaluate(observeDom, { limit: 60, maxText: 2500 });
    const menu = buildActionMenu(obs.targets);
    const lines = menu.split("\n");
    const idx = lines.findIndex((l) => l.includes(`/status/${first.id}`));
    const statusLinks = obs.targets.filter((t) => /\/status\/\d+$/.test(t.url || ""));
    console.log(`\n[元素表 ${i}] ${obs.targets.length} 项, 新元素 ${obs.newCount}, 含目标链接=${idx >= 0 ? `是（第 ${idx + 1} 项）` : "否"}`);
    console.log(`  表内 /status/ 链接 ${statusLinks.length} 项: ${statusLinks.map((t) => `${t.name}|${(t.url || "").slice(-26)}`).join("  ")}`);
    if (idx >= 0) console.log(`  目标行: ${lines[idx]}`);
    out.iterations.push({ kind: "table", i, targets: obs.targets.length, newCount: obs.newCount, targetInTable: idx >= 0, targetIndex: idx, statusLinks: statusLinks.length });
    await page.evaluate(() => window.scrollBy({ top: Math.round(innerHeight * 0.9), behavior: "instant" }));
    await page.waitForTimeout(1000);
  }
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // ② 三种 goal 各问一次，记录 Jev 的答案
  for (const [name, goal] of Object.entries(goals)) {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return realFetch(url, init);
    };
    const r = await runJevStep(page, goal, { apiKey: KEY, metrics: {}, onStep: () => {} });
    globalThis.fetch = realFetch;
    const tableLines = String(captured?.state || "").split("\n");
    const idx = tableLines.findIndex((l) => l.includes(`/status/${first.id}`));
    console.log(
      `\n[${name}] operation=${r.action} conf=${r.operationConfidence} target=${r.target || "-"}` +
        ` | 表内目标链接=${idx >= 0 ? `第${idx}行` : "无"} | 表内 /status/ 行数=${tableLines.filter((l) => /\/status\/\d+/.test(l)).length}`
    );
    console.log(`  概率: ${JSON.stringify(r.operationProbabilities)}`);
    out.iterations.push({
      kind: "jev", goal: name, action: r.action, confidence: r.operationConfidence,
      probabilities: r.operationProbabilities, target: r.target, targetLabel: r.targetLabel,
      targetInState: idx >= 0, statusLinesInState: tableLines.filter((l) => /\/status\/\d+/.test(l)).length,
      invalidResponse: r.invalidResponse,
    });
    // 只读：本诊断不执行动作；把页面恢复回顶部再问下一个 goal
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
  }
} catch (e) {
  out.error = String(e).slice(0, 300);
  console.log("ERROR " + out.error);
} finally {
  globalThis.fetch = realFetch;
}

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/x-diagnose-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/x-diagnose-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
