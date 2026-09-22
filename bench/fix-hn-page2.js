// hn-page2 功能验收：10 轮 × {改动前引擎, 改动后引擎} 交替，同一会话内配对。
// 判据沿用 bench/verify-protocol.md：终态 URL 含 p=2。
// 用法: ego-browser nodejs < bench/fix-hn-page2.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/fix-hn-page2.js | ego-browser nodejs
// ② 直接 `< bench/fix-hn-page2.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const NEW = JE;
const OLD = `${BENCH}/fix-baseline-engine.mjs`;
const ROUNDS = Number(globalThis.__ROUNDS__ || 10);
const GOAL = "翻到下一页（More）";
const START = "https://news.ycombinator.com";

const KEY = await loadBenchApiKey();
const engines = { old: await import(OLD), new: await import(NEW) };
const out = { task: "hn-page2", goal: GOAL, rounds: ROUNDS, predicate: "finalUrl 含 p=2", records: [] };

for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 === 1 ? ["old", "new"] : ["new", "old"];
  for (const which of order) {
    const space = await taskSpace(`ego-fixp2-${which}-${round}-${Date.now()}`);
    const page = space.page("p1");
    let rec = { round, engine: which, order: order.join(">") };
    try {
      await page.goto(START, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(800);
      const metrics = {};
      const t0 = Date.now();
      const r = await engines[which].runJevAutonomousLoop(page, GOAL, {
        apiKey: KEY, maxSteps: 8, metrics,
        check: async (p) => (await p.url()).includes("p=2"),
      });
      const url = await page.url();
      rec = {
        ...rec, elapsedMs: Date.now() - t0, steps: r.steps, success: url.includes("p=2"),
        reason: r.reason, jevCalls: metrics["jev.request"] || 0, finalUrl: url,
        actionLabels: r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}`),
      };
    } catch (e) {
      rec = { ...rec, elapsedMs: null, steps: null, success: false, reason: "harness_error", error: String(e).slice(0, 150) };
    }
    try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
    out.records.push(rec);
    console.log(`hn-page2 ${which.padEnd(4)} r${round}: ${rec.elapsedMs}ms ${rec.steps}步 ${rec.success ? "✅OK" : "❌" + rec.reason} jev=${rec.jevCalls} | ${String(rec.finalUrl).slice(-18)} | ${JSON.stringify(rec.actionLabels || [])}`);
  }
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
for (const which of ["old", "new"]) {
  const rs = out.records.filter((r) => r.engine === which);
  const ok = rs.filter((r) => r.success);
  console.log(`\n${which}: 成功率 ${ok.length}/${rs.length}  成功中位 ${median(ok.map((r) => r.elapsedMs))}ms  步中位 ${median(ok.map((r) => r.steps))}  Jev中位 ${median(ok.map((r) => r.jevCalls))}`);
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/fix-hn-page2-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/fix-hn-page2-${stamp}.json`);
