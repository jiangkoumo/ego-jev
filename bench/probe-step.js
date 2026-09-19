// 用 Proxy 给 page 的每个方法计时，找出 runJevStep 里真正慢的调用
// 用法: ego-browser nodejs < bench/probe-step.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const { runJevStep } = await import("/Users/jiangkoumo/Documents/scratchpad/ego-jev/scripts/ego-jev.mjs");
const BENCH = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench";
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();
const GOAL = "先打开 new 页面，再打开 comments 页面";

function timed(page, sink) {
  return new Proxy(page, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return function (...args) {
        const t0 = Date.now();
        const finish = () => {
          const ms = Date.now() - t0;
          const k = String(key) + (key === "click" || key === "fill" || key === "evaluate" ? `(${String(args[0]).slice(0, 12)})` : "");
          sink[k] = (sink[k] || 0) + ms;
        };
        let out;
        try { out = value.apply(target, args); } catch (e) { finish(); throw e; }
        if (out && typeof out.then === "function") return out.then((v) => { finish(); return v; }, (e) => { finish(); throw e; });
        finish();
        return out;
      };
    },
  });
}

const out = { steps: [] };
for (const [label, url] of [["hn", "https://news.ycombinator.com"], ["wiki", "https://en.wikipedia.org/wiki/Main_Page"]]) {
  for (let i = 0; i < 2; i++) {
    const task = await taskSpace(`ego-probe-step-${label}-${i}-${Date.now()}`);
    const page = task.page("p1");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(900);
    const sink = {};
    const t0 = Date.now();
    const r = await runJevStep(timed(page, sink), GOAL, { apiKey: KEY, metrics: {} , stepDelay: 50, navWaitMs: 250 });
    const total = Date.now() - t0;
    const rec = { label, run: i + 1, total, action: r.action, target: r.target, urlAfter: r.urlAfter, stage: sink };
    out.steps.push(rec);
    console.log(`${label} #${i + 1}: 总计 ${total}ms | ${r.action} ${r.target || ""} → ${String(r.urlAfter).slice(-20)}`);
    for (const [k, v] of Object.entries(sink).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}ms`);
    await task.finish({ keep: [] });
  }
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/probe-step-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/probe-step-${stamp}.json`);
