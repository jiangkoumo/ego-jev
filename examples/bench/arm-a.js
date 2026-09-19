// A 组：ego-jev 单进程闭环。计时从导航之后开始（与对照组一致）。
// __BENCH_DIR__ 等占位符由 run-pair.sh 替换（ego 运行时拿不到自定义环境变量）。
const BENCH_DIR = "__BENCH_DIR__";
const { readFile } = await import("node:fs/promises");
const { resolveLib } = await import(`${BENCH_DIR}/lib.js`);
const { runJevAutonomousLoop } = await import(resolveLib(BENCH_DIR));

const task = JSON.parse(await readFile(`${BENCH_DIR}/task.json`, "utf8"));
const startedAt = Date.now();
const space = await taskSpace("bench-jev");
const page = space.page("p1");
await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });

const t0 = Date.now();
const metrics = {};
const result = await runJevAutonomousLoop(page, task.goal, {
  maxSteps: task.maxSteps || 6,
  text: task.texts,
  metrics,
  check: async (p) => (await p.url()).includes(task.verify),
});
console.log("RESULT " + JSON.stringify({
  arm: "jev", wallMs: Date.now() - t0, totalMs: Date.now() - startedAt,
  success: result.success, steps: result.steps, reason: result.reason, metrics,
}));
await space.finish({ keep: [] });
