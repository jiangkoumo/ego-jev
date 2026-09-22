// P0-1 验收（端到端，X 时间线，严格只读）：改动前引擎(HEAD e29c3a9) vs 改动后引擎，配对对照。
//
// 任务定义 / 锚点测量 / 成功判据与 bench/reveal-tasks.js 逐字一致，但修掉了一个测量缺陷：
//   旧 harness 一轮里先测 3 个锚点，然后每个任务前再 goto(home) 一次 —— 而 X 时间线每次
//   重新加载内容都会变（虚拟化 + 推荐流），于是「测到的帖子」在任务开始的那次加载里可能
//   根本不存在（bench/x-one-step.js 实测：同一次加载里目标在表内、Jev 以 0.99 置信度点中；
//   重新加载后目标消失，Jev 只能一直滚动去找）。
//   本脚本改为「每个任务：先 goto → 等 → 测锚点 → 在同一次加载上跑任务」。
//
// 严格只读：不提供任何文本来源（Jev 无法选输入类操作）+ 只读互锁（like/unlike/repost/
// retweet/reply/bookmark/follow 的点击一律不派发，次数记进 readOnlyBlocked）。
//
// 用法: ego-browser nodejs < bench/x-scroll-pair.js       （轮数 __ROUNDS__，默认 6）
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const NEW = "/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs";
const OLD = `${BENCH}/scroll-baseline-engine.mjs`;
const ROUNDS = Number(globalThis.__ROUNDS__ || 6);
const { parseRevealCounts } = await import(`${BENCH}/reveal-util.mjs`);
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();

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
    rows.push({ i, id, handle, screen: Number(((rect.top + scrollY) / innerHeight).toFixed(2)), text: text.slice(0, 90) });
  }
  return { viewportH: innerHeight, docH: document.documentElement.scrollHeight, rows };
};
const safeText = (s) => String(s || "").replace(/[\uD800-\uDFFF]/g, "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
const snippetOf = (text, handle) => {
  const body = text.replace(new RegExp(`^.*?@${handle}\\s*`, "i"), "").replace(/^[·\s]+/, "").trim();
  const src2 = body.length >= 14 ? body : text;
  return safeText(src2.slice(0, 26)).replace(/[「」"']/g, "");
};
/** 目标选取：与 reveal-tasks.js 的分档规则一致（按 X 实际渲染了多少条自适应） */
const pickTargets = (rows) => {
  const sorted = [...rows].sort((a, b) => a.screen - b.screen);
  const first = sorted.find((r) => r.screen <= 1) || sorted[0] || null;
  const below = sorted.find((r) => r.handle && r.screen > 1.2 && r.screen <= 4) || null;
  const cands = sorted.filter((r) => r.handle && r.screen > 1.8 && r.screen > (below?.screen ?? 0) + 0.5);
  const deep = cands.length ? cands[cands.length - 1] : null;
  return { first, below, deep };
};

const RISKY = /like|unlike|repost|retweet|reply|bookmark|follow|share/i;
const readOnlyPage = (raw, stats) =>
  new Proxy(raw, {
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
            } catch { /* 页面可能在导航 */ }
          }
          return target.cdp(method, params);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const maxSameActionRun = (labels) => {
  let best = 0, run = 0, prev = null;
  for (const l of labels) {
    const action = String(l).split(":")[0];
    run = action === prev ? run + 1 : 1;
    prev = action;
    best = Math.max(best, run);
  }
  return best;
};

const engines = { old: await import(OLD), new: await import(NEW) };
const out = { startedAt: new Date().toISOString(), rounds: ROUNDS, old: OLD, new: NEW, records: [] };
const space = await taskSpace(`ego-xpair-${Date.now()}`);
const raw = space.page("p1");

const TASK_SPECS = {
  "x-control": { depth: "首屏", pick: (t) => t.first },
  "x-below": { depth: "1.2–4 屏", pick: (t) => t.below },
  "x-deep": { depth: ">1.8 屏", pick: (t) => t.deep },
  // 显式测「必须连滚 >3 次」：先只读预滚 2 屏把内容加载出来、量到最深那条帖，
  // 再回到顶部开跑。目标深度 >2.5 屏 ⇒ 600px/步至少 3 次以上滚动。
  "x-far": { depth: ">2.5 屏（预滚测量，回到顶部开跑）", pick: (t) => t.deepest, preScroll: 2 },
};

for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 === 1 ? ["old", "new"] : ["new", "old"];
  for (const taskId of Object.keys(TASK_SPECS)) {
    for (const which of order) {
      const stats = { readOnlyBlocked: [] };
      const page = readOnlyPage(raw, stats);
      let rec = { round, task: taskId, engine: which, order: order.join(">"), targetDepth: TASK_SPECS[taskId].depth };
      try {
        // 锚点测量与任务执行在同一次加载上（本脚本相对 reveal-tasks.js 的唯一改动）
        await raw.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
        await raw.waitForTimeout(4000);
        if (TASK_SPECS[taskId].preScroll) {
          await raw.evaluate(
            (n) => window.scrollTo({ top: Math.round(innerHeight * n), behavior: "instant" }),
            TASK_SPECS[taskId].preScroll
          );
          await raw.waitForTimeout(1500);
        }
        const m = await raw.evaluate(measureX);
        const rowsSorted = [...m.rows].sort((a, b) => b.screen - a.screen);
        const t = TASK_SPECS[taskId].pick({ ...pickTargets(m.rows), deepest: rowsSorted[0] || null });
        if (TASK_SPECS[taskId].preScroll) {
          await raw.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await raw.waitForTimeout(800);
        }
        if (!t) {
          rec = { ...rec, reason: "no_anchor", success: false, domArticles: m.rows.length, docH: m.docH, readOnlyBlocked: [] };
          out.records.push(rec);
          console.log(`${taskId.padEnd(11)} ${which.padEnd(4)} r${round}: 跳过（无符合深度要求的锚点, DOM ${m.rows.length} 条）`);
          continue;
        }
        const goal =
          `不要使用搜索框。打开 @${t.handle} 发的这条帖子的详情页` +
          `（正文含「${snippetOf(t.text, t.handle)}」，点它的时间戳链接）`;
        const metrics = {};
        const logLines = [];
        const t0 = Date.now();
        const r = await engines[which].runJevAutonomousLoop(page, goal, {
          apiKey: KEY, maxSteps: 12, metrics, onStep: (msg) => logLines.push(String(msg)),
          check: async (p) => String(await p.url()).includes(`/status/${t.id}`),
        });
        const url = await raw.url();
        const rv = parseRevealCounts(logLines);
        const labels = r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}`);
        rec = {
          ...rec,
          handle: t.handle, targetId: t.id, targetScreen: t.screen, domArticles: m.rows.length, docH: m.docH,
          elapsedMs: Date.now() - t0, steps: r.steps, success: url.includes(`/status/${t.id}`), reason: r.reason,
          finalUrl: url, jevCalls: metrics["jev.request"] || 0,
          scrollSteps: r.history.filter((h) => h.action === "scroll_down" || h.action === "scroll_up").length,
          scrollMovedSteps: r.history.filter((h) => h.scrollMoved === true).length,
          progressedSteps: r.history.filter((h) => h.progressed === true).length,
          intoViewTotal: r.history.reduce((a, h) => a + (h.intoViewCount || 0), 0),
          maxSameActionRun: maxSameActionRun(labels),
          revealCount: rv.count, revealMaxAttempt: rv.maxAttempt,
          invalidResponses: r.history.filter((h) => h.invalidResponse).length,
          guardRejected: r.history.filter((h) => h.guardRejected).length,
          targetMissing: r.history.filter((h) => h.targetMissing).length,
          readOnlyBlocked: stats.readOnlyBlocked,
          clickedLabels: r.history.filter((h) => h.action === "click").map((h) => h.targetLabel),
          actionLabels: labels,
        };
      } catch (e) {
        rec = { ...rec, elapsedMs: null, steps: null, success: false, reason: "harness_error", error: String(e).slice(0, 200), readOnlyBlocked: stats.readOnlyBlocked };
      }
      out.records.push(rec);
      console.log(
        `${taskId.padEnd(11)} ${which.padEnd(4)} r${round}: ${rec.elapsedMs}ms ${rec.steps}步 ${rec.success ? "✅OK" : "❌" + rec.reason}` +
          ` | Jev=${rec.jevCalls} 滚动=${rec.scrollSteps}(动了${rec.scrollMovedSteps}) 滚入=${rec.intoViewTotal}` +
          ` 最长同动作=${rec.maxSameActionRun} 揭示=${rec.revealCount} 拦截=${rec.readOnlyBlocked?.length ?? 0} | 目标屏≈${rec.targetScreen}`
      );
    }
  }
}

console.log("\n=== 配对汇总（X，只读；measure-and-run on the same load）===");
const summary = [];
for (const taskId of Object.keys(TASK_SPECS)) {
  const rows = out.records.filter((r) => r.task === taskId && r.reason !== "no_anchor");
  const o = rows.filter((r) => r.engine === "old");
  const n = rows.filter((r) => r.engine === "new");
  const okO = o.filter((r) => r.success).length;
  const okN = n.filter((r) => r.success).length;
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  summary.push({
    task: taskId,
    oldSuccess: `${okO}/${o.length}`, newSuccess: `${okN}/${n.length}`,
    oldReasons: o.filter((r) => !r.success).map((r) => r.reason),
    newReasons: n.filter((r) => !r.success).map((r) => r.reason),
    oldMedianMs: med(o.filter((r) => r.success).map((r) => r.elapsedMs)),
    newMedianMs: med(n.filter((r) => r.success).map((r) => r.elapsedMs)),
    newScrollSteps: n.map((r) => r.scrollSteps), newMaxSameActionRun: n.map((r) => r.maxSameActionRun),
    newIntoView: n.map((r) => r.intoViewTotal), newReveal: n.map((r) => r.revealCount),
    oldScrollSteps: o.map((r) => r.scrollSteps), oldMaxSameActionRun: o.map((r) => r.maxSameActionRun),
  });
  console.log(
    `  ${taskId.padEnd(11)} old ${okO}/${o.length} ${JSON.stringify(o.filter((r) => !r.success).map((r) => r.reason))}` +
      `  →  new ${okN}/${n.length} ${JSON.stringify(n.filter((r) => !r.success).map((r) => r.reason))}` +
      `  中位 ${med(o.filter((r) => r.success).map((r) => r.elapsedMs))}ms → ${med(n.filter((r) => r.success).map((r) => r.elapsedMs))}ms` +
      `  新:滚动步[${n.map((r) => r.scrollSteps).join(",")}] 最长同动作[${n.map((r) => r.maxSameActionRun).join(",")}] 滚入[${n.map((r) => r.intoViewTotal).join(",")}] 揭示[${n.map((r) => r.revealCount).join(",")}]`
  );
}
const all = out.records.filter((r) => r.reason !== "no_anchor");
const reasonDist = (rs) => {
  const d = {};
  for (const r of rs) if (!r.success) d[r.reason] = (d[r.reason] || 0) + 1;
  return d;
};
console.log(`  X 合计 old ${all.filter((r) => r.engine === "old" && r.success).length}/${all.filter((r) => r.engine === "old").length}` +
  ` (失败原因 ${JSON.stringify(reasonDist(all.filter((r) => r.engine === "old")))})` +
  `  new ${all.filter((r) => r.engine === "new" && r.success).length}/${all.filter((r) => r.engine === "new").length}` +
  ` (失败原因 ${JSON.stringify(reasonDist(all.filter((r) => r.engine === "new")))})`);
console.log(`  只读互锁拦截合计 ${out.records.reduce((a, r) => a + (r.readOnlyBlocked?.length || 0), 0)} 次`);
out.summary = summary;

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/x-scroll-pair-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/x-scroll-pair-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
