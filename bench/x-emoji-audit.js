// P0-2 验收（线上侧，X 只读）：emoji 密集页面上，交给 Jev 的请求体必须不含孤立代理。
// 手法：在真实 X 时间线上跑 runJevStep，但把 fetch 换成 stub（回答固定为 wait），
// 因此既不消耗 Jev 调用、也不执行任何动作（X 严格只读）。只检查请求体本身：
//   * state 里确实出现了 emoji（证明这条路径真的会碰到代理对）
//   * state / 完整请求体里孤立代理计数 = 0
//   * UTF-8 往返无损（Jev 400 invalid Unicode text 的直接判据）
// 用法: ego-browser nodejs < bench/x-emoji-audit.js      （迭代 __ITERS__，默认 3）
const { writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/x-emoji-audit.js | ego-browser nodejs
// ② 直接 `< bench/x-emoji-audit.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { runJevStep } = await import(JE);
const ITERS = Number(globalThis.__ITERS__ || 3);

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;
const utf8Lossless = (s) => Buffer.from(s, "utf8").toString("utf8") === s;

const space = await taskSpace(`ego-xemoji-${Date.now()}`);
const page = space.page("p1");
const out = { probedAt: new Date().toISOString(), iterations: [] };
const realFetch = globalThis.fetch;

for (let i = 1; i <= ITERS; i++) {
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
    if (i > 1) {
      await page.evaluate((n) => window.scrollBy({ top: Math.round(innerHeight * n), behavior: "instant" }), i - 1);
      await page.waitForTimeout(1200);
    }
    let captured = null;
    globalThis.fetch = async (_url, init) => {
      captured = init.body;
      // 回答固定为 wait：本审计不执行任何动作（X 只读）
      const body = JSON.parse(init.body);
      const answers = {};
      for (const [head, q] of Object.entries(body.questions)) {
        const keys = Object.keys(q.criteria);
        const choice = head === "operation" && keys.includes("wait") ? "wait" : keys.find((k) => k !== "none") ?? keys[0];
        const probabilities = {};
        probabilities[choice] = 0.9;
        for (const k of keys) if (k !== choice) probabilities[k] = 0.1 / (keys.length - 1);
        answers[head] = { choice, confidence: 0.9, probabilities };
      }
      return { ok: true, async json() { return { model: "stub", answers, usage: {} }; } };
    };
    const r = await runJevStep(page, "只看一眼，不执行任何动作", { apiKey: "stub", metrics: {} });
    globalThis.fetch = realFetch;
    const state = JSON.parse(captured).state;
    const tableLines = state.split("\n").filter((l) => /^ref=/.test(l.trim()));
    const rec = {
      i, action: r.action, observeMode: r.observeMode,
      tableEntries: tableLines.length,
      tableEntriesWithEmoji: tableLines.filter((l) => EMOJI.test(l)).length,
      emojiInState: (state.match(EMOJI) || []).length,
      loneInState: (state.match(LONE) || []).length,
      loneInBody: (captured.match(LONE) || []).length,
      utf8LosslessState: utf8Lossless(state),
      utf8LosslessBody: utf8Lossless(captured),
      stateChars: state.length,
    };
    out.iterations.push(rec);
    console.log(
      `[${i}] ${r.observeMode} 元素表 ${rec.tableEntries} 项（含 emoji ${rec.tableEntriesWithEmoji} 项），state 内 emoji ${rec.emojiInState} 个` +
        ` | 孤立代理 state=${rec.loneInState} body=${rec.loneInBody} | UTF-8 往返 state=${rec.utf8LosslessState} body=${rec.utf8LosslessBody} | state ${rec.stateChars} 字符`
    );
  } catch (e) {
    globalThis.fetch = realFetch;
    out.iterations.push({ i, error: String(e).slice(0, 200) });
    console.log(`[${i}] ERROR ${String(e).slice(0, 200)}`);
  }
}

const ok = out.iterations.filter((r) => !r.error);
out.summary = {
  probes: ok.length,
  probesWithEmojiInState: ok.filter((r) => r.emojiInState > 0).length,
  loneSurrogatesTotal: ok.reduce((a, r) => a + r.loneInState + r.loneInBody, 0),
  allUtf8Lossless: ok.every((r) => r.utf8LosslessState && r.utf8LosslessBody),
};
console.log(`\n结论: ${JSON.stringify(out.summary)}`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/x-emoji-audit-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/x-emoji-audit-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
