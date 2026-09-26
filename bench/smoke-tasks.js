// 快速冒烟：确认 wiki 搜索 / httpbin 表单 两个任务在新引擎下能跑通
// 用法: ego-browser nodejs < bench/smoke-tasks.js
const { readFile } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/smoke-tasks.js | ego-browser nodejs
// ② 直接 `< bench/smoke-tasks.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { runJevAutonomousLoop } = await import(JE);
const KEY = await loadBenchApiKey();
const textModel = await loadBenchTextModel();
const TASKS = [
  { id: "wiki-search", url: "https://en.wikipedia.org/wiki/Main_Page", goal: "在顶部搜索框输入 Jev 并提交搜索", urlTest: (u) => /\/wiki\/JEV|\/w\/index\.php\?search=|Special:Search/i.test(u), maxSteps: 6 },
  { id: "httpbin-form", url: "https://httpbin.org/forms/post", goal: "把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单", urlTest: (u) => u.includes("/post"), maxSteps: 8 },
];
for (const task of TASKS) {
  const space = await taskSpace(`ego-smoke-${task.id}-${Date.now()}`);
  const page = space.page("p1");
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(800);
  const metrics = {};
  const t0 = Date.now();
  const r = await runJevAutonomousLoop(page, task.goal, {
    apiKey: KEY, textModel, maxSteps: task.maxSteps, metrics,
    check: async (p) => task.urlTest(await p.url()),
  });
  console.log(`\n### ${task.id}: ${Date.now() - t0}ms | ${r.steps}步 | ${r.success ? "OK" : "FAIL:" + r.reason} | ${await page.url()}`);
  for (const h of r.history) console.log(`    ${h.stepDurationMs}ms ${h.action} ${h.target || ""} ${h.option || ""} ${h.text || ""} ${h.guardRejected ? "GUARD:" + h.guardRejected : ""} ${h.invalidResponse ? "INVALID:" + h.invalidResponse : ""} changed=${h.changed}`);
  console.log("    metrics:", JSON.stringify(metrics));
  await space.finish({ keep: [] });
}
