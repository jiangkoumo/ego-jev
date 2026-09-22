// 「有界滚动揭示」(maxReveals) 在真实滚动密集站点上的 A 栈验证。
// 每轮先在只读测量阶段确定「目标在首屏之外」的具体锚点（帖子 id / 搜索结果标题），
// 再用自然语言目标驱动引擎，判据锚定到该 id / 路径（确定性，不依赖“走了哪条路”）。
// 记录：成功率、耗时、步数、Jev 调用、**揭示次数分布**、触顶情况、失败原因。
// 用法: ego-browser nodejs < bench/reveal-tasks.js   （轮数 __ROUNDS__，默认 5）
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const { runJevAutonomousLoop } = await import("/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs");
const { parseRevealCounts, describe } = await import(`${BENCH}/reveal-util.mjs`);
const ROUNDS = Number(globalThis.__ROUNDS__ || 5);
const ONLY = globalThis.__ONLY__ || null; // 只跑指定任务（调试用）

const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();
const envText = await readFile("/Users/jiangkoumo/Documents/scratchpad/jev-ultrafast/.env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1).trim()];
  })
);
const textModel = {
  baseUrl: env.TEXT_MODEL_BASE_URL, model: env.TEXT_MODEL, apiKey: env.TEXT_MODEL_API_KEY,
  sessionHeader: "x-opencode-session", sessionId: "ego-jev-reveal",
};

// ── 只读测量：X 时间线 ──（不点击、不输入、不发布）
const measureX = () => {
  const articles = [...document.querySelectorAll("article")];
  const rows = [];
  for (const [i, a] of articles.entries()) {
    const statusLink = [...a.querySelectorAll('a[href*="/status/"]')].find((x) => /\/status\/\d+$/.test(x.getAttribute("href") || ""));
    const id = statusLink ? (statusLink.getAttribute("href").match(/\/status\/(\d+)/) || [])[1] : null;
    if (!id) continue;
    const authorLink = [...a.querySelectorAll("a[href]")].find((x) => /^\/[A-Za-z0-9_]{1,15}$/.test(x.getAttribute("href") || ""));
    const handle = authorLink ? authorLink.getAttribute("href").slice(1) : null;
    const rect = a.getBoundingClientRect();
    const text = (a.innerText || "").replace(/\s+/g, " ").trim();
    rows.push({
      i, id, handle, y: Math.round(rect.top + scrollY),
      screen: Number(((rect.top + scrollY) / innerHeight).toFixed(2)),
      text: text.slice(0, 90),
    });
  }
  return { viewportH: innerHeight, docH: document.documentElement.scrollHeight, rows };
};

// ── 只读测量：Wikipedia 搜索结果 ──
const measureWiki = () => {
  const links = [...document.querySelectorAll(".mw-search-result-heading a")];
  return {
    viewportH: innerHeight,
    docH: document.documentElement.scrollHeight,
    rows: links.map((a, i) => {
      const rect = a.getBoundingClientRect();
      return {
        i, title: (a.textContent || "").trim(),
        href: a.getAttribute("href"),
        y: Math.round(rect.top + scrollY),
        screen: Number(((rect.top + scrollY) / innerHeight).toFixed(2)),
      };
    }),
  };
};

const snippetOf = (text, handle) => {
  // 取帖子正文里一段有区分度的文字（去掉作者行）
  const body = text.replace(new RegExp(`^.*?@${handle}\\s*`, "i"), "").replace(/^[·\s]+/, "").trim();
  const src = body.length >= 14 ? body : text;
  return safeText(src.slice(0, 26)).replace(/[「」"']/g, "");
};

// 目标文案会进 Jev 请求：截断的 emoji/代理对会让 API 报 "invalid Unicode text"，必须先清。
const safeText = (s) =>
  String(s || "")
    .replace(/[\uD800-\uDFFF]/g, "")   // 孤立代理（截断的 emoji 就是这种）
    .replace(/[\u0000-\u001F\u007F]/g, " ") // 控制字符
    .replace(/\s+/g, " ")
    .trim();

const X_TASKS = {
  "x-control": { site: "X", control: true, depth: "首屏" },
  "x-below": { site: "X", control: false, depth: "1.5–4 屏" },
  "x-deep": { site: "X", control: false, depth: ">4 屏" },
};
const WIKI_TASKS = {
  "wiki-first": { site: "Wikipedia 搜索结果", control: true, depth: "首屏" },
  "wiki-deep": { site: "Wikipedia 搜索结果", control: false, depth: ">2 屏" },
};

const out = { startedAt: new Date().toISOString(), rounds: ROUNDS, records: [] };
const space = await taskSpace(`ego-reveal-${Date.now()}`);
const page = space.page("p1");

const runTask = async (taskId, spec, setup, assertFn, maxSteps) => {
  const logLines = [];
  let rec = { round: null, task: taskId, site: spec.site, control: Boolean(spec.control), targetDepth: spec.depth };
  try {
    const t0 = Date.now();
    const r = await runJevAutonomousLoop(page, spec.goal, {
      apiKey: KEY, textModel, maxSteps, metrics: spec.metrics,
      onStep: (m) => logLines.push(String(m)),
      check: async (p) => assertFn(await p.url(), spec),
    });
    const url = await page.url();
    const rv = parseRevealCounts(logLines);
    rec = {
      ...rec,
      round: spec.round,
      elapsedMs: Date.now() - t0, steps: r.steps, success: assertFn(url, spec), reason: r.reason,
      finalUrl: url,
      jevCalls: spec.metrics["jev.request"] || 0,
      protocolCalls: Object.values(spec.metrics).reduce((a, b) => a + b, 0),
      revealCount: rv.count, revealMaxAttempt: rv.maxAttempt, revealCap: rv.cap,
      hitCapAndFailed: rv.count > 0 && rv.maxAttempt >= (rv.cap || 4) && r.reason === "target_missing",
      usedSearchBox: r.history.some((h) => h.action?.startsWith("type_text")),
      targetScreen: spec.targetScreen ?? null,
      actionLabels: r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}`),
      revealLog: rv.lines,
      setup: setup ?? null,
    };
  } catch (e) {
    rec = { ...rec, elapsedMs: null, steps: null, success: false, reason: "harness_error", error: String(e).slice(0, 200) };
  }
  out.records.push(rec);
  console.log(
    `${taskId.padEnd(12)} r${rec.round}: ${rec.elapsedMs}ms ${rec.steps}步 ${rec.success ? "✅OK" : "❌" + rec.reason}` +
      ` | Jev=${rec.jevCalls} 揭示=${rec.revealCount}${rec.revealMaxAttempt ? `(峰值${rec.revealMaxAttempt}/${rec.revealCap})` : ""}` +
      `${rec.hitCapAndFailed ? " ⚠️触顶" : ""}${rec.usedSearchBox ? " 🔍用了输入框" : ""} | 目标屏≈${rec.targetScreen} | ${String(rec.finalUrl).slice(-26)}`
  );
  return rec;
};

for (let round = 1; round <= ROUNDS; round++) {
  // ── X：先只读测量，再决定锚点 ──
  const xSpecs = {};
  if (!ONLY || ONLY.startsWith("x")) {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    const m = await page.evaluate(measureX);
    const pick = (pred) => m.rows.find(pred) || null;
    // 深度分档按「X 实际渲染了多少条」自适应，不写死绝对屏数
    const sorted = [...m.rows].sort((a, b) => a.screen - b.screen);
    const first = sorted.find((r) => r.screen <= 1) || sorted[0] || null;
    const below = sorted.find((r) => r.handle && r.screen > 1.2 && r.screen <= 4) || null;
    const deep = (() => {
      const cands = sorted.filter((r) => r.handle && r.screen > 1.8 && r.screen > (below?.screen ?? 0) + 0.5);
      return cands.length ? cands[cands.length - 1] : null;
    })();
    const mk = (label, t) => {
      if (!t) return null;
      return {
        // 主锚点是 @handle（元素表里有作者链接，可定位）；正文片段只作辅助线索。
        // 只用正文片段做锚点实测不可行：pageText 是文本节点拼起来的，跨行片段对不上，
        // 连“首屏内”的对照任务都会因找不到而反复滚动→stuck（已试过，见报告）。
        // 只说目标，不指示“向下滚动”（实测那句会直接诱发连滚→撞 stuck 守卫，连首屏内的对照都失败）；
        // 也不写 @handle 以外的细节：让引擎自己决定要不要滚。
        goal:
          `不要使用搜索框。打开 @${t.handle} 发的这条帖子的详情页` +
          `（正文含「${snippetOf(t.text, t.handle)}」，点它的时间戳链接）`,
        id: t.id, targetScreen: t.screen,
      };
    };
    xSpecs["x-control"] = { ...X_TASKS["x-control"], ...mk("first", first) };
    xSpecs["x-below"] = { ...X_TASKS["x-below"], ...mk("below", below) };
    xSpecs["x-deep"] = { ...X_TASKS["x-deep"], ...mk("deep", deep) };
    console.log(
      `\n[round ${round}] X 锚点: control=@${first?.handle} 屏${first?.screen} | below=@${below?.handle} 屏${below?.screen} | deep=@${deep?.handle} 屏${deep?.screen}` +
        `  (DOM 内 ${m.rows.length} 条, docH=${m.docH})`
    );
  }

  for (const taskId of Object.keys(X_TASKS)) {
    if (ONLY && !ONLY.includes(taskId)) continue;
    const spec = xSpecs[taskId];
    if (!spec || !spec.id) {
      out.records.push({ round, task: taskId, site: "X", success: false, reason: "no_anchor", note: "该轮未找到符合深度要求的锚点" });
      console.log(`${taskId.padEnd(12)} r${round}: 跳过（未找到符合深度要求的锚点）`);
      continue;
    }
    // 每个 X 任务都要重新回到时间线：上一个任务会把页面导航走，锚点就不再对得上
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    spec.round = round;
    spec.metrics = {};
    await runTask(taskId, spec, { id: spec.id, screen: spec.targetScreen }, (url) => url.includes(`/status/${spec.id}`), 12);
  }

  // ── Wikipedia 搜索结果 ──
  if (!ONLY || ONLY.startsWith("wiki")) {
    await page.goto("https://en.wikipedia.org/w/index.php?search=Jev&fulltext=1", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const m = await page.evaluate(measureWiki);
    const first = m.rows[0] || null;
    const deep = m.rows.find((r) => r.screen > 2) || null;
    console.log(`[round ${round}] wiki 结果 ${m.rows.length} 条, docH=${m.docH}; first=${first?.title} 屏${first?.screen}; deep=${deep?.title} 屏${deep?.screen}`);
    for (const [taskId, t] of [["wiki-first", first], ["wiki-deep", deep]]) {
      if (ONLY && !ONLY.includes(taskId)) continue;
      if (!t) {
        out.records.push({ round, task: taskId, site: "Wikipedia 搜索结果", success: false, reason: "no_anchor" });
        continue;
      }
      const spec = {
        ...WIKI_TASKS[taskId], round, targetScreen: t.screen, metrics: {},
        // 不写“不要用搜索框”，引擎会直接把标题打进搜索框重新检索——那样根本不触发滚动，
        // 也就测不到揭示机制（实测首轮就是这么“完成”的）。
        goal: `不要使用搜索框重新检索。在当前结果列表里找到并打开标题为「${safeText(t.title)}」的条目`,
      };
      await runTask(taskId, spec, { title: t.title, screen: t.screen }, (url) => decodeURIComponent(url).includes(t.href.replace(/^\//, "")), 10);
    }
  }
}

console.log("\n=== 汇总（A 栈）===");
for (const taskId of [...Object.keys(X_TASKS), ...Object.keys(WIKI_TASKS)]) {
  const rs = out.records.filter((r) => r.task === taskId && r.reason !== "no_anchor");
  if (!rs.length) continue;
  const ok = rs.filter((r) => r.success);
  const d = describe(ok.map((r) => r.elapsedMs));
  console.log(
    `  ${taskId.padEnd(12)} 成功率 ${ok.length}/${rs.length}  耗时中位 ${d ? Math.round(d.median) : "-"}ms` +
      `  步中位 ${describe(ok.map((r) => r.steps))?.median ?? "-"}  Jev中位 ${describe(ok.map((r) => r.jevCalls))?.median ?? "-"}` +
      `  揭示次数 [${rs.map((r) => r.revealCount).join(", ")}]`
  );
  const capped = rs.filter((r) => r.hitCapAndFailed);
  if (capped.length) console.log(`     触顶 maxReveals 仍失败: ${capped.length} 轮，目标屏 ≈ ${capped.map((r) => r.targetScreen).join(", ")}`);
}

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/reveal-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/reveal-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
