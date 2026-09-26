// P2-7 验收（真实站点，需网络 + Jev 凭证）：原生下拉「改选 + 确认」连跑 6 次。
//
// 为什么用 DuckDuckGo 设置页而不是维基：维基的语言选择器已经不是一个可用的原生 <select>——
// www.wikipedia.org 上那个 77 项的 #searchLanguage 现在是 opacity:0（被自定义语言列表 UI 取代），
// 引擎按可见性规则跳过它（见 [2] 的实测记录）。DDG 设置页仍有可见的原生 <select>（语言，80 项，
// 含 Dansk），是当前能跑同一类「原生下拉改选」任务的真站点。
//
// 需要网络 + Jev 凭证；缺一 SKIP（打印原因、不伪装通过）。6 次原始结果落 bench/raw/。
// 用法: sed "s|__REPO__|$PWD|g" bench/test-native-select.mjs | ego-browser nodejs
const { writeFile, mkdir } = await import("node:fs/promises");
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});
const { runJevAutonomousLoop, loadApiKey } = await import(JE);

const raw = { scenario: "native-select-reask", runs: [], wiki: null, skipped: null };
let skipped = loadApiKey() ? null : "未找到 Jev 凭证";
if (skipped) console.log(`SKIP: ${skipped}`);

/** 页面内：语言下拉里 Dansk 选项的值 */
const danskValueIn = () => {
  const sel = [...document.querySelectorAll("select")].find((el) => [...el.options].some((o) => /dansk/i.test(o.textContent)));
  return sel ? [...sel.options].find((o) => /dansk/i.test(o.textContent)).value : null;
};
/** 页面内：语言下拉当前选中值 */
const langValueIn = () => {
  const sel = [...document.querySelectorAll("select")].find((el) => [...el.options].some((o) => /dansk/i.test(o.textContent)));
  return sel ? sel.value : null;
};

const space = await taskSpace(`ego-nselect-${Date.now()}`);
const page = space.page("p1");
try {
  if (!skipped) {
    // ── [1] DDG 设置页语言下拉改选为 Dansk，连跑 6 次 ──
    for (let i = 1; i <= 6; i++) {
      const rec = { run: i };
      try {
        await page.goto("https://duckduckgo.com/settings", { waitUntil: "domcontentloaded", timeout: 40000 });
        await page.waitForTimeout(2200);
        const danskValue = await page.evaluate(danskValueIn);
        if (!danskValue) { rec.error = "页面里找不到 Dansk 选项"; raw.runs.push(rec); continue; }
        // DDG 会把语言设置持久化：每次先重置成非 Dansk，确保这一步必须真的改选
        const reset = await page.evaluate(() => {
          const sel = [...document.querySelectorAll("select")].find((el) => [...el.options].some((o) => /dansk/i.test(o.textContent)));
          if (!sel) return null;
          const other = [...sel.options].find((o) => !/dansk/i.test(o.textContent));
          sel.value = other.value;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return sel.value;
        });
        rec.resetTo = reset;
        if (reset === danskValue) { rec.error = "重置失败（仍是 Dansk）"; raw.runs.push(rec); continue; }
        const t0 = Date.now();
        const r = await runJevAutonomousLoop(page, "把语言（Language）下拉框改选为 Dansk (Danmark)", {
          apiKey: loadApiKey(), maxSteps: 6, onStep: () => {},
          check: async (p) => (await p.evaluate(langValueIn)) === danskValue,
        });
        rec.success = r.success;
        rec.reason = r.reason;
        rec.steps = r.steps;
        rec.elapsedMs = Date.now() - t0;
        rec.finalValue = await page.evaluate(langValueIn);
        rec.expected = danskValue;
        rec.serverModels = r.serverModels;
        rec.phases = r.phases;
        rec.history = (r.history || []).map((h) => ({ action: h.action, target: h.target, option: h.option, optionStale: h.optionStale, guardRejected: h.guardRejected, error: h.error }));
        console.log(`run${i}: success=${r.success} reason=${r.reason} steps=${r.steps} final=${rec.finalValue} (期望 ${danskValue}) ${rec.elapsedMs}ms`);
      } catch (e) {
        rec.error = String(e).slice(0, 200);
        console.log(`run${i}: ERROR ${rec.error}`);
      }
      raw.runs.push(rec);
    }

    // ── [2] 记录：维基语言选择器现在不可用（旧 2/3 基线的元素已变） ──
    try {
      await page.goto("https://www.wikipedia.org/", { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(2000);
      raw.wiki = await page.evaluate(() => {
        const el = document.getElementById("searchLanguage");
        if (!el) return { found: false };
        const cs = getComputedStyle(el);
        return {
          found: true, options: el.options.length, opacity: cs.opacity, display: cs.display,
          checkVisibility: el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
        };
      });
      console.log(`[2] 维基 #searchLanguage: ${JSON.stringify(raw.wiki)}`);
    } catch (e) {
      raw.wiki = { error: String(e).slice(0, 200) };
    }
  }
} catch (e) {
  raw.error = String(e).slice(0, 300);
} finally {
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

if (skipped) {
  console.log(`\n结果: SKIP（${skipped}）— 未执行，不计通过`);
} else {
  const ok = raw.runs.filter((r) => r.success).length;
  const tried = raw.runs.filter((r) => !r.error).length;
  console.log(`\nDDG 语言下拉 6 次: 成功 ${ok}/${tried}${raw.runs.some((r) => r.error) ? `（${raw.runs.filter((r) => r.error).length} 次执行异常）` : ""}`);
  console.log("失败 reason 分布: " + JSON.stringify(raw.runs.filter((r) => !r.success).map((r) => r.reason || r.error)));
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
raw.skipped = skipped;
await writeFile(`${BENCH}/raw/test-native-select-${stamp}.json`, JSON.stringify(raw, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-native-select-${stamp}.json`);
process.exitCode = 0; // 这是「测量」脚本：成功率先据实记录，不因未达阈值而假失败
