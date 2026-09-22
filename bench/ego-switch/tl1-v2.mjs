// 实测（v2，对应 SKILL.md 步骤 1 改进后的判定）：ego 上跑 TL1 抓取（只读）+ 确认 X 登录账号。
// 相对 v1 的改进：记录筛选前年龄分布、是否曾见空列表、实际等待时长，并按帖子自报时间再过滤一遍。
const { writeFile } = await import("node:fs/promises");
const OUT = "/tmp/ego-switch/tl1-fetch-v2.json";
const space = await taskSpace(`ego-tl1-${Date.now()}`);
const page = space.page("p1");
const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (k, v) => { out.steps.push({ k, v }); console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const ev = async (fn, ...rest) => {
  const t0 = Date.now();
  const v = rest.length ? await page.evaluate(fn, rest[0]) : await page.evaluate(fn);
  out.steps.push({ k: "evaluateMs", v: Date.now() - t0 });
  return v;
};
try {
  // 0) 确认 ego 侧 X 登录态（read-only）
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  log("xHome", await ev(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const nav = [...document.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute("href")).filter((h) => /^\/[A-Za-z0-9_]{1,15}$/.test(h));
    const t = (document.body.innerText || "").replace(/\s+/g, " ");
    return {
      url: location.href,
      articles: document.querySelectorAll("article").length,
      composers: [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].filter(vis).length,
      loginWall: /登录|Log in|Sign up/i.test(t.slice(0, 300)),
      accountLinks: [...new Set(nav)].slice(0, 8),
      title: document.title,
    };
  }));

  // 1) TL1 基础页
  let gotoThrew = null;
  try { await page.goto("https://www.tl1.com/trending", { waitUntil: "domcontentloaded", timeout: 20000 }); }
  catch (e) { gotoThrew = String(e).slice(0, 140); }
  log("tl1GotoThrew", gotoThrew);
  const links = () => ev(() => document.querySelectorAll('a[href*="/status/"]').length);
  let n = 0;
  for (let i = 0; i < 10 && !n; i++) { await page.waitForTimeout(2000); n = await links(); }
  log("basePageLinks", n);
  log("url", await page.url());
  log("buttons", await ev(() => [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 40)));

  // 2) 点筛选
  const clickLabel = (label) => ev((lb) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === lb);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  log("click3h", await clickLabel("3h"));
  await page.waitForTimeout(1000);
  log("click20K", await clickLabel("≤20K"));
  await page.waitForTimeout(500);
  log("urlAfterFilter", await page.url());

  // 3) 轮询（改进后的判定）
  const ages = () => ev(() => JSON.stringify((document.body.innerText.match(/\[[^\]]*?前\]/g) || []).slice(0, 20)));
  const hourAge = (label) => { const m = label.match(/(\d+)\s*小时前/); return m ? Number(m[1]) : null; };
  const beforeAges = JSON.parse(await ages());
  log("beforeAges", beforeAges);
  const noOutOfWindow = (items) => items.length >= 8 && items.every((t) => { const h = hourAge(t); return h === null || h <= 4; });
  let ok = false, last = "[]", sawEmpty = false, waitedMs = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2000);
    waitedMs += 2000;
    last = await ages();
    const items = JSON.parse(last);
    if (!items.length) { sawEmpty = true; continue; }
    if (noOutOfWindow(items)) { ok = true; break; }
  }
  log("afterAges", JSON.parse(last));
  log("sawEmptyList", sawEmpty);
  log("waitedMs", waitedMs);
  log("windowOk", ok);

  // 4) 提取 + 按帖子自报时间过滤
  const posts = await ev(() => {
    const seen = new Set();
    const list = [];
    for (const a of document.querySelectorAll('a[href*="/status/"]')) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const t = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      if (t) list.push({ url: a.href, rawText: t.slice(0, 400) });
    }
    return list;
  });
  const ageOf = (raw) => { const m = raw.match(/\[(\d+)\s*小时前\]/); return m ? Number(m[1]) : null; };
  const candidates = posts.filter((p) => { const h = ageOf(p.rawText); return h !== null && h >= 1 && h <= 4; });
  out.posts = posts;
  out.candidates = candidates;
  log("postCount", posts.length);
  log("candidateCount", candidates.length);
  console.log("  候选样例:", JSON.stringify(candidates.slice(0, 3), null, 1).slice(0, 800));
} catch (e) { out.err = String(e).slice(0, 300); console.log("ERROR " + out.err); }
out.endedAt = new Date().toISOString();
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log("RAW: " + OUT);
try { await space.finish({ keep: [] }); } catch {}
