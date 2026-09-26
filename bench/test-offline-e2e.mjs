// P1-3 验收：判定器可注入 + 无需凭证的离线端到端自测。
//
// 为什么需要：其余测试都用 stub 改 globalThis.fetch，只覆盖「请求发出去了」；
// 「观测 → 决策 → 执行 → 校验」这条真实链路（真实 observeDom、真实 locate、真实裸 CDP 派发、
// 真实 DOM 结果）离线零覆盖。这里用 options.ask 注入一个确定性判定器（不联网、不需要 key），
// 其余全走真实路径，断言落到真实 DOM 属性值（window.__clicked / input.value）。
//
// 同时验证 P1-4 的分阶段耗时（观测/决策/执行/校验）与「注入 ask 时不碰网络」这条不变量。
//
// 用法（测当前工作树）: sed "s|__REPO__|$PWD|g" bench/test-offline-e2e.mjs | ego-browser nodejs
// 直接 `< bench/test-offline-e2e.mjs`：走已安装技能（~/.agents/skills/ego-jev，本机是指向仓库的软链）
const { writeFile, mkdir } = await import("node:fs/promises");
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { BENCH, JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});
const { runJevAutonomousLoop } = await import(JE);

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ── 网络哨兵：整个用例必须一次 fetch 都不发（证明离线、不需要 key）──
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };

/**
 * 注入的判定器：签名与引擎自己的 askJev 一致（state 文本 + questions 对象 + options）。
 * 只依据 questions 的 criteria 键集合选，不直接读 DOM——像一个真实决策器那样。
 */
const askPolicy = (op, wantName) => (state, questions) => {
  const answers = {};
  for (const [head, question] of Object.entries(questions)) {
    const keys = Object.keys(question.criteria);
    let choice;
    if (head === "operation") {
      choice = keys.includes(op) ? op : keys.find((k) => k !== "none") ?? keys[0];
    } else if (head === "click_target" || head === "type_text_target") {
      choice =
        keys.find((k) => k !== "none" && question.criteria[k].includes(wantName)) ??
        keys.find((k) => k !== "none") ??
        keys[0];
    } else {
      choice = keys.find((k) => k !== "none") ?? keys[0];
    }
    const rest = keys.filter((k) => k !== choice);
    const probabilities = { [choice]: 0.9 };
    for (const k of rest) probabilities[k] = 0.1 / rest.length;
    answers[head] = { choice, confidence: 0.9, probabilities };
  }
  return answers;
};

const FIXTURE = `
  <button id="go" style="width:140px;height:40px" onclick="window.__clicked=1">开始</button>
  <input id="q" aria-label="查询框" style="width:220px;height:32px">
`;

const space = await taskSpace(`ego-offline-${Date.now()}`);
const page = space.page("p1");
try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => { document.body.innerHTML = html; }, FIXTURE);

  // ── [1] 真实观测 → 注入决策 → 真实 CDP 点击 → 真实 DOM 断言 ──
  console.log("\n[1] 点击：真实观测 → 注入决策 → 真实 CDP 点击 → window.__clicked === 1");
  {
    const r = await runJevAutonomousLoop(page, "点击「开始」按钮", {
      ask: askPolicy("click", "开始"),
      maxSteps: 3,
      onStep: () => {},
      check: async (p) => (await p.evaluate(() => window.__clicked || 0)) === 1,
    });
    const clicked = await page.evaluate(() => window.__clicked || 0);
    console.log("  trace: " + JSON.stringify((r.history || []).map((h) => ({ action: h.action, target: h.target, label: h.targetLabel }))));
    check("循环成功（check 命中真实 DOM）", r.success === true, JSON.stringify({ success: r.success, reason: r.reason }));
    check("真实页面 window.__clicked === 1", clicked === 1, `clicked=${clicked}`);
    check("未发生守卫拒绝", (r.history || []).every((h) => !h.guardRejected), JSON.stringify((r.history || []).map((h) => h.guardRejected)));
    // ── [4] 分阶段耗时 ──
    check("loop 结果带 phases（观测/决策/执行/校验）", r.phases && ["observeMs", "decideMs", "executeMs", "verifyMs"].every((k) => typeof r.phases[k] === "number"), JSON.stringify(r.phases));
    const step = (r.history || [])[0] || {};
    const sum = step.phases ? step.phases.observeMs + step.phases.decideMs + step.phases.executeMs + step.phases.verifyMs : null;
    check("单步 phases 之和 = stepDurationMs（±2ms）", sum !== null && Math.abs(sum - step.stepDurationMs) <= 2, JSON.stringify({ sum, stepDurationMs: step.stepDurationMs }));
    check("注入 ask 时不带服务端模型（serverModel=null）", step.serverModel === null, JSON.stringify(step.serverModel));
  }

  // ── [2] 真实输入：注入决策 → 真实 CDP 输入 → 真实 DOM 断言 ──
  console.log("\n[2] 填写：真实观测 → 注入决策 → 真实 CDP 输入 → input.value === 'hello-offline'");
  {
    const r = await runJevAutonomousLoop(page, "在「查询框」里填入 hello-offline", {
      ask: askPolicy("type_text", "查询框"),
      text: ["hello-offline"],
      maxSteps: 3,
      onStep: () => {},
      check: async (p) => (await p.evaluate(() => document.getElementById("q").value)) === "hello-offline",
    });
    const value = await page.evaluate(() => document.getElementById("q").value);
    check("循环成功", r.success === true, JSON.stringify({ success: r.success, reason: r.reason }));
    check("真实页面 input.value === 'hello-offline'", value === "hello-offline", JSON.stringify(value));
  }

  // ── [3] 注入的判定器同样要过 validateChoice：不合规 → 不执行 ──
  console.log("\n[3] 不合规的注入决策 → invalidResponse，且不执行");
  {
    const badAsk = (state, questions) => {
      const good = askPolicy("click", "开始")(state, questions);
      good.operation.probabilities[good.operation.choice] = 0.4; // 概率和 ≠ 1
      return good;
    };
    await page.evaluate(() => { window.__clicked = 0; });
    const r = await runJevAutonomousLoop(page, "点击「开始」按钮", {
      ask: badAsk,
      maxSteps: 2,
      onStep: () => {},
    });
    const clicked = await page.evaluate(() => window.__clicked || 0);
    check("连续不合规 → reason=invalid_response", r.reason === "invalid_response", JSON.stringify(r.reason));
    check("不合规决策没有执行（window.__clicked 仍为 0）", clicked === 0, `clicked=${clicked}`);
  }

  // ── [4] 离线不变量 ──
  console.log("\n[4] 离线不变量");
  check("整个用例一次 fetch 都没发（不联网、不需要 key）", fetchCalls === 0, `fetchCalls=${fetchCalls}`);
} catch (e) {
  check("离线端到端用例执行完成", false, String(e).slice(0, 400));
} finally {
  globalThis.fetch = realFetch;
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-offline-e2e-${stamp}.json`, JSON.stringify({ pass, fail, fetchCalls, results }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-offline-e2e-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
