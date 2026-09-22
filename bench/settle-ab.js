// A/B: 等待策略单独收益（HN 两步导航，同一引擎、同一任务）
// 用法: ego-browser nodejs < bench/settle-ab.js
// 原始数据: bench/raw/settle-ab-<ts>.json
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const { runJevAutonomousLoop } = await import("/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs");

const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();
const GOAL = "先打开 new 页面，再打开 comments 页面";
const URL = "https://news.ycombinator.com";
const CONFIGS = [
  { name: "long", opts: {} },                                  // 默认: stepDelay 300 + navWait 1200
  { name: "short", opts: { stepDelay: 50, navWaitMs: 250 } },  // 短等待
];
const RUNS = Number(globalThis.__RUNS__ || 3);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const out = { goal: GOAL, url: URL, runs: RUNS, engine: "ego-jev baseline", arms: {} };

for (const cfg of CONFIGS) {
  const records = [];
  for (let i = 0; i < RUNS; i++) {
    // 唯一名字: taskSpace 按名字 resume，上一轮已 finish 的 space 里没有 p1
    const task = await taskSpace(`ego-settle-${cfg.name}-${i}-${Date.now()}`);
    const page = task.page("p1");
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(800);
    const metrics = {};
    const t0 = Date.now();
    const r = await runJevAutonomousLoop(page, GOAL, {
      apiKey: KEY, maxSteps: 5, metrics,
      check: async (p) => (await p.url()).includes("/newcomments"),
      ...cfg.opts,
    });
    const rec = {
      run: i + 1, elapsedMs: Date.now() - t0, success: r.success, reason: r.reason, steps: r.steps,
      url: await page.url(), metrics,
      perStep: r.history.map((h) => ({
        action: h.action, target: h.target, ms: h.stepDurationMs, changed: h.changed,
        urlAfter: h.urlAfter, stale: h.staleTarget || null, error: h.error || null,
      })),
    };
    records.push(rec);
    console.log(`  ${cfg.name} run${i + 1}: ${rec.elapsedMs}ms | ${rec.steps}步 | ${rec.success ? "OK" : "FAIL:" + rec.reason} | ${rec.url}`);
    await task.finish({ keep: [] });
  }
  const ok = records.filter((r) => r.success).map((r) => r.elapsedMs);
  out.arms[cfg.name] = {
    opts: cfg.opts, records,
    medianAllMs: median(records.map((r) => r.elapsedMs)),
    medianSuccessMs: ok.length ? median(ok) : null,
    perStepMedianMs: median(records.flatMap((r) => r.perStep.map((s) => s.ms))),
    successRate: `${ok.length}/${records.length}`,
    protocolCalls: records.map((r) => Object.values(r.metrics).reduce((a, b) => a + b, 0)),
  };
  console.log(`  → ${cfg.name} 中位(全部)=${out.arms[cfg.name].medianAllMs}ms 成功中位=${out.arms[cfg.name].medianSuccessMs}ms 步中位=${out.arms[cfg.name].perStepMedianMs}ms\n`);
}

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/settle-ab-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/settle-ab-${stamp}.json`);
