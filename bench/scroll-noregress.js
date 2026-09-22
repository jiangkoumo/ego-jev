// P0-1/P0-2 无回归对照：同一会话内交替跑「改动前引擎(HEAD e29c3a9)」与「改动后引擎」，配对比较。
// 覆盖 hn-nav / wiki-search / select-native（判据与 bench/verify-protocol.md 一致）。
// 统计口径与 VERIFY-REPORT.md 对齐：配对 d=新−旧 → 中位差 + bootstrap 95% CI（10000 次，
// 固定种子）+ 符号检验；CI 跨 0 即写「无差异」。
// 用法: ego-browser nodejs < bench/scroll-noregress.js        （轮数 __ROUNDS__，默认 6）
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const NEW = "/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs";
const OLD = `${BENCH}/scroll-baseline-engine.mjs`;
const ROUNDS = Number(globalThis.__ROUNDS__ || 6);
const SEED = 20260922;

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
      const url = await p.url();
      const title = await p.title();
      return {
        ok: !/Main_Page/.test(url) && (RE_WIKI_TITLE.test(title) || url.includes("search=")),
        detail: `title="${title.slice(0, 60)}"`,
      };
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
  sessionHeader: "x-opencode-session", sessionId: "ego-jev-scroll-nr",
};

const engines = { old: await import(OLD), new: await import(NEW) };
const out = {
  startedAt: new Date().toISOString(),
  rounds: ROUNDS,
  old: { path: OLD },
  new: { path: NEW },
  records: [],
};
console.log(`OLD=${OLD}\nNEW=${NEW}\nROUNDS=${ROUNDS}`);

for (let round = 1; round <= ROUNDS; round++) {
  // 奇轮 old→new，偶轮 new→old，控制同轮内先后顺序
  const order = round % 2 === 1 ? ["old", "new"] : ["new", "old"];
  for (const taskId of Object.keys(TASKS)) {
    for (const which of order) {
      const task = TASKS[taskId];
      const space = await taskSpace(`ego-scrollnr-${which}-${taskId}-${round}-${Date.now()}`);
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
          onStep: () => {},
        });
        const verdict = await task.assert(page);
        rec = {
          ...rec,
          elapsedMs: Date.now() - t0, steps: r.steps, success: verdict.ok, reason: r.reason,
          jevCalls: metrics["jev.request"] || 0, finalUrl: await page.url(),
          actionLabels: r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}`),
          scrollMovedSteps: r.history.filter((h) => h.scrollMoved === true).length,
          progressedSteps: r.history.filter((h) => h.progressed === true).length,
          intoViewTotal: r.history.reduce((a, h) => a + (h.intoViewCount || 0), 0),
          invalidResponses: r.history.filter((h) => h.invalidResponse).length,
        };
      } catch (e) {
        rec = { ...rec, elapsedMs: null, steps: null, success: false, reason: "harness_error", error: String(e).slice(0, 200) };
      }
      try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
      out.records.push(rec);
      console.log(
        `${rec.task.padEnd(14)} ${which.padEnd(4)} r${round}: ${rec.elapsedMs}ms ${rec.steps}步 ` +
          `${rec.success ? "OK" : "FAIL:" + rec.reason} jev=${rec.jevCalls} 滚入=${rec.intoViewTotal ?? "-"}`
      );
    }
  }
}

// ── 统计 ────────────────────────────────────────────────────────────────────
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** 配对 bootstrap 95% CI（10000 次，固定种子） */
const bootstrapCI = (diffs, iterations = 10000) => {
  if (!diffs.length) return null;
  const rand = mulberry32(SEED);
  const meds = [];
  for (let i = 0; i < iterations; i++) {
    const sample = [];
    for (let j = 0; j < diffs.length; j++) sample.push(diffs[Math.floor(rand() * diffs.length)]);
    meds.push(median(sample));
  }
  meds.sort((a, b) => a - b);
  return { low: meds[Math.floor(0.025 * meds.length)], high: meds[Math.floor(0.975 * meds.length)] };
};
/** 符号检验（双侧精确二项） */
const signTest = (diffs) => {
  const pos = diffs.filter((d) => d > 0).length;
  const neg = diffs.filter((d) => d < 0).length;
  const n = pos + neg;
  if (!n) return { pos, neg, p: 1 };
  const logC = (n, k) => {
    let v = 0;
    for (let i = 1; i <= k; i++) v += Math.log(n - k + i) - Math.log(i);
    return v;
  };
  const k = Math.min(pos, neg);
  let cum = 0;
  for (let i = 0; i <= k; i++) cum += Math.exp(logC(n, i) - n * Math.log(2));
  return { pos, neg, p: Math.min(1, 2 * cum) };
};

console.log("\n=== 配对汇总（成功样本，中位 ms；d=新−旧）===");
const summary = [];
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
  const ci = bootstrapCI(diffs);
  const st = signTest(diffs);
  const crossesZero = !ci || (ci.low <= 0 && ci.high >= 0);
  summary.push({
    task: taskId,
    oldSuccess: `${o.length}/${ROUNDS}`, newSuccess: `${n.length}/${ROUNDS}`,
    oldMedian: median(o), newMedian: median(n),
    pairedRounds: diffs.length, medianDiff: md, ci, signTest: st, crossesZero,
    oldReasons: rows.filter((r) => r.engine === "old" && !r.success).map((r) => r.reason),
    newReasons: rows.filter((r) => r.engine === "new" && !r.success).map((r) => r.reason),
  });
  console.log(
    `  ${taskId.padEnd(14)} old=${median(o)}ms(${o.length}/${ROUNDS}) new=${median(n)}ms(${n.length}/${ROUNDS}) ` +
      `配对 ${diffs.length} 轮 中位差=${md === null ? "-" : (md > 0 ? "+" : "") + md}ms ` +
      `CI=[${ci ? ci.low : "-"}, ${ci ? ci.high : "-"}] 跨0=${crossesZero ? "是" : "否"} 符号=${st.pos}/${st.neg} p=${st.p.toFixed(3)}`
  );
}
out.summary = summary;

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/scroll-noregress-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/scroll-noregress-${stamp}.json`);
