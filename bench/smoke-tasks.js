// 快速冒烟：确认 wiki 搜索 / httpbin 表单 两个任务在新引擎下能跑通
// 用法: ego-browser nodejs < bench/smoke-tasks.js
const { readFile } = await import("node:fs/promises");
const { runJevAutonomousLoop } = await import("/Users/jiangkoumo/Documents/scratchpad/ego-jev/scripts/ego-jev.mjs");
const envText = await readFile("/Users/jiangkoumo/Documents/scratchpad/jev-ultrafast/.env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1).trim()];
  })
);
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();
const textModel = {
  baseUrl: env.TEXT_MODEL_BASE_URL, model: env.TEXT_MODEL, apiKey: env.TEXT_MODEL_API_KEY,
  sessionHeader: "x-opencode-session", sessionId: "ego-jev-bench",
};
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
