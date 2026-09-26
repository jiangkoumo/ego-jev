// 诊断：在延迟导航测试页上，新旧观测层各自看到什么
// 用法: ego-browser nodejs < bench/debug-nav.js
// 前置：/tmp/ego-jev-nav/a.html 需已存在（静态页怎么起见 bench/delayed-nav.js 的注释）
const { readFile } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/debug-nav.js | ego-browser nodejs
// ② 直接 `< bench/debug-nav.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { parseActionTargets, enrichTargets, buildActionMenu } = await import(JE);

const task = await taskSpace("ego-dbg-" + Date.now());
const page = task.page("p1");
await page.goto("file:///tmp/ego-jev-nav/a.html", { waitUntil: "domcontentloaded", timeout: 15000 });
await page.waitForTimeout(400);

const snap = await page.snapshot();
console.log("=== 旧路径：a11y 快照 " + snap.length + " 字符");
const parsed = parseActionTargets(snap, { limit: 40 });
console.log("解析到 " + parsed.length + " 个元素:");
console.log(buildActionMenu(parsed) || "(空)");
const enriched = await enrichTargets(page, parsed, {});
console.log("--- enrich 后:");
console.log(buildActionMenu(enriched) || "(空)");

// 新观测层（直接跑引擎里那份函数）
const mod = await import(JE);
const src = (await readFile(JE, "utf8"));
const fnStart = src.indexOf("function observeDom(payload)");
const fnEnd = src.indexOf("/**\n * 页面内：执行前的最后一刻检查");
const observeSrc = src.slice(fnStart, fnEnd);
const observeDom = new Function("return " + observeSrc.trim().replace(/;\s*$/, ""))();
const observed = await page.evaluate(observeDom, { limit: 60, maxText: 500 });
console.log("\n=== 新路径：自建元素表 " + observed.targets.length + " 项");
console.log(JSON.stringify(observed.targets, null, 1).slice(0, 1500));
console.log("--- 菜单文本:");
console.log(buildActionMenu(observed.targets.map((t) => ({ ...t, kind: t.kind }))) || "(空)");

// 复现 page.evaluate 序列化错误
try {
  const r = await page.evaluate((p) => ({ ok: true, got: p }), { id: 1, value: observed.targets[0]?.optionValues?.[2] });
  console.log("\nevaluate({id,value}) 成功:", JSON.stringify(r));
} catch (e) {
  console.log("\nevaluate({id,value}) 失败:", String(e).slice(0, 160));
}
try {
  const r = await page.evaluate((p) => ({ ok: true, got: p }), { id: 1, value: undefined });
  console.log("evaluate({id,value:undefined}) 成功:", JSON.stringify(r));
} catch (e) {
  console.log("evaluate({id,value:undefined}) 失败:", String(e).slice(0, 160));
}
try {
  const r = await page.evaluate((p) => ({ ok: true, got: p }), { id: NaN, value: "x" });
  console.log("evaluate({id:NaN}) 成功:", JSON.stringify(r));
} catch (e) {
  console.log("evaluate({id:NaN}) 失败:", String(e).slice(0, 160));
}
await task.finish({ keep: [] });
