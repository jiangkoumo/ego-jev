// 每项改动的单独收益：同一批任务、同一引擎族，逐项打开开关
//   A0-base   旧引擎（a11y 快照 + 300/1200 固定等待 + 无校验）
//   A1-legacy 新引擎但全部回退到旧行为（应 ≈ A0，用于确认对照有效）
//   A2-wait   A1 + 可观察等待                → Δ等待策略
//   A3-obs    A2 + 自建 DOM 元素表 + 裸 CDP 动作 → Δ观测层/动作路径
//   A4-full   A3 + 响应校验 + 提示词规则 + 执行前守卫 → Δ校验与提示词
// 用法: ego-browser nodejs < bench/isolation.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/isolation.js | ego-browser nodejs
// ② 直接 `< bench/isolation.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const NEW = JE;
const OLD = `${BENCH}/baseline-engine.mjs`;
const RUNS = 3;

const KEY = await loadBenchApiKey();
const textModel = await loadBenchTextModel();

const TASKS = [
  {
    id: "hn-nav",
    url: "https://news.ycombinator.com",
    goal: "先打开 new 页面，再打开 comments 页面",
    until: "/newcomments",
    maxSteps: 6,
  },
  {
    id: "wiki-search",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "在顶部搜索框输入 Jev 并提交搜索",
    until: null,
    urlTest: (u) => /\/wiki\/JEV|\/w\/index\.php\?search=|Special:Search/i.test(u),
    maxSteps: 6,
  },
  {
    id: "httpbin-form",
    url: "https://httpbin.org/forms/post",
    goal: "把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单",
    until: null,
    // 表单页本身是 /forms/post，提交后的结果是 /post —— 不能简单用 includes("/post")
    urlTest: (u) => /\/post(\?|#|$)/.test(u) && !u.includes("/forms/"),
    maxSteps: 8,
  },
];

const ARMS = [
  { id: "A0-base", file: OLD, opts: {} },
  { id: "A1-legacy", file: NEW, opts: { observe: "snapshot", settleMode: "legacy", validate: false, rules: false } },
  { id: "A2-wait", file: NEW, opts: { observe: "snapshot", validate: false, rules: false } },
  { id: "A3-obs", file: NEW, opts: { validate: false, rules: false } },
  { id: "A4-full", file: NEW, opts: {} },
];

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const out = { startedAt: new Date().toISOString(), runs: RUNS, tasks: TASKS.map((t) => t.id), arms: {} };

for (const arm of ARMS) {
  const { runJevAutonomousLoop } = await import(arm.file);
  const armOut = { opts: arm.opts, tasks: {} };
  for (const task of TASKS) {
    const records = [];
    for (let i = 0; i < RUNS; i++) {
      const space = await taskSpace(`ego-iso-${arm.id}-${task.id}-${i}-${Date.now()}`);
      const page = space.page("p1");
      try {
        await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(800);
        const metrics = {};
        const t0 = Date.now();
        const r = await runJevAutonomousLoop(page, task.goal, {
          apiKey: KEY,
          textModel,
          maxSteps: task.maxSteps,
          metrics,
          check: async (p) => {
            const u = await p.url();
            return task.urlTest ? task.urlTest(u) : u.includes(task.until);
          },
          ...arm.opts,
        });
        const url = await page.url();
        const rec = {
          run: i + 1, elapsedMs: Date.now() - t0, success: r.success, reason: r.reason, steps: r.steps, url,
          protocolCalls: Object.values(metrics).reduce((a, b) => a + b, 0), metrics,
          perStepMs: r.history.map((h) => h.stepDurationMs),
          stepActions: r.history.map((h) => `${h.action}${h.option ? ":" + h.option : ""}${h.text ? ":" + h.text : ""}`),
          observeModes: r.history.map((h) => h.observeMode),
          invalid: r.history.filter((h) => h.invalidResponse).length,
          guardRejected: r.history.filter((h) => h.guardRejected).length,
        };
        records.push(rec);
        console.log(`  ${arm.id} ${task.id} #${i + 1}: ${rec.elapsedMs}ms | ${rec.steps}步 | ${rec.success ? "OK" : "FAIL:" + rec.reason} | ${rec.protocolCalls} 次协议调用 | ${url.replace(/^https?:\/\/[^/]+/, "").slice(0, 30)}`);
      } catch (e) {
        records.push({ run: i + 1, error: String(e).slice(0, 160), success: false });
        console.log(`  ${arm.id} ${task.id} #${i + 1}: ERROR ${String(e).slice(0, 120)}`);
      }
      try { await space.finish({ keep: [] }); } catch { /* space 已关闭 */ }
    }
    const ok = records.filter((r) => r.success);
    armOut.tasks[task.id] = {
      records,
      successRate: `${ok.length}/${records.length}`,
      medianAllMs: median(records.map((r) => r.elapsedMs).filter(Boolean)),
      medianSuccessMs: median(ok.map((r) => r.elapsedMs)),
      minSuccessMs: ok.length ? Math.min(...ok.map((r) => r.elapsedMs)) : null,
      maxSuccessMs: ok.length ? Math.max(...ok.map((r) => r.elapsedMs)) : null,
      medianSteps: median(records.map((r) => r.steps).filter((n) => typeof n === "number")),
      medianProtocolCalls: median(records.map((r) => r.protocolCalls).filter((n) => typeof n === "number")),
      medianPerStepMs: median(records.flatMap((r) => r.perStepMs || [])),
    };
    console.log(`  → ${arm.id} ${task.id} 成功中位=${armOut.tasks[task.id].medianSuccessMs}ms 步中位=${armOut.tasks[task.id].medianPerStepMs}ms (${armOut.tasks[task.id].successRate})\n`);
  }
  out.arms[arm.id] = armOut;
}

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/isolation-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/isolation-${stamp}.json`);
