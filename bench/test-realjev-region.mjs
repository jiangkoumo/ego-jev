// 真实 Jev 回归：`clickable-region` 这个我们自造的 role 词元，Jev 能不能理解并当作点击目标。
//
// 为什么必须单独测：其余 region 用例都用 stub 改 globalThis.fetch，只证明「元素表里有它、点了会生效」，
// 从没让真实 Jev 在候选里见过这个词元。这里用真实 Jev 跑 runJevAutonomousLoop：
// 目标文本动态取自页面上真实存在的 region（YouTube 首页的视频元数据块），成功判据是确定性的
// URL 跳转（/watch），并断言 Jev 实际选中的 target 标签里带 `clickable-region`。
//
// 需要网络 + Jev 凭证；两者缺一时 **SKIP**（打印原因、exit 0，但汇总行不写「通过」，不伪装成功）。
// 用法: sed "s|__REPO__|$PWD|g" bench/test-realjev-region.mjs | ego-browser nodejs
const { writeFile, mkdir } = await import("node:fs/promises");
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});
const { runJevStep, runJevAutonomousLoop, loadApiKey } = await import(JE);

let pass = 0;
let fail = 0;
let skipped = null;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const raw = { scenario: "real-jevu-selects-clickable-region", results, skipped: null, history: [], goal: null, finalUrl: null, regionText: null };

// ── 前置：凭证 ──
const key = loadApiKey();
if (!key) {
  skipped = "未找到 Jev 凭证（~/.config/typesafe/api_key）";
  console.log(`SKIP: ${skipped}`);
}

// ── 用 stub 观测一次，动态取一个真实 region 的文本（不联网调用 Jev）──
const realFetch = globalThis.fetch;
let lastBody = null;
const stubJev = () => {
  globalThis.fetch = async (_url, init) => {
    lastBody = init.body;
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [head, question] of Object.entries(body.questions)) {
      const keys = Object.keys(question.criteria);
      const choice = keys.find((k) => k !== "none") ?? keys[0];
      const probabilities = { [choice]: 0.9 };
      for (const k of keys.filter((k) => k !== choice)) probabilities[k] = 0.1 / (keys.length - 1);
      answers[head] = { choice, confidence: 0.9, probabilities };
    }
    return { ok: true, async json() { return { model: "stub", answers, usage: {} }; } };
  };
};

const space = await taskSpace(`ego-realjev-${Date.now()}`);
const page = space.page("p1");
try {
  if (!skipped) {
    try {
      await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(3000);
    } catch (e) {
      skipped = `无法访问 https://www.youtube.com/：${String(e).slice(0, 120)}`;
      console.log(`SKIP: ${skipped}`);
    }
  }

  let regionText = null;
  if (!skipped) {
    stubJev();
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    globalThis.fetch = realFetch;
    const lines = (JSON.parse(lastBody).state.split("当前视口内可交互元素")[1] || "")
      .split("\n").filter((l) => l.includes("clickable-region"));
    regionText = lines.map((l) => (l.match(/"([^"]*)"/) || [])[1]).find((t) => t && t.length > 6) || null;
    raw.regionText = regionText;
    check("YouTube 首页观测到真实 clickable-region", Boolean(regionText), JSON.stringify(lines));
  }

  if (!skipped && regionText) {
    const goal = `点击页面上显示「${regionText}」的那一块区域`;
    raw.goal = goal;
    const result = await runJevAutonomousLoop(page, goal, {
      apiKey: key,
      maxSteps: 3,
      onStep: () => {},
      check: async (p) => (await p.url()).includes("/watch"),
    });
    raw.finalUrl = await page.url();
    raw.history = (result.history || []).map((h) => ({ action: h.action, target: h.target, targetLabel: h.targetLabel, changed: h.changed }));
    console.log("  真实 Jev trace:\n" + JSON.stringify(raw.history, null, 1));
    const first = raw.history[0] || {};
    check("真实 Jev 走完整轮并达成确定性 check（URL → /watch）", result.success === true && raw.finalUrl.includes("/watch"), JSON.stringify({ success: result.success, reason: result.reason, finalUrl: raw.finalUrl }));
    check("Jev 选中的 operation 是 click", first.action === "click", String(first.action));
    check("Jev 选中的 target 标签带 clickable-region", String(first.targetLabel || "").includes("clickable-region"), String(first.targetLabel));
  }
} catch (e) {
  check("真实 Jev region 用例执行完成", false, String(e).slice(0, 400));
} finally {
  globalThis.fetch = realFetch;
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

if (skipped) {
  console.log(`\n结果: SKIP（${skipped}）— 未执行，不计通过`);
} else {
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
raw.skipped = skipped;
raw.pass = pass;
raw.fail = fail;
await writeFile(`${BENCH}/raw/test-realjev-region-${stamp}.json`, JSON.stringify(raw, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-realjev-region-${stamp}.json`);
process.exitCode = skipped ? 0 : fail ? 1 : 0;
