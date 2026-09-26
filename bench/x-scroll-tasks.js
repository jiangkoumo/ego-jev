// P0-1 验收（端到端，X 时间线，严格只读）：滚动感知的进展判定 + 目标自动滚入视口。
//
// 任务定义、锚点测量、成功判据与 `bench/reveal-tasks.js`（产出「A 栈 0/15」那份数据的脚本）
// 逐字一致，只额外记录新机制的证据字段（scrollMoved / progressed / intoViewCount /
// 同动作最长连续次数 / 点击目标描述）。所以本文件的成功率与 REVEAL-REPORT.md 的 0/15 可直接对照。
//
// 严格只读的两道闸（X 上不得发布/回复/转发/点赞，不得输入任何内容）：
//   ① 引擎侧：本脚本不提供任何文本来源（无 options.text、无 textModel）→ Jev 的
//      type_text / type_text_select 选项根本不会被提问，物理上无法输入内容。
//   ② 脚本侧互锁：包一层 page，凡是要派发 mousePressed 时先用 elementFromPoint 检查
//      命中元素是否 like/unlike/repost/retweet/reply/bookmark/follow，是就直接不派发。
//      被拦下的次数记进 readOnlyBlocked，并逐条打印。
//
// 用法: ego-browser nodejs < bench/x-scroll-tasks.js        （轮数 __ROUNDS__，默认 5）
const { writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/x-scroll-tasks.js | ego-browser nodejs
// ② 直接 `< bench/x-scroll-tasks.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { runJevAutonomousLoop } = await import(JE);
const { parseRevealCounts, describe } = await import(`${BENCH}/reveal-util.mjs`);
const ROUNDS = Number(globalThis.__ROUNDS__ || 5);

const KEY = await loadBenchApiKey();

// ── 只读测量：X 时间线（不点击、不输入、不发布）── 与 reveal-tasks.js 逐字一致
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

const snippetOf = (text, handle) => {
  const body = text.replace(new RegExp(`^.*?@${handle}\\s*`, "i"), "").replace(/^[·\s]+/, "").trim();
  const src = body.length >= 14 ? body : text;
  return safeText(src.slice(0, 26)).replace(/[「」"']/g, "");
};
const safeText = (s) =>
  String(s || "")
    .replace(/[\uD800-\uDFFF]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const X_TASKS = {
  "x-control": { site: "X", control: true, depth: "首屏" },
  "x-below": { site: "X", control: false, depth: "1.5–4 屏" },
  "x-deep": { site: "X", control: false, depth: ">4 屏" },
};

/** 只读互锁：不派发任何 like/unlike/repost/retweet/reply/bookmark/follow 的点击 */
const RISKY = /like|unlike|repost|retweet|reply|bookmark|follow|share/i;
const readOnlyPage = (raw, stats) => {
  const handler = {
    get(target, prop) {
      if (prop === "cdp") {
        return async (method, params) => {
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            try {
              const hit = await target.evaluate(
                ({ x, y }) => {
                  const el = document.elementFromPoint(x, y);
                  const node = el?.closest('button,[role="button"]');
                  return node ? `${node.getAttribute("aria-label") || ""}|${node.getAttribute("data-testid") || ""}` : "";
                },
                { x: params.x, y: params.y }
              );
              if (RISKY.test(hit || "")) {
                stats.readOnlyBlocked.push(hit);
                console.log(`  ⛔ 只读互锁拦下一次点击：${hit}`);
                return { blocked: true };
              }
            } catch {
              /* 检查失败不阻塞（此时页面可能正在导航） */
            }
          }
          return target.cdp(method, params);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  };
  return new Proxy(raw, handler);
};

/** 同动作最长连续次数（stuck 守卫的输入；>3 就说明旧守卫会中止） */
const maxSameActionRun = (labels) => {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const l of labels) {
    const action = String(l).split(":")[0];
    run = action === prev ? run + 1 : 1;
    prev = action;
    best = Math.max(best, run);
  }
  return best;
};

const out = { startedAt: new Date().toISOString(), rounds: ROUNDS, engine: "scripts/decider-loop.mjs", records: [] };
const space = await taskSpace(`ego-xscroll-${Date.now()}`);
const raw = space.page("p1");

for (let round = 1; round <= ROUNDS; round++) {
  await raw.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await raw.waitForTimeout(4000);
  const m = await raw.evaluate(measureX);
  const sorted = [...m.rows].sort((a, b) => a.screen - b.screen);
  const first = sorted.find((r) => r.screen <= 1) || sorted[0] || null;
  const below = sorted.find((r) => r.handle && r.screen > 1.2 && r.screen <= 4) || null;
  const deep = (() => {
    const cands = sorted.filter((r) => r.handle && r.screen > 1.8 && r.screen > (below?.screen ?? 0) + 0.5);
    return cands.length ? cands[cands.length - 1] : null;
  })();
  const mk = (t) => {
    if (!t) return null;
    return {
      goal:
        `不要使用搜索框。打开 @${t.handle} 发的这条帖子的详情页` +
        `（正文含「${snippetOf(t.text, t.handle)}」，点它的时间戳链接）`,
      id: t.id, targetScreen: t.screen,
    };
  };
  const specs = {
    "x-control": { ...X_TASKS["x-control"], ...mk(first) },
    "x-below": { ...X_TASKS["x-below"], ...mk(below) },
    "x-deep": { ...X_TASKS["x-deep"], ...mk(deep) },
  };
  console.log(
    `\n[round ${round}] X 锚点: control=@${first?.handle} 屏${first?.screen} | below=@${below?.handle} 屏${below?.screen} | deep=@${deep?.handle} 屏${deep?.screen}` +
      `  (DOM 内 ${m.rows.length} 条, docH=${m.docH})`
  );

  for (const taskId of Object.keys(X_TASKS)) {
    const spec = specs[taskId];
    if (!spec || !spec.id) {
      out.records.push({ round, task: taskId, site: "X", success: false, reason: "no_anchor" });
      console.log(`${taskId.padEnd(12)} r${round}: 跳过（未找到符合深度要求的锚点）`);
      continue;
    }
    await raw.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await raw.waitForTimeout(3000);
    const stats = { readOnlyBlocked: [] };
    const page = readOnlyPage(raw, stats);
    const logLines = [];
    let rec = { round, task: taskId, site: spec.site, control: Boolean(spec.control), targetDepth: spec.depth, targetScreen: spec.targetScreen };
    try {
      const metrics = {};
      const t0 = Date.now();
      const r = await runJevAutonomousLoop(page, spec.goal, {
        apiKey: KEY, maxSteps: 12, metrics,
        onStep: (msg) => logLines.push(String(msg)),
        check: async (p) => String(await p.url()).includes(`/status/${spec.id}`),
      });
      const url = await raw.url();
      const rv = parseRevealCounts(logLines);
      const labels = r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}`);
      rec = {
        ...rec,
        elapsedMs: Date.now() - t0, steps: r.steps, success: url.includes(`/status/${spec.id}`), reason: r.reason,
        finalUrl: url,
        jevCalls: metrics["jev.request"] || 0,
        protocolCalls: Object.values(metrics).reduce((a, b) => a + b, 0),
        revealCount: rv.count, revealMaxAttempt: rv.maxAttempt, revealCap: rv.cap,
        scrollSteps: r.history.filter((h) => h.action === "scroll_down" || h.action === "scroll_up").length,
        scrollMovedSteps: r.history.filter((h) => h.scrollMoved === true).length,
        progressedSteps: r.history.filter((h) => h.progressed === true).length,
        intoViewTotal: r.history.reduce((a, h) => a + (h.intoViewCount || 0), 0),
        maxSameActionRun: maxSameActionRun(labels),
        invalidResponses: r.history.filter((h) => h.invalidResponse).length,
        guardRejected: r.history.filter((h) => h.guardRejected).length,
        targetMissing: r.history.filter((h) => h.targetMissing).length,
        readOnlyBlocked: stats.readOnlyBlocked,
        clickedLabels: r.history.filter((h) => h.action === "click").map((h) => h.targetLabel),
        actionLabels: labels,
        revealLog: rv.lines,
      };
    } catch (e) {
      rec = { ...rec, elapsedMs: null, steps: null, success: false, reason: "harness_error", error: String(e).slice(0, 200), readOnlyBlocked: stats.readOnlyBlocked };
    }
    out.records.push(rec);
    console.log(
      `${taskId.padEnd(12)} r${round}: ${rec.elapsedMs}ms ${rec.steps}步 ${rec.success ? "✅OK" : "❌" + rec.reason}` +
        ` | Jev=${rec.jevCalls} 滚动=${rec.scrollSteps}(动了${rec.scrollMovedSteps}) 滚入=${rec.intoViewTotal}` +
        ` 最长同动作=${rec.maxSameActionRun} 揭示=${rec.revealCount} 只读拦截=${rec.readOnlyBlocked?.length ?? 0}` +
        ` | 目标屏≈${rec.targetScreen} | ${String(rec.finalUrl).slice(-26)}`
    );
  }
}

console.log("\n=== 汇总（X，只读）===");
for (const taskId of Object.keys(X_TASKS)) {
  const rs = out.records.filter((r) => r.task === taskId && r.reason !== "no_anchor");
  if (!rs.length) continue;
  const ok = rs.filter((r) => r.success);
  const d = describe(ok.map((r) => r.elapsedMs));
  console.log(
    `  ${taskId.padEnd(12)} 成功率 ${ok.length}/${rs.length}  耗时中位 ${d ? Math.round(d.median) : "-"}ms` +
      `  步中位 ${describe(ok.map((r) => r.steps))?.median ?? "-"}  Jev中位 ${describe(ok.map((r) => r.jevCalls))?.median ?? "-"}` +
      `  滚动步 [${rs.map((r) => r.scrollSteps).join(", ")}]  最长同动作 [${rs.map((r) => r.maxSameActionRun).join(", ")}]` +
      `  滚入 [${rs.map((r) => r.intoViewTotal).join(", ")}]  揭示 [${rs.map((r) => r.revealCount).join(", ")}]`
  );
}
const all = out.records.filter((r) => r.reason !== "no_anchor");
const reasons = {};
for (const r of all) if (!r.success) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
console.log(`  X 合计 ${all.filter((r) => r.success).length}/${all.length}；失败原因分布 ${JSON.stringify(reasons)}`);
console.log(`  只读互锁拦截合计 ${out.records.reduce((a, r) => a + (r.readOnlyBlocked?.length || 0), 0)} 次`);

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/x-scroll-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/x-scroll-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
