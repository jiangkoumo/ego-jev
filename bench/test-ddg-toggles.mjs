// P0-1 真实站点复现：DuckDuckGo 设置页那条「18 个复选框，元素表里 0 个」的旧限制。
//
// 旧限制的成因是 ego 的辅助树快照（a11y）会把这些 1×1 的自定义样式 checkbox 剪掉：
// snapshot 路径实测 0 个。默认的自建 DOM 元素表路径本来就能拿到原生 input[type=checkbox]，
// 只是元素表只覆盖当前视口——682px 高的窗口里只有 5 个在视口内。
// 本脚本用 CDP 把视口拉高，让 18 个开关同时落在视口内，验证元素表确实全部覆盖；
// 同时对照 snapshot 路径（仍为 0），把旧警告替换成实测事实。
//
// 需要网络。用法（测当前工作树）:
//   sed "s|__REPO__|$PWD|g" bench/test-ddg-toggles.mjs | ego-browser nodejs
// 或直接 `< bench/test-ddg-toggles.mjs`（走 ~/.agents/skills/ego-decision-layer 软链）
const { writeFile, mkdir } = await import("node:fs/promises");
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});
const { runJevStep } = await import(JE);

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

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

const countByRole = (state) => {
  const table = (state.split("当前视口内可交互元素")[1] || "");
  const lines = table.split("\n").filter((l) => l.includes("ref="));
  const roles = {};
  for (const l of lines) {
    const m = l.match(/ref=\d+ \| ([a-z-]+)/);
    if (m) roles[m[1]] = (roles[m[1]] || 0) + 1;
  }
  return { lines: lines.length, roles };
};

const space = await taskSpace(`ego-ddg-${Date.now()}`);
const page = space.page("p1");
const measurements = {};
try {
  await page.goto("https://duckduckgo.com/settings", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  // 视口内 checkbox 的 DOM 真值（作为元素表数字的对照）
  const domCheckboxes = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox]')];
    const inView = boxes.filter((el) => {
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    });
    return { total: boxes.length, inViewport: inView.length, innerH: innerHeight };
  });

  // ── [1] 默认视口：元素表覆盖视口内可勾选控件 ──
  console.log("\n[1] 默认视口（682px）");
  stubJev();
  const stepDefault = await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
  const domDefault = countByRole(JSON.parse(lastBody).state);
  console.log("  " + JSON.stringify({ domCheckboxes, table: domDefault }));
  check("默认视口走 dom 观测路径", stepDefault.observeMode === "dom", String(stepDefault.observeMode));
  check(
    `元素表 checkbox 数 = 视口内 DOM 数（${domDefault.roles.checkbox ?? 0}/${domCheckboxes.inViewport}）`,
    (domDefault.roles.checkbox ?? 0) === domCheckboxes.inViewport,
    JSON.stringify(domDefault.roles)
  );
  measurements.defaultViewport = { innerH: domCheckboxes.innerH, dom: domCheckboxes, table: domDefault };

  // ── [2] 拉高视口：18 个开关同时进元素表 ──
  console.log("\n[2] 拉高视口（2400px）：18 个开关应同时进元素表");
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1200, height: 2400, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(400);
  stubJev();
  const stepTall = await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0, observe: "dom" });
  const domTall = countByRole(JSON.parse(lastBody).state);
  console.log("  " + JSON.stringify(domTall));
  check("dom 路径：元素表里 ≥18 个 checkbox", (domTall.roles.checkbox ?? 0) >= 18, JSON.stringify(domTall.roles));
  check("dom 路径：checkbox 数 = DOM 总数 18", (domTall.roles.checkbox ?? 0) === domCheckboxes.total, JSON.stringify(domTall.roles));
  measurements.tallViewport = { dom: domTall };

  // ── [3] 对照：旧 snapshot 路径仍是 0 ──
  console.log("\n[3] 对照：snapshot（a11y）路径");
  stubJev();
  const stepSnap = await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0, observe: "snapshot" });
  const snap = countByRole(JSON.parse(lastBody).state);
  console.log("  " + JSON.stringify(snap));
  check("snapshot 路径确实走了 snapshot", stepSnap.observeMode === "snapshot", String(stepSnap.observeMode));
  check("snapshot 路径 checkbox 数 = 0（旧限制仍在）", (snap.roles.checkbox ?? 0) === 0, JSON.stringify(snap.roles));
  measurements.snapshotPath = snap;

  try { await page.cdp("Emulation.clearDeviceMetricsOverride", {}); } catch { /* 清理失败不影响结论 */ }
} catch (e) {
  check("DDG 复现用例执行完成", false, String(e).slice(0, 400));
} finally {
  globalThis.fetch = realFetch;
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-ddg-toggles-${stamp}.json`, JSON.stringify({ pass, fail, results, measurements }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-ddg-toggles-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
