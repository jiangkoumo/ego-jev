// P0-2 验收：emoji 截断必须落在码点边界，且请求体里不得出现孤立代理。
//
// 为什么要这个测试：元素名/当前值/下拉选项/页面可见文本原本用 UTF-16 slice(0, N) 截断，
// emoji（代理对）被从中间切开 → 半个代理经 JSON.stringify 变成 "\uD83D" → Jev 返回
// 400 invalid Unicode text → 整轮 action_failed。实测 X 时间线 235 个元素里约 5 个命中。
//
// 覆盖三层截断点：
//   [1] 纯单元：parseActionTargets（ego 快照路径）
//   [2] 真实页面 + 假 fetch：observeDom（自建 DOM 元素表路径，X 走的就是这条）
//   [3] 真实页面 + 假 fetch：快照路径 + enrichTargets（下拉选项 / 实时值 / 标签）
// 每个用例都把 emoji 摆在截断边界上（59 个 ASCII + emoji，slice(0,60) 恰好切进代理对）。
//
// 用法: ego-browser nodejs < bench/test-emoji-clip.mjs
const { writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/test-emoji-clip.mjs | ego-browser nodejs
// ② 直接 `< bench/test-emoji-clip.mjs`：走已安装技能（$HOME/.agents/skills/ego-decision-layer）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-decision-layer`);
});
const { parseActionTargets, buildActionMenu, runJevStep } = await import(JE);

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EMOJI = "😀"; // U+1F600：UTF-16 里是两个码元，正是 slice 会切坏的那种字符
/** 断言字符串里没有孤立代理，且 UTF-8 往返无损（Jev 400 的判据） */
const utf8Lossless = (s) => Buffer.from(s, "utf8").toString("utf8") === s;

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

// ── [1] 纯单元：ego 快照文本里的 name / value ────────────────────────────────
console.log("\n[1] parseActionTargets（快照路径）按码点截断");
{
  // 59 个 A + emoji：UTF-16 slice(0,60) 会取到 59 个 A + 半个 emoji
  const name = "A".repeat(59) + EMOJI + "tail";
  const value = "V".repeat(59) + EMOJI + "tail";
  const snapshot = `  button "${name}" [ref=1, loc=css:button, url=https://example.com/x]\n    text "${value}"\n`;
  const targets = parseActionTargets(snapshot, { limit: 10 });
  const t = targets[0] || {};
  check("快照路径解析出元素", Boolean(t.ref), JSON.stringify(targets));
  check("name 里没有孤立代理", !LONE.test(t.name || ""), JSON.stringify(t.name?.slice(-4)));
  check("name 恰好 60 个码点", Array.from(t.name || "").length === 60, `len=${Array.from(t.name || "").length}`);
  check("name 以完整 emoji 收尾（没被切成半个）", (t.name || "").endsWith(EMOJI), JSON.stringify(t.name?.slice(-2)));
  check("value 里没有孤立代理", !LONE.test(t.value || ""), JSON.stringify(t.value?.slice(-4)));
  check("value 以完整 emoji 收尾", (t.value || "").endsWith(EMOJI), JSON.stringify(t.value?.slice(-2)));
  // 对照：旧实现（UTF-16 slice）在同一输入上确实会产生孤立代理，证明这个用例真的卡在边界上
  check(
    "对照：旧 slice(0,60) 在同一输入上确实切出孤立代理",
    LONE.test(name.slice(0, 60)),
    JSON.stringify(name.slice(0, 60).slice(-2))
  );
  check("元素表渲染文本无孤立代理", !LONE.test(buildActionMenu(targets)), "");
}

// ── 真实页面 + 假 fetch ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let lastBody = null;
/** 假 Jev：从请求体里真实的 criteria 键集合生成合法回答（默认 wait，不产生副作用） */
const stubJev = (prefer = { operation: "wait" }) => {
  globalThis.fetch = async (_url, init) => {
    lastBody = init.body;
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

const FIXTURE = `
  <p id=big>${"B".repeat(2499)}${EMOJI}${"C".repeat(50)}</p>
  <button id=btn aria-label="${"A".repeat(59)}${EMOJI}tail">go</button>
  <label for=sel>Language</label>
  <select id=sel>
    <option value=en>English</option>
    <option value=da>${"D".repeat(39)}${EMOJI}tail</option>
  </select>
  <input id=inp value="${"V".repeat(59)}${EMOJI}tail">
  <input type=checkbox id=cb><label for=cb>${"L".repeat(39)}${EMOJI}tail</label>
`;

const space = await taskSpace(`ego-emoji-${Date.now()}`);
const page = space.page("p1");
try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => {
    document.body.innerHTML = html;
  }, FIXTURE);

  // ── [2] observeDom 路径（默认；X 时间线走的就是这条） ──
  console.log("\n[2] observeDom（自建 DOM 元素表）路径：请求体不得含孤立代理");
  {
    stubJev();
    const r = await runJevStep(page, "只看一眼", { apiKey: "stub", metrics: {}, maxText: 2500 });
    const state = JSON.parse(lastBody).state;
    check("走了 dom 观测路径", r.observeMode === "dom", String(r.observeMode));
    check("请求体 state 无孤立代理", !LONE.test(state), "");
    check("请求体 state UTF-8 往返无损", utf8Lossless(state), "");
    check("完整请求体（含 questions）无孤立代理", !LONE.test(lastBody), "");
    check("完整请求体 UTF-8 往返无损", utf8Lossless(lastBody), "");
    check("按钮名以完整 emoji 收尾", state.includes("A".repeat(59) + EMOJI), "边界被切开");
    check("下拉选项以完整 emoji 收尾", state.includes("D".repeat(39) + EMOJI), "边界被切开");
    check("输入框当前值以完整 emoji 收尾", state.includes("V".repeat(59) + EMOJI), "边界被切开");
    check("页面可见文本以完整 emoji 收尾", state.includes("B".repeat(2499) + EMOJI), "边界被切开");
    check("可见文本截断到 2500 码点", !state.includes("C".repeat(5)), "超出了 maxText");
  }

  // ── [3] 快照路径 + enrichTargets ──
  console.log("\n[3] 快照路径 + enrichTargets：请求体不得含孤立代理");
  {
    stubJev();
    const r = await runJevStep(page, "只看一眼", { apiKey: "stub", metrics: {}, observe: "snapshot" });
    const state = JSON.parse(lastBody).state;
    check("走了 snapshot 观测路径", r.observeMode === "snapshot", String(r.observeMode));
    check("请求体 state 无孤立代理", !LONE.test(state), "");
    check("完整请求体 UTF-8 往返无损", utf8Lossless(lastBody), "");
  }
} catch (e) {
  check("emoji 集成用例执行完成", false, String(e).slice(0, 300));
} finally {
  globalThis.fetch = realFetch;
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-emoji-clip-${stamp}.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-emoji-clip-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
