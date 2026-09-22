// 只读核实：`page.click(回复按钮)` 在 ego 上是否可用（失败则记录原始报错；若弹窗开了就立刻放弃）
const { writeFile } = await import("node:fs/promises");
const OUT_DIR = "/tmp/ego-switch";
const OUT = `${OUT_DIR}/reply-click-error.json`;
await (await import("node:fs/promises")).mkdir(OUT_DIR, { recursive: true }); // 新机器上目录不存在也不报 ENOENT
const TWEET = "https://x.com/NFT_Chen/status/2102297992179200329";
const REPLY_SEL = 'article[data-testid="tweet"] button[data-testid="reply"]';
const space = await taskSpace(`ego-rce-${Date.now()}`);
const page = space.page("p1");
const out = { startedAt: new Date().toISOString(), tweet: TWEET };
try {
  await page.goto(TWEET, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.waitForSelector(REPLY_SEL, { timeout: 25000 });
  out.visibleReplyButtons = await page.evaluate((s) => {
    const all = [...document.querySelectorAll(s)];
    return { total: all.length, visible: all.filter((e) => e.getBoundingClientRect().width > 0).length };
  }, REPLY_SEL);
  try {
    await page.click(REPLY_SEL, { timeout: 3000, label: "打开回复撰写框" });
    out.pageClick = "ok";
  } catch (e) {
    out.pageClick = "failed";
    out.pageClickError = String(e).slice(0, 300);
  }
  await page.waitForTimeout(800);
  out.dialogAfterPageClick = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length);
  if (out.dialogAfterPageClick > 0) {
    // 弹窗开了：立刻放弃（本探针不写任何内容）
    const cb = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (cb) await page.mouse.click(cb.x, cb.y, { label: "关闭撰写框" });
    await page.waitForTimeout(1000);
    const c2 = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (c2) await page.mouse.click(c2.x, c2.y, { label: "放弃草稿" });
    out.discardedAfterProbe = true;
  }
  // 对照：JS .click() 能不能开
  await page.waitForTimeout(500);
  out.jsClickOpened = await page.evaluate((s) => {
    const b = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().width > 0);
    if (!b) return false;
    b.click();
    return true;
  }, REPLY_SEL);
  await page.waitForSelector('[role="dialog"] [data-testid="tweetTextarea_0"]', { timeout: 20000, state: "visible" }).then(() => { out.jsClickDialog = true; }).catch(() => { out.jsClickDialog = false; });
  if (out.jsClickDialog) {
    const cb = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (cb) await page.mouse.click(cb.x, cb.y, { label: "关闭撰写框" });
    await page.waitForTimeout(1000);
    const c2 = await page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (c2) await page.mouse.click(c2.x, c2.y, { label: "放弃草稿" });
  }
  out.finalDialog = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length);
  out.url = await page.url();
} catch (e) { out.err = String(e).slice(0, 300); }
console.log(JSON.stringify(out, null, 1));
await writeFile(OUT, JSON.stringify(out, null, 2));
try { await space.finish({ keep: [] }); } catch {}
