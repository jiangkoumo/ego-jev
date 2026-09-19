// 1) 原始 Jev 响应结构（决定 validateChoice 能否严格校验）
// 2) fill / selectOption / insertText 的开销
// 用法: ego-browser nodejs < bench/probe-raw.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const JE = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/scripts/ego-jev.mjs";
const { parseActionTargets, enrichTargets, buildActionMenu, buildQuestions } = await import(JE);
const BENCH = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench";
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();

const out = {};
// —— 原始响应 ——
{
  const task = await taskSpace("ego-raw-" + Date.now());
  const page = task.page("p1");
  await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(900);
  const snap = await page.snapshot();
  const targets = await enrichTargets(page, parseActionTargets(snap, { limit: 40 }), {});
  const questions = buildQuestions(targets, { hasTextSource: false });
  const state = ["用户最终目标: 先打开 new 页面，再打开 comments 页面", "当前页面: HN", buildActionMenu(targets)].join("\n");
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  const data = await res.json();
  out.rawResponse = data;
  out.questionHeads = Object.fromEntries(Object.entries(questions).map(([k, v]) => [k, Object.keys(v.criteria).length]));
  console.log("=== 原始响应 keys:", Object.keys(data));
  console.log(JSON.stringify(data, null, 2).slice(0, 2200));
  await task.finish({ keep: [] });
}
// —— 输入开销 ——
out.inputs = [];
{
  const task = await taskSpace("ego-input-" + Date.now());
  const page = task.page("p1");
  await page.goto("https://en.wikipedia.org/wiki/Main_Page", { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(1200);
  const sel = await page.evaluate(() => {
    const s = document.querySelector("#searchInput, input[name=search], input[type=search]");
    const r = s.getBoundingClientRect();
    const lang = document.querySelector("select#searchLanguage, select[name=language], #p-lang select, select");
    return { search: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, hasSelect: !!lang };
  });
  // fill by selector
  let t0 = Date.now();
  await page.fill("#searchInput", "Jev");
  const fillMs = Date.now() - t0;
  // raw cdp: click, select-all, insertText
  t0 = Date.now();
  const p = { x: Math.round(sel.search.x), y: Math.round(sel.search.y), button: "left", clickCount: 1 };
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p });
  const clickMs = Date.now() - t0;
  t0 = Date.now();
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
  const selAllMs = Date.now() - t0;
  t0 = Date.now();
  await page.cdp("Input.insertText", { text: "Jev" });
  const insertMs = Date.now() - t0;
  const val = await page.evaluate(() => document.querySelector("#searchInput").value);
  out.inputs.push({ fillMs, clickMs, selAllMs, insertMs, value: val, hasSelect: sel.hasSelect });
  console.log(`=== 输入: page.fill ${fillMs}ms | cdp click ${clickMs}ms | selectAll ${selAllMs}ms | insertText ${insertMs}ms | 值="${val}"`);
  await task.finish({ keep: [] });
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/probe-raw-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/probe-raw-${stamp}.json`);
