// 无回归对照：同一会话内交替跑「改动前引擎(70b566b)」与「改动后引擎」，配对比较。
// 覆盖 hn-nav / wiki-search / select-native（判据与 verify-protocol.md 一致）。
// 用法: ego-browser nodejs < bench/fix-noregress.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const NEW = "/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs";
const OLD = `${BENCH}/fix-baseline-engine.mjs`;
const ROUNDS = Number(globalThis.__ROUNDS__ || 6);

const RE_WIKI_TITLE = /Japanese encephalitis|Search results/i;
const RE_SELECTED_DANSK = /Selected:\s*Dansk/;
const TASKS = {
  "hn-nav": {
    url: "https://news.ycombinator.com",
    goal: "先打开 new 页面，再打开 comments 页面",
    maxSteps: 6,
    assert: async (p) => ({ ok: (await p.url()).includes("/newcomments"), detail: await p.url() }),
  },
  "wiki-search": {
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "在顶部搜索框输入 Jev 并提交搜索",
    maxSteps: 6,
    assert: async (p) => {
      const url = await p.url(), title = await p.title();
      return { ok: !/Main_Page/.test(url) && (RE_WIKI_TITLE.test(title) || url.includes("search=")), detail: `title="${title.slice(0, 60)}"` };
    },
  },
  "select-native": {
    url: "http://127.0.0.1:8099/c.html",
    goal: "把语言下拉框改选为 Dansk，然后点击 Confirm",
    maxSteps: 6,
    assert: async (p) => {
      const text = await p.evaluate(() => document.body.innerText);
      return { ok: RE_SELECTED_DANSK.test(text), detail: text.trim().slice(0, 40) };
    },
  },
};

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
  sessionHeader: "x-opencode-session", sessionId: "ego-jev-fix",
};

const engines = { old: await import(OLD), new: await import(NEW) };
const out = { startedAt: new Date().toISOString(), rounds: ROUNDS, records: [] };

for (let round = 1; round <= ROUNDS; round++) {
  // 奇轮 old→new，偶轮 new→old，控制同轮内先后顺序
  const order = round % 2 === 1 ? ["old", "new"] : ["new", "old"];
  for (const taskId of Object.keys(TASKS)) {
    for (const which of order) {
      const task = TASKS[taskId];
      const space = await taskSpace(`ego-fixnr-${which}-${taskId}-${round}-${Date.now()}`);
      const page = space.page("p1");
      let rec = { round, task: taskId, engine: which, order: order.join(">") };
      try {
        await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });
        await page.waitForTimeout(800);
        const metrics = {};
        const t0 = Date.now();
        const r = await engines[which].runJevAutonomousLoop(page, task.goal, {
          apiKey: KEY, textModel, maxSteps: task.maxSteps, metrics,
          check: async (p) => (await task.assert(p)).ok,
        });
        const verdict = await task.assert(page);
        rec = {
          ...rec, elapsedMs: Date.now() - t0, steps: r.steps, success: verdict.ok, reason: r.reason,
          jevCalls: metrics["jev.request"] || 0, finalUrl: await page.url(),
          actionLabels: r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}`),
        };
      } catch (e) {
        rec = { ...rec, elapsedMs: null, success: false, reason: "harness_error", error: String(e).slice(0, 150) };
      }
      try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
      out.records.push(rec);
      console.log(`${rec.task.padEnd(14)} ${which.padEnd(4)} r${round}: ${rec.elapsedMs}ms ${rec.steps}步 ${rec.success ? "OK" : "FAIL:" + rec.reason} jev=${rec.jevCalls}`);
    }
  }
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
console.log("\n=== 配对汇总（成功样本，中位 ms）===");
for (const taskId of Object.keys(TASKS)) {
  const rows = out.records.filter((r) => r.task === taskId);
  const o = rows.filter((r) => r.engine === "old" && r.success).map((r) => r.elapsedMs);
  const n = rows.filter((r) => r.engine === "new" && r.success).map((r) => r.elapsedMs);
  const diffs = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const ro = rows.find((r) => r.round === round && r.engine === "old");
    const rn = rows.find((r) => r.round === round && r.engine === "new");
    if (ro?.success && rn?.success) diffs.push(rn.elapsedMs - ro.elapsedMs);
  }
  const md = median(diffs);
  console.log(`  ${taskId.padEnd(14)} old=${median(o)}ms(${o.length}/${ROUNDS}) new=${median(n)}ms(${n.length}/${ROUNDS}) 配对 ${diffs.length} 轮 中位差(新−旧)=${md === null ? "-" : (md > 0 ? "+" : "") + md}ms  差值=[${diffs.join(", ")}]`);
}

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/fix-noregress-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/fix-noregress-${stamp}.json`);
