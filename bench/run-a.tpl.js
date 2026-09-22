// A 栈（移植后 ego-jev）单任务运行器；计时口径与 run-b.py 对齐。
// 模板：__TASK__ 与 __REPO__ 由 vs-bstack.sh 用 sed 替换。输出一行 JSON。
const { readFile } = await import("node:fs/promises");
// 仓库根：本文件是模板，由 vs-bstack.sh 注入 __REPO__；若直接跑则回退到已安装技能。
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { runJevAutonomousLoop } = await import(JE);

const TASKS = {
  "hn-nav": {
    url: "https://news.ycombinator.com",
    goal: "先打开 new 页面，再打开 comments 页面",
    test: (u) => u.includes("/newcomments"),
    maxSteps: 6,
  },
  "wiki-search": {
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "在顶部搜索框输入 Jev 并提交搜索",
    test: (u) => /\/(wiki\/(JEV|Japanese_encephalitis)|w\/index\.php\?search=|wiki\/Special:Search)/i.test(u),
    // 说明：在搜索框按回车与点 Search 按钮会落到两个不同的合法终态
    // （前者到重定向目标 /wiki/Japanese_encephalitis，后者到 /wiki/JEV），两者都算搜索已提交。
    maxSteps: 6,
  },
  "httpbin-form": {
    url: "https://httpbin.org/forms/post",
    goal: "把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单",
    test: (u) => /\/post(\?|#|$)/.test(u) && !u.includes("/forms/"),
    maxSteps: 8,
  },
};

const taskId = "__TASK__";
const task = TASKS[taskId];
const KEY = await loadBenchApiKey();
const textModel = await loadBenchTextModel();

const space = await taskSpace(`ego-vs-${taskId}-${Date.now()}`);
const page = space.page("p1");
let out = { stack: "A", task: taskId, url: task.url };
try {
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(800);
  const metrics = {};
  const t0 = Date.now();
  const r = await runJevAutonomousLoop(page, task.goal, {
    apiKey: KEY, textModel, maxSteps: task.maxSteps, metrics,
    check: async (p) => task.test(await p.url()),
  });
  const finalUrl = await page.url();
  out = {
    ...out,
    elapsedMs: Date.now() - t0,
    steps: r.steps,
    success: r.success && task.test(finalUrl),
    reason: r.reason,
    finalUrl,
    jevCalls: metrics["jev.request"] || 0,
    textCalls: r.history.filter((h) => h.text && h.textError === null && h.action?.startsWith("type_text")).length,
    protocolCalls: Object.values(metrics).reduce((a, b) => a + b, 0),
    metrics,
    perStepMs: r.history.map((h) => h.stepDurationMs),
    actionLabels: r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}${h.option ? "=" + h.option : ""}`),
    observeModes: r.history.map((h) => h.observeMode),
    invalidResponses: r.history.filter((h) => h.invalidResponse).length,
    guardRejected: r.history.filter((h) => h.guardRejected).length,
  };
} catch (e) {
  out = { ...out, elapsedMs: null, steps: null, success: false, reason: "error", error: String(e).slice(0, 200) };
}
try { await space.finish({ keep: [] }); } catch { /* 空间已关闭 */ }
console.log(JSON.stringify(out));
