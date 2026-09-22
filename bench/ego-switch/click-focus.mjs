// 单点判定：page.click(编辑器) 到底有没有让编辑器拿到焦点
const TWEET = "https://x.com/NFT_Chen/status/2102297992179200329";
const space = await taskSpace(`ego-cf-${Date.now()}`);
const page = space.page("p1");
const EDITOR_SEL = '[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]';
const active = () => page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}|ce=${a.getAttribute("contenteditable")}|${a.getAttribute("data-testid") || ""}` : null; });
const out = {};
try {
  await page.goto(TWEET, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.waitForSelector('article[data-testid="tweet"] button[data-testid="reply"]', { timeout: 25000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll('article[data-testid="tweet"] button[data-testid="reply"]')].find((x) => x.getBoundingClientRect().width > 0); if (b) b.click(); });
  await page.waitForSelector('[role="dialog"] [data-testid="tweetTextarea_0"]', { timeout: 20000, state: "visible" });
  await page.waitForTimeout(1500);
  out.activeBefore = await active();
  try { await page.click(EDITOR_SEL, { timeout: 4000, label: "点编辑器" }); out.clickResult = "ok"; }
  catch (e) { out.clickResult = `failed: ${String(e).slice(0, 140)}`; }
  await page.waitForTimeout(400);
  out.activeAfterRealClick = await active();
  await page.keyboard.insertText("真实点击后直接 insertText");
  await page.waitForTimeout(400);
  out.blocksAfterRealClickInsert = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"] [data-block="true"]')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => (b.innerText || "").replace(/\n/g, "⏎"))));
  // 放弃
  const cb = await page.evaluate(() => { const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
  await page.mouse.click(cb.x, cb.y, { label: "关闭撰写框" });
  await page.waitForTimeout(1200);
  const sheet = await page.evaluate(() => [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].filter((e) => e.getBoundingClientRect().width > 0).length);
  if (sheet > 0) {
    const b = await page.evaluate(() => { const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    await page.mouse.click(b.x, b.y, { label: "放弃草稿" });
    await page.waitForTimeout(1200);
  }
  out.dialogAfter = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length);
  out.url = await page.url();
} catch (e) { out.err = String(e).slice(0, 300); }
await (await import("node:fs/promises")).mkdir("/tmp/ego-switch", { recursive: true });
await (await import("node:fs/promises")).writeFile("/tmp/ego-switch/click-focus.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
try { await space.finish({ keep: [] }); } catch {}
