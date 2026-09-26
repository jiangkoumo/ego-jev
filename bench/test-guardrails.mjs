// 护栏的端到端验证：正常路径 0 次误拒（见 isolation 数据），这里证明「异常路径确实会被拦住」。
// 用 stub page + 假 fetch 驱动真实 runJevStep / runJevAutonomousLoop，不需要浏览器。
// 用法: node bench/test-guardrails.mjs
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
// 相对自身定位，不要写死绝对路径——CI 与别人的机器上都要能跑
const JE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ego-jev.mjs");
const { validateChoice, runJevStep, runJevAutonomousLoop, assessDanger } = await import(JE);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ── 1) validateChoice 单元 ──────────────────────────────────────────────────
console.log("\n[1] validateChoice 单元用例");
const ids = ["click", "done", "blocked", "none"];
const good = { choice: "click", confidence: 0.9, probabilities: { click: 0.9, done: 0.05, blocked: 0.03, none: 0.02 } };
const cases = [
  [good, null],
  [{ ...good, choice: "teleport" }, "choice_not_offered"],
  [{ ...good, probabilities: { click: 0.9, done: 0.1 } }, "criteria_key_mismatch"],
  [{ ...good, probabilities: { click: 0.5, done: 0.3, blocked: 0.1, none: 0.05 } }, "probabilities_not_normalized"],
  [{ ...good, choice: "done", probabilities: { click: 0.9, done: 0.05, blocked: 0.03, none: 0.02 } }, "choice_not_argmax"],
  [{ ...good, confidence: 1.4 }, "probability_out_of_range"],
  [{ ...good, probabilities: { click: NaN, done: 0.05, blocked: 0.03, none: 0.02 } }, "probability_out_of_range"],
  [{ choice: "click" }, "no_probabilities"],
  [null, "no_answer"],
];
for (const [answer, want] of cases) check(`validateChoice → ${want}`, validateChoice(answer, ids) === want, `得到 ${validateChoice(answer, ids)}`);

// ── 公共 stub ───────────────────────────────────────────────────────────────
const observation = {
  url: "https://example.com/",
  title: "Example",
  text: "hello",
  targets: [
    { ref: "ref=1", role: "link", kind: "clickable", name: "Next", guard: [1, "link", "Next", false, null, "/next"] },
    { ref: "ref=2", role: "textbox", kind: "editable", name: "Query", guard: [2, "textbox", "Query", false, null, null] },
  ],
};
const makePage = (overrides = {}) => {
  const calls = { click: 0, cdp: 0, fill: 0 };
  const page = {
    calls,
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("observeDom") || src.includes("document.querySelectorAll")) return observation;
      if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: observation.url, disabled: false, ariaDisabled: null, href: "/next" };
      if (src.includes("location.href")) return observation.url;
      if (src.includes("scrollInPage") || src.includes("scrollY")) return { moved: true, y: 600 };
      return null;
    },
    async url() { return observation.url; },
    async title() { return observation.title; },
    async cdp() { calls.cdp++; },
    async click() { calls.click++; },
    async fill() { calls.fill++; },
    async press() { calls.press = (calls.press || 0) + 1; },
    async selectOption() { calls.select = (calls.select || 0) + 1; },
    async waitForLoadState() {},
    async events() { return []; },
    async waitForTimeout() {},
    ...overrides,
  };
  return page;
};
const realFetch = globalThis.fetch;
/**
 * 假 Jev 端点：从请求体里的真实 criteria 键集合生成合法回答，
 * 这样测试不会因为「猜错了候选键」而失败；再用 corrupt 钩子制造异常。
 */
const stubJev = ({ prefer = {}, corrupt = null } = {}) => {
  globalThis.fetch = async (url, init) => {
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
    if (corrupt) corrupt(answers, body);
    return { ok: true, async json() { return { model: "stub", answers, usage: {} }; } };
  };
};

// ── 2) 不合格响应必须「不执行」 ─────────────────────────────────────────────
console.log("\n[2] 响应校验不合格时不得执行动作");
{
  const page = makePage();
  stubJev({
    prefer: { operation: "click", click_target: "ref=1" },
    corrupt: (answers) => { answers.operation.probabilities.click = 0.4; }, // 概率和 ≠ 1
  });
  const r = await runJevStep(page, "点 Next", { apiKey: "stub", metrics: {} });
  check("概率和≠1 → invalidResponse=probabilities_not_normalized", r.invalidResponse === "probabilities_not_normalized", JSON.stringify(r.invalidResponse));
  check("不合格时没有执行任何点击", page.calls.click === 0 && page.calls.cdp === 0, JSON.stringify(page.calls));
}
{
  const page = makePage();
  stubJev({
    prefer: { operation: "click", click_target: "ref=1" },
    corrupt: (answers) => { answers.click_target.choice = "ref=99"; }, // 不在候选集合里
  });
  const r = await runJevStep(page, "点 Next", { apiKey: "stub", metrics: {} });
  check("choice 不在候选集合内 → choice_not_offered", r.invalidResponse === "choice_not_offered", JSON.stringify(r.invalidResponse));
  check("不合格时没有执行任何点击（目标头）", page.calls.click === 0 && page.calls.cdp === 0);
}
{
  const page = makePage();
  stubJev({
    prefer: { operation: "click", click_target: "ref=1" },
    corrupt: (answers) => {
      // 与另一个候选交换概率值：argmax 不再是被选中的那个，但总和不变（否则会先报 not_normalized）
      const p = answers.click_target.probabilities;
      const chosen = answers.click_target.choice;
      const other = Object.keys(p).find((k) => k !== chosen);
      const swapped = p[chosen];
      p[chosen] = p[other];
      p[other] = swapped;
    },
  });
  const r = await runJevStep(page, "点 Next", { apiKey: "stub", metrics: {} });
  check("choice 不是 argmax → choice_not_argmax", r.invalidResponse === "choice_not_argmax", JSON.stringify(r.invalidResponse));
  check("不合格时没有执行任何点击（argmax）", page.calls.click === 0 && page.calls.cdp === 0);
}

// ── 3) 执行前守卫：节点在决策后消失 → 拒绝执行 ──────────────────────────────
console.log("\n[3] 执行前守卫（陈旧检测）");
{
  const page = makePage({
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("observeDom")) return observation;
      if (src.includes("locateForInput")) return { ok: false, reason: "node_gone" };
      return null;
    },
  });
  stubJev({ prefer: { operation: "click", click_target: "ref=1" } });
  const r = await runJevStep(page, "点 Next", { apiKey: "stub", metrics: {} });
  check("节点消失 → guardRejected=node_gone", r.guardRejected === "node_gone", JSON.stringify(r.guardRejected));
  check("守卫拒绝时没有派发鼠标事件", page.calls.cdp === 0);
}
{
  const page = makePage({
    async evaluate(fn, arg) {
      const src = String(fn);
      if (src.includes("observeDom")) return observation;
      // 指纹里的 href 变了 → 决策已陈旧
      if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: observation.url, disabled: false, ariaDisabled: null, href: "/changed" };
      return null;
    },
  });
  stubJev({ prefer: { operation: "click", click_target: "ref=1" } });
  const r = await runJevStep(page, "点 Next", { apiKey: "stub", metrics: {} });
  check("结构指纹变化 → guardRejected=stale_guard", r.guardRejected === "stale_guard", JSON.stringify(r.guardRejected));
  check("陈旧决策不执行", page.calls.cdp === 0);
}

// ── 4) 连续无变化 → 判 blocked（对齐 jev-ultrafast 的 repeated 段） ───────────
console.log("\n[4] 连续 3 次动作页面无变化 → 停止");
{
  const page = makePage();
  stubJev({ prefer: { operation: "click", click_target: "ref=1" } });
  const r = await runJevAutonomousLoop(page, "点 Next", { apiKey: "stub", metrics: {}, maxSteps: 10, onStep: () => {} });
  check("无进展 3 次后停止", r.success === false && r.reason === "no_progress", JSON.stringify({ success: r.success, reason: r.reason, steps: r.steps }));
  check("停止前恰好执行 3 次动作", page.calls.cdp === 6, `cdp=${page.calls.cdp}`); // 每次点击 2 个 CDP 事件
}

// ── 5) 不合格响应重试上限 ───────────────────────────────────────────────────
console.log("\n[5] 不合格响应重试上限");
{
  const page = makePage();
  stubJev({
    prefer: { operation: "click", click_target: "ref=1" },
    corrupt: (answers) => { answers.operation.probabilities.click = 0.4; },
  });
  const r = await runJevAutonomousLoop(page, "点 Next", { apiKey: "stub", metrics: {}, maxSteps: 10, onStep: () => {} });
  check("连续不合格 → reason=invalid_response", r.reason === "invalid_response", JSON.stringify(r.reason));
  check("始终没有执行动作", page.calls.click === 0 && page.calls.cdp === 0);
}

// ── 6) 危险动作词表（我们自己的词表，中文 + 英文） ─────────────────────────
console.log("\n[6] assessDanger 词表（中文/英文/安全词/选项文本）");
{
  const hit = (name, opt) => assessDanger({ name }, opt);
  check("中文「删除账号」→ deletion", hit("删除账号")?.kind === "deletion", JSON.stringify(hit("删除账号")));
  check("中文「立即支付」→ payment", hit("立即支付")?.kind === "payment", JSON.stringify(hit("立即支付")));
  check("英文「Delete account」→ deletion", hit("Delete account")?.kind === "deletion", JSON.stringify(hit("Delete account")));
  check("英文「Checkout」→ payment", hit("Checkout")?.kind === "payment", JSON.stringify(hit("Checkout")));
  check("下拉选项文本也参与判定", hit("操作", "永久删除")?.kind === "deletion", JSON.stringify(hit("操作", "永久删除")));
  check("安全词「Next」不命中", hit("Next") === null, JSON.stringify(hit("Next")));
  check("安全词「new」/「comments」不命中", hit("new") === null && hit("comments") === null, "");
  check("「PayPal」不命中（英文按单词边界）", hit("PayPal") === null, JSON.stringify(hit("PayPal")));
  check("「remover」不命中（英文按单词边界）", hit("remover") === null, JSON.stringify(hit("remover")));
}

// ── 7) 危险动作前置拦截：命中即不执行 ────────────────────────────────────────
console.log("\n[7] 危险动作前置拦截");
{
  const dangerObs = {
    url: "https://example.com/",
    title: "Example",
    text: "",
    targets: [
      { ref: "ref=1", role: "button", kind: "clickable", name: "删除账号", guard: [1, "button", "删除账号", false, null, null] },
    ],
  };
  const dangerPage = () =>
    makePage({
      async evaluate(fn, arg) {
        const src = String(fn);
        if (src.includes("observeDom")) return dangerObs;
        if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: dangerObs.url, disabled: false, ariaDisabled: null, href: null };
        if (src.includes("readyState")) return [dangerObs.url, "complete"]; // settle 立刻返回
        if (src.includes("location.href")) return dangerObs.url;
        return null;
      },
    });

  const page = dangerPage();
  stubJev({ prefer: { operation: "click", click_target: "ref=1" } });
  const r = await runJevStep(page, "删除账号", { apiKey: "stub", metrics: {} });
  check("命中 → guardRejected=dangerous_action", r.guardRejected === "dangerous_action", JSON.stringify(r.guardRejected));
  check("命中 → 没有派发任何鼠标事件", page.calls.cdp === 0, JSON.stringify(page.calls));
  check("命中 → 暴露命中的词与类别", r.dangerousMatch === "删除" && r.dangerousKind === "deletion", JSON.stringify({ w: r.dangerousMatch, k: r.dangerousKind }));

  const loopPage = dangerPage();
  stubJev({ prefer: { operation: "click", click_target: "ref=1" } });
  const loop = await runJevAutonomousLoop(loopPage, "删除账号", { apiKey: "stub", metrics: {}, maxSteps: 6, onStep: () => {} });
  check("循环 → reason=guard_rejected", loop.reason === "guard_rejected", JSON.stringify(loop.reason));
  check("循环 → 第 1 步就停（不重试危险动作）", loop.steps === 1, `steps=${loop.steps}`);
  check("循环 → 始终没有派发", loopPage.calls.cdp === 0, `cdp=${loopPage.calls.cdp}`);

  // 整体关闭开关：dangerGuard=false 时照常执行
  const offPage = dangerPage();
  stubJev({ prefer: { operation: "click", click_target: "ref=1" } });
  const off = await runJevStep(offPage, "删除账号", { apiKey: "stub", metrics: {}, dangerGuard: false });
  check("dangerGuard=false 时不拦截（照常派发 2 个 CDP 事件）", !off.guardRejected && offPage.calls.cdp === 2, JSON.stringify({ guardRejected: off.guardRejected, cdp: offPage.calls.cdp }));
}

globalThis.fetch = realFetch;
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
