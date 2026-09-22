// P0-1 验收（机制层，无需浏览器/无需 Jev）：滚动感知的进展判定 + 目标自动滚入视口。
//
// 背景（bench/../REVEAL-REPORT.md）：
//   * 旧判据「页面是否变化」只看 URL（stableUrl(urlAfter)!==stableUrl(urlBefore)）。
//     滚动不改 URL → 连续 3 次同动作即判 stuck。实测 X 时间线第 4 次滚动就被中止（A 0/15，
//     同一批 B 6/12，B 的 fingerprint() 把 scroll 位置算进指纹）。
//   * ego 官方语义动作通道会自动把目标滚入视口（SKILL.md:241「Do not pre-scroll solely to
//     make a DOM target actionable」）；我们换成裸 CDP 坐标派发后丢了这一步。
//
// 本文件用 stub page + 假 fetch 驱动真实 runJevStep / runJevAutonomousLoop：
//   [1] 滚动真的移动了视口 → 连滚 >3 次不得被 stuck 中止（D）
//   [2] 滚到页面边界、不再产生新内容 → 必须仍能停（有界性没有被放开）
//   [3] 视口没动但露出新元素 → 也算进展（D 的 (a) 分支）
//   [4] 执行前发现目标被顶出视口 → 先滚入、重新命中，再动作（A）
//   [5] 滚入也救不回（仍 offscreen）→ 仍受 guardRejected 上限约束，不成环
//
// 用法: node bench/test-scroll-progress.mjs
const { writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const { runJevStep, runJevAutonomousLoop } = await import(
  "/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs"
);

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const realFetch = globalThis.fetch;
/** 假 Jev：按 criteria 键集合生成合法回答（默认点 ref=1） */
const stubJev = (prefer = { operation: "click", click_target: "ref=1" }) => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [head, question] of Object.entries(body.questions)) {
      const keys = Object.keys(question.criteria);
      const want = prefer[head];
      const choice = want && keys.includes(want) ? want : keys.find((k) => k !== "none") ?? keys[0];
      const rest = keys.filter((k) => k !== choice);
      const probabilities = {};
      probabilities[choice] = 0.9;
      for (const k of rest) probabilities[k] = 0.1 / rest.length;
      answers[head] = { choice, confidence: 0.9, probabilities };
    }
    return { ok: true, async json() { return { model: "stub", answers, usage: {} }; } };
  };
};

/**
 * stub page。行为开关：
 *   scrollMoves  —— scrollInPage / readScrollY 是否报告视口真的移动了
 *   newCount     —— 每次观测里「新露出」的元素数
 *   offscreenOnce—— locateForInput 第一次报 offscreen，滚入后改报 ok（A 机制）
 *   alwaysOffscreen —— locateForInput 永远报 offscreen（A 也救不回）
 */
const makePage = ({ scrollMoves = true, newCount = 0, offscreenOnce = false, alwaysOffscreen = false } = {}) => {
  const calls = { cdp: 0, click: 0, intoView: 0, locate: 0 };
  let scrolledIntoView = false;
  const page = {
    calls,
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("observeDom")) {
        return {
          url: "https://example.com/",
          title: "Example",
          text: "hello",
          newCount,
          scroll: { y: 0, height: 4000, viewportH: 600, canScrollDown: true, canScrollUp: false },
          targets: [
            { ref: "ref=1", role: "link", kind: "clickable", name: "Next", guard: [1, "link", "Next", false, null, "/next"] },
          ],
        };
      }
      if (src.includes("scrollNodeIntoView")) {
        calls.intoView += 1;
        scrolledIntoView = true;
        return { ok: true, y: 600 };
      }
      if (src.includes("locateForInput")) {
        calls.locate += 1;
        if (alwaysOffscreen || (offscreenOnce && !scrolledIntoView)) return { ok: false, reason: "offscreen" };
        return { ok: true, x: 10, y: 20, url: "https://example.com/", disabled: false, ariaDisabled: null, href: "/next" };
      }
      if (src.includes("readyState")) return ["https://example.com/", "complete"]; // settle 立刻返回
      if (src.includes("scrollInPage")) return { moved: scrollMoves, y: scrollMoves ? 600 : 0 };
      if (src.includes("readScrollY")) return scrollMoves ? 600 : 0;
      if (src.includes("location.href")) return "https://example.com/";
      return null;
    },
    async url() { return "https://example.com/"; },
    async title() { return "Example"; },
    async cdp() { calls.cdp += 1; },
    async click() { calls.click += 1; },
    async fill() {},
    async press() {},
    async selectOption() {},
    async waitForLoadState() {},
    async events() { return []; },
    async waitForTimeout() {},
  };
  return page;
};

const silent = () => {};

// ── [1] 滚动真的移动了视口 → 连滚 >3 次不被 stuck ────────────────────────────
console.log("\n[1] 滚动带来视口位移 = 有进展（D 的 (b) 分支）");
{
  stubJev({ operation: "scroll_down" });
  const page = makePage({ scrollMoves: true });
  const r = await runJevAutonomousLoop(page, "往下找", { apiKey: "stub", metrics: {}, maxSteps: 6, onStep: silent });
  check("连滚 6 次没有被 stuck 中止", r.reason !== "stuck", JSON.stringify(r.reason));
  check("确实跑了 6 步（>3）", r.steps === 6, `steps=${r.steps}`);
  check("每步 scrollMoved=true", r.history.every((h) => h.scrollMoved === true), JSON.stringify(r.history.map((h) => h.scrollMoved)));
  check("每步 progressed=true", r.history.every((h) => h.progressed === true), JSON.stringify(r.history.map((h) => h.progressed)));
  check("changed 仍为 false（URL 没变，语义没被混淆）", r.history.every((h) => h.changed === false));
  check("步数上限仍是硬边界", r.reason === "max_steps_reached", JSON.stringify(r.reason));
}

// ── [2] 到页面边界 / 滚动不再产生新内容 → 必须能停 ──────────────────────────
console.log("\n[2] 视口不动且无新内容 → 仍必须停在 stuck（有界性）");
{
  stubJev({ operation: "scroll_down" });
  const page = makePage({ scrollMoves: false, newCount: 0 });
  const r = await runJevAutonomousLoop(page, "往下找", { apiKey: "stub", metrics: {}, maxSteps: 10, onStep: silent });
  check("滚不动且无新内容 → reason=stuck", r.reason === "stuck", JSON.stringify(r.reason));
  check("第 4 步停下（3 次同动作）", r.steps === 4, `steps=${r.steps}`);
  check("scrollMoved=false", r.history.every((h) => h.scrollMoved === false), JSON.stringify(r.history.map((h) => h.scrollMoved)));
}

// ── [3] 视口没动但露出新元素 → 也算进展（D 的 (a) 分支） ────────────────────
console.log("\n[3] 滚动露出新元素 = 有进展（D 的 (a) 分支，用观测层已有的 newTargetCount）");
{
  stubJev({ operation: "scroll_down" });
  const page = makePage({ scrollMoves: false, newCount: 3 });
  const r = await runJevAutonomousLoop(page, "往下找", { apiKey: "stub", metrics: {}, maxSteps: 5, onStep: silent });
  check("露出新元素 → 不被 stuck 中止", r.reason !== "stuck", JSON.stringify(r.reason));
  check("跑满 5 步", r.steps === 5, `steps=${r.steps}`);
}

// ── [4] A：执行前目标被顶出视口 → 先滚入、重新命中，再动作 ──────────────────
console.log("\n[4] 目标 offscreen → 先滚入视口再动作（A 机制）");
{
  stubJev({ operation: "click", click_target: "ref=1" });
  const page = makePage({ offscreenOnce: true });
  let checks = 0;
  const r = await runJevAutonomousLoop(page, "点 Next", {
    apiKey: "stub", metrics: {}, maxSteps: 3, onStep: silent,
    check: async () => ++checks > 1, // 第 1 步动作后即判成功
  });
  const h = r.history[0] || {};
  check("目标被滚入视口 1 次", h.intoViewCount === 1, JSON.stringify(h.intoViewCount));
  check("滚动后重新命中成功、未被守卫拒绝", !h.guardRejected, JSON.stringify(h.guardRejected));
  check("点击真的派发了（2 个 CDP 鼠标事件）", page.calls.cdp === 2, `cdp=${page.calls.cdp}`);
  check("滚动后重做过命中测试（locate 调了 2 次）", page.calls.locate === 2, `locate=${page.calls.locate}`);
  check("循环以成功收尾", r.success === true && r.reason === "check_passed_after_step", JSON.stringify({ success: r.success, reason: r.reason }));
}

// ── [5] A 也救不回（仍 offscreen）→ 仍受上限约束，不成环 ─────────────────────
console.log("\n[5] 滚入也救不回 → 仍受 guardRejected 上限约束");
{
  stubJev({ operation: "click", click_target: "ref=1" });
  const page = makePage({ alwaysOffscreen: true });
  const r = await runJevAutonomousLoop(page, "点 Next", { apiKey: "stub", metrics: {}, maxSteps: 10, onStep: silent });
  check("reason=guard_rejected（不是无限重试）", r.reason === "guard_rejected", JSON.stringify(r.reason));
  check("第 3 步停下", r.steps === 3, `steps=${r.steps}`);
  check("每步只滚入 1 次（步内不成环）", r.history.every((h) => h.intoViewCount === 1), JSON.stringify(r.history.map((h) => h.intoViewCount)));
  check("始终没有派发鼠标事件", page.calls.cdp === 0, `cdp=${page.calls.cdp}`);
}

// ── [6] 单步结果里进展字段齐全（供基准统计） ────────────────────────────────
console.log("\n[6] 单步结果暴露 progressed / scrollMoved / intoViewCount");
{
  stubJev({ operation: "scroll_down" });
  const page = makePage({ scrollMoves: true });
  const r = await runJevStep(page, "往下找", { apiKey: "stub", metrics: {} });
  check("scrollMoved=true", r.scrollMoved === true, JSON.stringify(r.scrollMoved));
  check("progressed=true", r.progressed === true, JSON.stringify(r.progressed));
  check("changed=false", r.changed === false, JSON.stringify(r.changed));
  check("intoViewCount=0（本步没有点元素）", r.intoViewCount === 0, JSON.stringify(r.intoViewCount));
}

globalThis.fetch = realFetch;
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-scroll-progress-${stamp}.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-scroll-progress-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
