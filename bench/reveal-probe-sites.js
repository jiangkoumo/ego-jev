// 站点可用性只读探测（一次跑完所有候选站点，便于拿到 go 后单次执行）
// 严格只读：只 goto + 读 DOM，不点击、不输入、不登录、不发布。
// 用法: ego-browser nodejs < bench/reveal-probe-sites.js
const { writeFile, mkdir } = await import("node:fs/promises");
// 仓库根定位：ego 内嵌运行时拿不到 cwd、import.meta.url 是 "file:////[eval2]"、自定义 env 不传入。
// ① 推荐（测当前工作树）：sed "s|__REPO__|$PWD|g" bench/reveal-probe-sites.js | ego-browser nodejs
// ② 直接 `< bench/reveal-probe-sites.js`：走已安装技能（$HOME/.agents/skills/ego-jev）
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const out = { probedAt: new Date().toISOString(), engineMd5Expected: "9b760682cebac9fdde7d4172639a928a", sites: {} };

const probe = async (page, key, label, url, extract, settleMs = 3000) => {
  const rec = { label, url };
  try {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    rec.gotoMs = Date.now() - t0;
    await page.waitForTimeout(settleMs);
    rec.finalUrl = await page.url();
    rec.title = await page.title();
    Object.assign(rec, await page.evaluate(extract));
  } catch (e) {
    rec.error = String(e).slice(0, 200);
  }
  console.log(`\n=== ${label} ===\n${JSON.stringify(rec, null, 1).slice(0, 900)}`);
  out.sites[key] = rec;
  return rec;
};

const space = await taskSpace("reveal-probe-" + Date.now());
const page = space.page("p1");

// ① X：能否读到时间线（只读；遇登录墙不登录）
await probe(page, "x", "X 时间线（ego 侧，只读）", "https://x.com/home", () => {
  const body = document.body ? document.body.innerText : "";
  return {
    loginWall: /log in|sign in|登录/i.test(body) || Boolean(document.querySelector('a[href="/login"], [data-testid="loginButton"]')),
    hasTimeline: Boolean(document.querySelector('[data-testid="primaryColumn"] article, [data-testid="cellInnerDiv"]')),
    tweetCount: document.querySelectorAll('article[data-testid="tweet"]').length,
    cellCount: document.querySelectorAll('[data-testid="cellInnerDiv"]').length,
    composerPresent: Boolean(document.querySelector('[data-testid="tweetTextarea_0"]')),
    bodyHead: body.replace(/\s+/g, " ").slice(0, 160),
    docHeight: document.documentElement.scrollHeight,
    viewportH: innerHeight,
  };
}, 4000);

// ② CNKI 检索页（免登录可搜）
await probe(page, "cnki", "CNKI 检索页（ego 侧）", "https://kns.cnki.net/kns8s/search", () => {
  const body = document.body ? document.body.innerText : "";
  return {
    hasSearchInput: Boolean(document.querySelector("input#txt_search, input.search-input, input[type=text]")),
    resultRows: document.querySelectorAll("table.result-table-list tbody tr, .result-table-list tr").length,
    captcha: /验证|滑块|拖动/i.test(body),
    bodyHead: body.replace(/\s+/g, " ").slice(0, 160),
    docHeight: document.documentElement.scrollHeight,
    viewportH: innerHeight,
  };
}, 6000);

// ③ 备选：Wikipedia 搜索结果页（长列表、免登录）
await probe(page, "wiki-search-results", "Wikipedia 搜索结果（备选）", "https://en.wikipedia.org/w/index.php?search=Jev&fulltext=1", () => {
  const body = document.body ? document.body.innerText : "";
  return {
    resultLinks: document.querySelectorAll(".mw-search-result-heading a").length,
    bodyHead: body.replace(/\s+/g, " ").slice(0, 160),
    docHeight: document.documentElement.scrollHeight,
    viewportH: innerHeight,
  };
}, 2500);

// ④ 备选：GitHub issue 列表（长列表、免登录）
await probe(page, "github-issues", "GitHub issue 列表（备选）", "https://github.com/microsoft/vscode/issues", () => {
  const body = document.body ? document.body.innerText : "";
  return {
    issueRows: document.querySelectorAll('[data-testid="issue-pr-title-link"], .js-navigation-open[href*="/issues/"]').length,
    bodyHead: body.replace(/\s+/g, " ").slice(0, 160),
    docHeight: document.documentElement.scrollHeight,
    viewportH: innerHeight,
  };
}, 4000);

// ⑤ 备选：HN 第 2 页（已知可用，作为兜底基准）
await probe(page, "hn-p2", "HN 第 2 页（兜底基准）", "https://news.ycombinator.com/?p=2", () => {
  const body = document.body ? document.body.innerText : "";
  return {
    storyLinks: document.querySelectorAll("a.storylink").length,
    moreLink: Boolean([...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "More")),
    bodyHead: body.replace(/\s+/g, " ").slice(0, 160),
    docHeight: document.documentElement.scrollHeight,
    viewportH: innerHeight,
  };
}, 2000);

await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/reveal-probe-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("\nRAW: " + `${BENCH}/raw/reveal-probe-${stamp}.json`);
try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
