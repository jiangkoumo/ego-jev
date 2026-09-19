// 延迟导航回归测试：短等待方案必须保留对「延迟导航」的兜底
// 页面 /tmp/ego-jev-nav/a.html：改选下拉框 → 250ms 后才出现确认按钮 → 点它 350ms 后才真正跳转
// 用法: ego-browser nodejs < bench/delayed-nav.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const ENGINE = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/scripts/ego-jev.mjs";
const ORIG = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench/baseline-engine.mjs";
const BENCH = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench";
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();
const GOAL = "把语言下拉框改选为 Dansk，然后点击确认按钮完成跳转";
const START = "http://127.0.0.1:8099/a.html";
const UNTIL = "8099/b.html";
const RUNS = 3;

const ARMS = [
  { name: "orig-legacy", file: ORIG, opts: {} },                                                    // 旧引擎（300/1200）
  { name: "new-legacy", file: ENGINE, opts: { settleMode: "legacy" } },                              // 新引擎但旧等待
  { name: "new-observable", file: ENGINE, opts: {} },                                                // 新引擎 + 可观察等待
];

const out = { goal: GOAL, start: START, arms: {} };
for (const arm of ARMS) {
  const { runJevAutonomousLoop } = await import(arm.file);
  const records = [];
  for (let i = 0; i < RUNS; i++) {
    const task = await taskSpace(`ego-dnav-${arm.name}-${i}-${Date.now()}`);
    const page = task.page("p1");
    await page.goto(START, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(400);
    const metrics = {};
    const t0 = Date.now();
    const r = await runJevAutonomousLoop(page, GOAL, {
      apiKey: KEY, maxSteps: 8, metrics,
      check: async (p) => (await p.url()).includes(UNTIL),
      ...arm.opts,
    });
    const rec = {
      run: i + 1, elapsedMs: Date.now() - t0, success: r.success, reason: r.reason, steps: r.steps,
      url: await page.url(), metrics,
      perStep: r.history.map((h) => ({ action: h.action, target: h.target, ms: h.stepDurationMs, changed: h.changed, urlAfter: h.urlAfter })),
    };
    records.push(rec);
    console.log(`  ${arm.name} #${i + 1}: ${rec.elapsedMs}ms | ${rec.steps}步 | ${rec.success ? "OK" : "FAIL:" + rec.reason} | ${rec.url.split("/").pop()}`);
    await task.finish({ keep: [] });
  }
  out.arms[arm.name] = { opts: arm.opts, records, successRate: `${records.filter((r) => r.success).length}/${RUNS}` };
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/delayed-nav-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/delayed-nav-${stamp}.json`);
