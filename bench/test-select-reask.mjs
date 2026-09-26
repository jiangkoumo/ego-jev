// P2-7 验收（机制层，无需浏览器/凭证）：下拉「选中项不在当前 options 里」→ 一次带新选项的重问。
//
// 背景：原生下拉在真实站点上不稳定——观测时选中的 option 到执行时可能已经不在 DOM 的 options 里
// （选项被 JS 重建/重排）。旧实现把它当失败/无进展，最后以 stuck 收场。
// 新行为：这类一步用 **一次** 带新选项的重问（下一次 runJevStep 重新观测，新 options 自然进候选），
// 重问仍失败 → 显式报 stuck（不静默、不无限循环）。
//
// 关键：本用例的观测**不是常量**——第一次观测后 options 会变（Dansk 从 #1 移到 #2，模拟 DOM 真的变了），
// 并记录第二次 Jev 请求体，断言新选项出现在 select_target 候选里且被选中。若实现退化成「重问复用旧
// options、不做新观测」，第 2 次请求里就不会有 ref=1#2，用例会失败（可判别性验证见报告）。
//
// 用法: node bench/test-select-reask.mjs
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const JE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "decider-loop.mjs");
const { runJevStep, runJevAutonomousLoop } = await import(JE);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const realFetch = globalThis.fetch;
let bodies = [];
/** 假 Jev：只依据 questions 的 criteria 选，选到「改选为 Dansk」的那一项；记录每次请求体 */
const stubJev = () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const answers = {};
    for (const [head, question] of Object.entries(body.questions)) {
      const keys = Object.keys(question.criteria);
      let choice;
      if (head === "operation") choice = keys.includes("select") ? "select" : keys.find((k) => k !== "none") ?? keys[0];
      else if (head === "select_target") {
        choice = keys.find((k) => k !== "none" && /Dansk/i.test(question.criteria[k])) ?? keys.find((k) => k !== "none") ?? keys[0];
      } else choice = keys.find((k) => k !== "none") ?? keys[0];
      const rest = keys.filter((k) => k !== choice);
      const probabilities = { [choice]: 0.9 };
      for (const k of rest) probabilities[k] = 0.1 / rest.length;
      answers[head] = { choice, confidence: 0.9, probabilities };
    }
    return { ok: true, async json() { return { model: "stub", answers, usage: {} }; } };
  };
};

const URL_ = "https://example.com/";
const obsOf = (options, optionValues) => ({
  url: URL_, title: "Example", text: "",
  targets: [{
    ref: "ref=1", role: "combobox", kind: "selectable", name: "Language",
    options, optionValues, selectedIndex: 0, value: options[0],
    guard: [1, "combobox", "Language", false, null, null],
  }],
});
// 第一次观测：Dansk 在 #1；第二次观测：options 被 JS 重建，Dansk 移到 #2
const OBS1 = obsOf(["English", "Dansk", "Deutsch"], ["en", "da", "de"]);
const OBS2 = obsOf(["English", "Deutsch", "Dansk (Danmark)"], ["en", "de", "da"]);

/** selectResults: 每次 selectInPage 依次返回；observations: 每次 observeDom 依次返回 */
const makePage = ({ selectResults, observations }) => {
  const calls = { select: 0, observe: 0 };
  return {
    calls,
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("observeDom")) {
        const o = observations[Math.min(calls.observe, observations.length - 1)];
        calls.observe += 1;
        return o;
      }
      if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: URL_, disabled: false, ariaDisabled: null, href: null };
      if (src.includes("selectInPage")) {
        const r = selectResults[Math.min(calls.select, selectResults.length - 1)];
        calls.select += 1;
        return r;
      }
      if (src.includes("readyState")) return [URL_, "complete"];
      if (src.includes("location.href")) return URL_;
      return null;
    },
    async url() { return URL_; },
    async title() { return "Example"; },
    async cdp() {},
    async click() {},
    async fill() {},
    async press() {},
    async selectOption() {},
    async waitForLoadState() {},
    async events() { return []; },
    async waitForTimeout() {},
  };
};

// ── [1] 单步：选中项不在 options 里 → optionStale（不是 error / guardRejected） ──
console.log("\n[1] 单步返回 optionStale，而不是 error/guardRejected");
{
  const page = makePage({ selectResults: [{ ok: false, reason: "option_unavailable" }], observations: [OBS1] });
  stubJev();
  const r = await runJevStep(page, "改选 Dansk", { apiKey: "stub", metrics: {} });
  check("optionStale=true", r.optionStale === true, JSON.stringify(r.optionStale));
  check("没有 error", !r.error, JSON.stringify(r.error));
  check("没有 guardRejected", !r.guardRejected, JSON.stringify(r.guardRejected));
  check("没有 targetMissing（不算目标缺失）", !r.targetMissing, JSON.stringify(r.targetMissing));
}

// ── [2] 循环：第 1 次 optionStale → 重问（带新 options）；第 2 次成功 ──
console.log("\n[2] 一次带新选项的重问后成功（观测确实变了）");
{
  bodies = [];
  const page = makePage({
    selectResults: [{ ok: false, reason: "option_unavailable" }, { ok: true, selected: "Dansk (Danmark)" }],
    observations: [OBS1, OBS2],
  });
  stubJev();
  const r = await runJevAutonomousLoop(page, "改选 Dansk", {
    apiKey: "stub", metrics: {}, maxSteps: 5, onStep: () => {},
    check: async (p) => p.calls.select >= 2,
  });
  check("整体成功", r.success === true, JSON.stringify({ success: r.success, reason: r.reason, steps: r.steps }));
  check("第 1 步是 optionStale", r.history?.[0]?.optionStale === true, JSON.stringify(r.history?.[0]?.optionStale));
  check("selectInPage 被调了 2 次（一次重问）", page.calls.select === 2, `select=${page.calls.select}`);
  check("观测被调了 ≥2 次（重问重新观测了）", page.calls.observe >= 2, `observe=${page.calls.observe}`);
  check("第 1 次请求：Dansk 在 ref=1#1", Boolean(bodies[0]?.questions?.select_target?.criteria?.["ref=1#1"]?.includes("Dansk")), JSON.stringify(bodies[0]?.questions?.select_target?.criteria || {}));
  // 关键：第 2 次请求必须带上**新 options**（Dansk 已移到 ref=1#2）
  const c2 = bodies[1]?.questions?.select_target?.criteria || {};
  check("第 2 次请求带上了新 options（ref=1#2 = Dansk (Danmark)）", Boolean(c2["ref=1#2"]?.includes("Dansk (Danmark)")), JSON.stringify(c2));
  check("第 2 次请求里旧位置 ref=1#1 不再是 Dansk", !(c2["ref=1#1"] || "").includes("Dansk"), JSON.stringify(c2["ref=1#1"]));
  check("Jev 第 2 步选中了新的 ref=1#2", r.history?.[1]?.option === "Dansk (Danmark)" && r.history?.[1]?.target === "ref=1#2", JSON.stringify({ option: r.history?.[1]?.option, target: r.history?.[1]?.target }));
}

// ── [3] 循环：重问仍失败 → 显式报 stuck（默认 maxOptionRetries=1） ──
console.log("\n[3] 重问仍失败 → 显式 stuck");
{
  const page = makePage({
    selectResults: [{ ok: false, reason: "option_unavailable" }],
    observations: [OBS1, OBS2],
  });
  stubJev();
  const r = await runJevAutonomousLoop(page, "改选 Dansk", { apiKey: "stub", metrics: {}, maxSteps: 8, onStep: () => {} });
  check("reason=stuck", r.reason === "stuck", JSON.stringify(r.reason));
  check("第 2 步就停（1 次重问）", r.steps === 2, `steps=${r.steps}`);
  check("selectInPage 恰好 2 次", page.calls.select === 2, `select=${page.calls.select}`);
}

// ── [4] 可配置：maxOptionRetries=0 → 不重问，直接 stuck ──
console.log("\n[4] maxOptionRetries=0 → 不重问，直接 stuck");
{
  const page = makePage({ selectResults: [{ ok: false, reason: "option_unavailable" }], observations: [OBS1, OBS2] });
  stubJev();
  const r = await runJevAutonomousLoop(page, "改选 Dansk", { apiKey: "stub", metrics: {}, maxSteps: 8, onStep: () => {}, maxOptionRetries: 0 });
  check("reason=stuck", r.reason === "stuck", JSON.stringify(r.reason));
  check("第 1 步就停", r.steps === 1, `steps=${r.steps}`);
  check("selectInPage 恰好 1 次", page.calls.select === 1, `select=${page.calls.select}`);
}

globalThis.fetch = realFetch;
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
