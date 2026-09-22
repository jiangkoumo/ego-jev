// 只读诊断 2：目标确实在元素表里时，Jev 会不会点它？（锚点测量与决策在同一次页面加载上）
// 结论用于判定 X 失败的真正卡点：是「目标够不到」还是「Jev 不选 click」。
// 只读：不提供文本来源（无法输入）；并包一层只读互锁，不派发 like/unlike/repost/retweet/
// reply/bookmark/follow 的点击。
// 用法: ego-browser nodejs < bench/x-one-step.js     （迭代次数 __ITERS__，默认 3）
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const BENCH = "/Users/jiangkoumo/Documents/ego-jev/bench";
const { runJevStep } = await import("/Users/jiangkoumo/Documents/ego-jev/scripts/ego-jev.mjs");
const ITERS = Number(globalThis.__ITERS__ || 3);
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

const space = await taskSpace(`ego-xonestep-${Date.now()}`);
const raw = space.page("p1");
const out = { probedAt: new Date().toISOString(), iterations: [] };
const realFetch = globalThis.fetch;

for (let i = 1; i <= ITERS; i++) {
  const stats = { readOnlyBlocked: [] };
  const page = readOnlyPage(raw, stats);
  try {
    await raw.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await raw.waitForTimeout(4000);
    const m = await raw.evaluate(measureX);
    const first = [...m.rows].sort((a, b) => a.screen - b.screen).find((r) => r.screen <= 1) || null;
    if (!first) {
      out.iterations.push({ i, reason: "no_anchor", viewportH: m.viewportH, docH: m.docH, rows: m.rows.length, screens: m.rows.map((r) => r.screen) });
      console.log(
        `[${i}] 无首屏锚点 | viewportH=${m.viewportH} docH=${m.docH} articles=${m.rows.length} screens=[${m.rows.map((r) => r.screen).join(", ")}]`
      );
      continue;
    }
    const goal = `不要使用搜索框。打开 @${first.handle} 发的这条帖子的详情页（正文含「${snippetOf(first.text, first.handle)}」，点它的时间戳链接）`;
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return realFetch(url, init);
    };
    const r = await runJevStep(page, goal, { apiKey: KEY, metrics: {} });
    globalThis.fetch = realFetch;
    const lines = String(captured?.state || "").split("\n");
    const idx = lines.findIndex((l) => l.includes(`/status/${first.id}`));
    const rec = {
      i, handle: first.handle, id: first.id, targetScreen: first.screen, domArticles: m.rows.length,
      targetInState: idx >= 0, targetLine: idx >= 0 ? lines[idx] : null,
      statusLinesInState: lines.filter((l) => /\/status\/\d+/.test(l)).length,
      action: r.action, confidence: r.operationConfidence, probabilities: r.operationProbabilities,
      chosenTarget: r.target, chosenLabel: r.targetLabel, executed: r.executed,
      invalidResponse: r.invalidResponse, guardRejected: r.guardRejected, error: r.error,
      readOnlyBlocked: stats.readOnlyBlocked,
    };
    out.iterations.push(rec);
    console.log(
      `[${i}] @${first.handle} 屏${first.screen} DOM${m.rows.length}条 | 目标在表内=${idx >= 0 ? `第${idx}行` : "否"}` +
        ` | Jev=${r.action} conf=${r.operationConfidence} target=${r.target || "-"} ${r.targetLabel ? `"${r.targetLabel}"` : ""}` +
        ` | 拦截=${stats.readOnlyBlocked.length}`
    );
    console.log(`     概率: ${JSON.stringify(r.operationProbabilities)}`);
    if (idx >= 0) console.log(`     目标行: ${lines[idx]}`);
    if (r.action === "click" && r.target) {
      console.log(`     ✅ 点了 ${r.target} → ${r.targetLabel}（是否正是目标：${String(r.targetLabel).includes(first.handle) ? "看 label" : "看 label"}）`);
    }
  } catch (e) {
    out.iterations.push({ i, error: String(e).slice(0, 200) });
    console.log(`[${i}] ERROR ${String(e).slice(0, 200)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/x-one-step-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/x-one-step-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
