// bench/test-decider-backend.mjs — 决策后端（decider）抽象层的离线测试。
//
// 纯 node、stub fetch、不联网、不需凭证、不需浏览器。退出码 0/1。
// 覆盖：默认仍是 System One（请求体形状不变）、openai-compatible 后端的请求与提示（候选完整、
// 顺序稳定）、本地模型解析失败一律 invalid_response 且不派发、能力差异（无校准置信度 → 跳过
// 置信度阈值升级）、执行层护栏仍生效（陈旧 / guard / 危险动作）、注入 ask 优先于任何配置。
//
// 用法: node bench/test-decider-backend.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// 默认 decider.json 指向一个不存在的路径：保证「未配置」分支不受本机已有配置影响。
// 必须在动态 import 引擎之前设好（模块加载时读取）。
const TMP = mkdtempSync(join(tmpdir(), "ego-jev-decider-"));
process.env.EGO_JEV_DECIDER_FILE = join(TMP, "nonexistent-decider.json");

const JE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ego-jev.mjs");
const {
  runJevStep, runJevAutonomousLoop, buildQuestions, renderQuestionsForText,
  parseDeciderAnswers, resolveDecider, loadDeciderConfig, resolveDeciderApiKey,
  validateAnswer, confidenceGate,
} = await import(JE);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const realFetch = globalThis.fetch;

// ── 公共 stub：观测 + page（对齐 test-guardrails 的手法）──────────────────────
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
  return {
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
};

/** 从请求体里的真实 criteria 生成合法 System One 回答（概率和=1、argmax=choice） */
const systemOneAnswers = (questions, prefer = {}) => {
  const answers = {};
  for (const [head, q] of Object.entries(questions)) {
    const keys = Object.keys(q.criteria);
    const want = prefer[head];
    const choice = want && keys.includes(want) ? want : keys.find((k) => k !== "none") ?? keys[0];
    const rest = keys.filter((k) => k !== choice);
    const probabilities = { [choice]: 0.9 };
    for (const k of rest) probabilities[k] = 0.1 / rest.length;
    answers[head] = { choice, confidence: 0.9, probabilities };
  }
  return answers;
};

/** 从渲染后的提示里解析问题头与候选（用来断言提示完整且顺序稳定） */
const parsePrompt = (text) => {
  const heads = {};
  let cur = null;
  for (const line of text.split("\n")) {
    const h = line.match(/^## (.+)$/);
    if (h) { cur = h[1]; heads[cur] = []; continue; }
    const c = cur && line.match(/^- (.+?): /);
    if (c) heads[cur].push(c[1]);
  }
  return heads;
};

/**
 * 假本地 OpenAI 兼容端点：记录 URL/body/提示，缺省时从提示里的候选生成合法 JSON 回答；
 * content 显式给出时原样返回（用来制造非 JSON / 缺字段 / 非法候选）。
 */
const stubLocal = ({ content, prefer = {}, capture = {} } = {}) => {
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    capture.prompt = capture.body.messages?.[1]?.content ?? "";
    let text = content;
    if (text === undefined) {
      const heads = parsePrompt(capture.prompt);
      const out = {};
      for (const [head, ids] of Object.entries(heads)) {
        out[head] = prefer[head] && ids.includes(prefer[head]) ? prefer[head] : ids.find((i) => i !== "none") ?? ids[0];
      }
      text = JSON.stringify(out);
    }
    return {
      ok: true,
      async json() {
        return { model: capture.body.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 1, completion_tokens: 2 } };
      },
    };
  };
};

// ── [1] 默认未配置 → 仍走 System One，请求体形状不变 ─────────────────────────
console.log("\n[1] 默认未配置 → System One（请求体形状不变）");
{
  const page = makePage();
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = url;
    seen.body = JSON.parse(init.body);
    return { ok: true, async json() { return { model: "jev-stub", answers: systemOneAnswers(seen.body.questions, { operation: "click", click_target: "ref=1" }), usage: { input_tokens: 3, output_tokens: 4 } }; } };
  };
  const r = await runJevStep(page, "点 Next", { apiKey: "stub", metrics: {}, textModel: null });
  check("未配置 → POST 到默认 System-One /systemone", seen.url === "https://api.typesafe.ai/v1/systemone", seen.url);
  check("请求体形状与从前一致（model/state/questions）", seen.body.model === "jev-latest" && typeof seen.body.state === "string" && Boolean(seen.body.questions.operation.criteria), JSON.stringify({ model: seen.body.model, hasState: typeof seen.body.state === "string" }));
  check("默认路径照常执行点击（2 个 CDP 事件）", page.calls.cdp === 2, String(page.calls.cdp));
  check("deciderKind=systemone、置信度 gate 启用", r.deciderKind === "systemone" && r.confidenceGateEnabled === true && r.deciderConfidence === true, JSON.stringify({ k: r.deciderKind, g: r.confidenceGateEnabled, c: r.deciderConfidence }));
  check("service model 取自响应", r.serverModel === "jev-stub", String(r.serverModel));
}

// ── [2] openai-compatible：请求发到 baseUrl，提示完整且顺序稳定 ──────────────
console.log("\n[2] openai-compatible → 配置的 baseUrl + 确定性提示");
{
  const page = makePage();
  const cap = {};
  stubLocal({ prefer: { operation: "click", click_target: "ref=1" }, capture: cap });
  const cfg = { kind: "openai-compatible", baseUrl: "http://local.test/v1", model: "local-model" };
  const r = await runJevStep(page, "点 Next", { deciderConfig: cfg, textModel: null });
  check("请求发到配置的 baseUrl", cap.url === "http://local.test/v1/chat/completions", cap.url);
  check("请求体带配置的 model 与 JSON 模式", cap.body.model === "local-model" && cap.body.response_format?.type === "json_object", JSON.stringify({ m: cap.body.model, rf: cap.body.response_format }));

  const expected = buildQuestions(observation.targets, { texts: [], hasTextSource: false });
  const got = parsePrompt(cap.prompt);
  check("提示包含全部问题头，且顺序与 questions 一致", JSON.stringify(Object.keys(got)) === JSON.stringify(Object.keys(expected)), JSON.stringify(Object.keys(got)));
  const allCandidates = Object.entries(expected).every(([head, q]) => JSON.stringify(got[head]) === JSON.stringify(Object.keys(q.criteria)));
  check("提示包含每个问题的全部候选，且顺序一致", allCandidates, JSON.stringify(got));
  check("提示渲染确定（同输入两次逐字节相同）", renderQuestionsForText("S", expected) === renderQuestionsForText("S", expected));

  check("本地后端照常执行点击", page.calls.cdp === 2, String(page.calls.cdp));
  check("deciderKind/置信度能力正确暴露", r.deciderKind === "openai-compatible" && r.deciderConfidence === false && r.confidenceGateEnabled === false, JSON.stringify({ k: r.deciderKind, c: r.deciderConfidence, g: r.confidenceGateEnabled }));
  check("receipt 记录本地 model 与 endpoint", r.serverModel === "local-model" && r.serverEndpoint === "http://local.test/v1", JSON.stringify({ m: r.serverModel, e: r.serverEndpoint }));
  check("本地后端不伪造概率数字", r.operationProbabilities === undefined && r.operationConfidence === undefined, JSON.stringify({ p: r.operationProbabilities, c: r.operationConfidence }));
}

// ── [3] 本地后端解析失败/非法候选 → invalid_response，且不派发动作 ────────────
console.log("\n[3] 解析失败 → invalid_response，不猜、不派发");
{
  const local = { kind: "openai-compatible", baseUrl: "http://local.test/v1", model: "local-model" };
  const cases = [
    ["非 JSON 文本", "I think we should click the Next link", "invalid_json"],
    ["缺问题头字段", JSON.stringify({ operation: "click" }), "missing_field"],
    ["选了不存在的候选", JSON.stringify({ operation: "teleport", click_target: "ref=1" }), "choice_not_offered"],
  ];
  for (const [label, content, want] of cases) {
    const page = makePage();
    stubLocal({ content });
    const r = await runJevStep(page, "点 Next", { deciderConfig: local, textModel: null });
    check(`${label} → invalidResponse=${want}`, r.invalidResponse === want, JSON.stringify(r.invalidResponse));
    check(`${label} → 没有派发任何动作`, page.calls.cdp === 0 && page.calls.click === 0, JSON.stringify(page.calls));
  }
  // 循环层：一连串不合格 → reason=invalid_response，全程不派发
  const page = makePage();
  stubLocal({ content: "not json at all" });
  const r = await runJevAutonomousLoop(page, "点 Next", { deciderConfig: local, textModel: null, maxSteps: 4, onStep: () => {} });
  check("循环：非 JSON → reason=invalid_response", r.reason === "invalid_response", JSON.stringify(r.reason));
  check("循环：始终没有派发动作", page.calls.cdp === 0, String(page.calls.cdp));
}

// ── [4] 能力差异：无校准置信度 → 跳过阈值升级；有置信度 → 阈值生效 ────────────
console.log("\n[4] 置信度能力差异（跳过 vs 生效）");
{
  check("confidence=false → gate 关闭、四个阈值被忽略", confidenceGate({ confidence: false }, { minOpConfidence: 0.99, minTargetConfidence: 0.99, doneThreshold: 0.99, stuckThreshold: 0.99 }).enabled === false);
  const enabled = confidenceGate({ confidence: true }, { minOpConfidence: 0.9, doneThreshold: 0.8 });
  check("confidence=true → gate 启用并记录阈值", enabled.enabled === true && enabled.minOpConfidence === 0.9 && enabled.doneThreshold === 0.8, JSON.stringify(enabled));

  // 本地后端：即便显式设了阈值也被跳过（模型照常执行）
  const page = makePage();
  stubLocal({ prefer: { operation: "click", click_target: "ref=1" } });
  const local = { kind: "openai-compatible", baseUrl: "http://local.test/v1", model: "local-model" };
  const r = await runJevStep(page, "点 Next", { deciderConfig: local, textModel: null, minOpConfidence: 0.99, minTargetConfidence: 0.99, doneThreshold: 0.99, stuckThreshold: 0.99 });
  check("本地后端：阈值升级被跳过（仍执行点击）", !r.invalidResponse && page.calls.cdp === 2 && r.confidenceGateEnabled === false, JSON.stringify({ invalid: r.invalidResponse, cdp: page.calls.cdp, gate: r.confidenceGateEnabled }));

  // 对照：有置信度的注入判定器上，minOpConfidence 会拒绝低置信度决策
  const lowConfPage = makePage();
  const lowConfAsk = (state, questions) => {
    const answers = systemOneAnswers(questions, { operation: "click", click_target: "ref=1" });
    answers.operation.confidence = 0.1; // 概率仍合法（argmax=click），只是置信度低
    return answers;
  };
  const low = await runJevStep(lowConfPage, "点 Next", { ask: lowConfAsk, textModel: null, minOpConfidence: 0.5 });
  check("有置信度后端：低置信度 → low_confidence 且不执行", low.invalidResponse === "low_confidence" && lowConfPage.calls.cdp === 0, JSON.stringify({ invalid: low.invalidResponse, cdp: lowConfPage.calls.cdp }));
}

// ── [5] 执行层护栏在本地后端上仍然生效（陈旧 / guard / 危险动作）─────────────
console.log("\n[5] 本地后端仍受执行层护栏保护");
{
  const local = { kind: "openai-compatible", baseUrl: "http://local.test/v1", model: "local-model" };
  // 陈旧：决策后结构指纹变了 → stale_guard
  const stalePage = makePage({
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("observeDom")) return observation;
      if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: observation.url, disabled: false, ariaDisabled: null, href: "/changed" };
      if (src.includes("location.href")) return observation.url;
      return null;
    },
  });
  stubLocal({ prefer: { operation: "click", click_target: "ref=1" } });
  const stale = await runJevStep(stalePage, "点 Next", { deciderConfig: local, textModel: null });
  check("陈旧（指纹变化）→ guardRejected=stale_guard、0 派发", stale.guardRejected === "stale_guard" && stalePage.calls.cdp === 0, JSON.stringify({ g: stale.guardRejected, cdp: stalePage.calls.cdp }));

  // guard：决策后节点消失 → node_gone
  const gonePage = makePage({
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("observeDom")) return observation;
      if (src.includes("locateForInput")) return { ok: false, reason: "node_gone" };
      if (src.includes("location.href")) return observation.url;
      return null;
    },
  });
  stubLocal({ prefer: { operation: "click", click_target: "ref=1" } });
  const gone = await runJevStep(gonePage, "点 Next", { deciderConfig: local, textModel: null });
  check("guard（节点消失）→ guardRejected=node_gone、0 派发", gone.guardRejected === "node_gone" && gonePage.calls.cdp === 0, JSON.stringify({ g: gone.guardRejected, cdp: gonePage.calls.cdp }));

  // 危险动作：前置拦截不派发
  const dangerObs = { url: "https://example.com/", title: "Example", text: "", targets: [{ ref: "ref=1", role: "button", kind: "clickable", name: "删除账号", guard: [1, "button", "删除账号", false, null, null] }] };
  const dangerPage = makePage({
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("observeDom")) return dangerObs;
      if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: dangerObs.url, disabled: false, ariaDisabled: null, href: null };
      if (src.includes("readyState")) return [dangerObs.url, "complete"];
      if (src.includes("location.href")) return dangerObs.url;
      return null;
    },
  });
  stubLocal({ prefer: { operation: "click", click_target: "ref=1" } });
  const danger = await runJevStep(dangerPage, "删除账号", { deciderConfig: local, textModel: null });
  check("危险动作 → guardRejected=dangerous_action、0 派发", danger.guardRejected === "dangerous_action" && dangerPage.calls.cdp === 0, JSON.stringify({ g: danger.guardRejected, cdp: dangerPage.calls.cdp }));
}

// ── [6] 注入的 options.ask 优先于任何配置（不发网络请求）──────────────────────
console.log("\n[6] 注入 ask 优先于配置后端");
{
  const page = makePage();
  let fetchCalled = 0;
  globalThis.fetch = async () => { fetchCalled += 1; throw new Error("注入 ask 时不该发请求"); };
  const ask = (state, questions) => systemOneAnswers(questions, { operation: "click", click_target: "ref=1" });
  const r = await runJevStep(page, "点 Next", {
    ask,
    deciderConfig: { kind: "openai-compatible", baseUrl: "http://local.test/v1", model: "local-model" },
    textModel: null,
  });
  check("注入 ask 时不发任何请求", fetchCalled === 0, String(fetchCalled));
  check("注入 ask 正常执行点击", page.calls.cdp === 2, String(page.calls.cdp));
  check("deciderKind=injected", r.deciderKind === "injected", String(r.deciderKind));
}

// ── [7] 配置读取 / 密钥解析 / 解析器单元 ─────────────────────────────────────
console.log("\n[7] 配置与解析单元");
{
  const cfgFile = join(TMP, "decider.json");
  writeFileSync(cfgFile, JSON.stringify({ kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }));
  check("loadDeciderConfig 读到文件", loadDeciderConfig({ file: cfgFile })?.kind === "openai-compatible");
  writeFileSync(cfgFile, JSON.stringify({ kind: "something-else", baseUrl: "http://x/v1", model: "m" }));
  check("未知 kind → null（回退默认，不炸）", loadDeciderConfig({ file: cfgFile }) === null);
  check("文件不存在 → null", loadDeciderConfig({ file: join(TMP, "nope.json") }) === null);

  const keyFile = join(TMP, "local.key");
  writeFileSync(keyFile, "local-secret\n");
  check("apiKey 优先", resolveDeciderApiKey({ apiKey: "k1", apiKeyFile: keyFile }) === "k1");
  check("apiKeyFile 读取首行", resolveDeciderApiKey({ apiKeyFile: keyFile }) === "local-secret");
  check("都没有 → undefined（本地端点常不校验）", resolveDeciderApiKey({}) === undefined);

  let threw = null;
  try { parseDeciderAnswers({ choices: [{ message: { content: "not json" } }] }, { operation: { criteria: { a: "A" } } }); } catch (e) { threw = e; }
  check("parseDeciderAnswers 非 JSON → 抛 invalid_response", threw?.invalidResponse === "invalid_json", JSON.stringify(threw?.invalidResponse));
  const ok = parseDeciderAnswers({ choices: [{ message: { content: JSON.stringify({ operation: "a" }) } }] }, { operation: { criteria: { a: "A", b: "B" } } });
  check("parseDeciderAnswers 合法 → { choice }（无概率）", ok.answers.operation.choice === "a" && ok.answers.operation.probabilities === undefined, JSON.stringify(ok.answers));

  check("validateAnswer：无置信度后端只要候选合法即通过", validateAnswer({ choice: "a" }, ["a", "b"], { confidence: false }) === null);
  check("validateAnswer：无置信度后端仍拒绝非法候选", validateAnswer({ choice: "z" }, ["a", "b"], { confidence: false }) === "choice_not_offered");
  check("validateAnswer：有置信度后端缺概率 → no_probabilities", validateAnswer({ choice: "a" }, ["a", "b"], { confidence: true }) === "no_probabilities");

  check("resolveDecider 默认 = systemone", resolveDecider({}).kind === "systemone");
}

globalThis.fetch = realFetch;
rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
