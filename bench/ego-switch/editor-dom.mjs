// 只读结构探针：X 回复撰写框的 Draft.js DOM 结构（写完后放弃草稿）
const { writeFile } = await import("node:fs/promises");
const TWEET = "https://x.com/NFT_Chen/status/2102297992179200329";
const space = await taskSpace(`ego-dom-${Date.now()}`);
const page = space.page("p1");
const out = { startedAt: new Date().toISOString() };
try {
  await page.goto(TWEET, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.waitForSelector('article[data-testid="tweet"] button[data-testid="reply"]', { timeout: 25000 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('article[data-testid="tweet"] button[data-testid="reply"]')].find((x) => x.getBoundingClientRect().width > 0);
    if (b) b.click();
  });
  await page.waitForSelector('[role="dialog"] [data-testid="tweetTextarea_0"]', { timeout: 20000, state: "visible" });
  await page.waitForTimeout(1500);
  out.structure = await page.evaluate(() => {
    const wrap = [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].find((e) => e.getBoundingClientRect().width > 0);
    if (!wrap) return { found: false, dialogs: document.querySelectorAll('[role="dialog"]').length };
    const desc = [...wrap.querySelectorAll("*")].slice(0, 12).map((e) => ({
      tag: e.tagName,
      ce: e.getAttribute("contenteditable"),
      cls: String(e.className).slice(0, 70),
      testid: e.getAttribute("data-testid") || "",
      blocks: e.querySelectorAll('[data-block="true"]').length,
      box: (() => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
    }));
    return {
      found: true,
      wrapTag: wrap.tagName,
      wrapCe: wrap.getAttribute("contenteditable"),
      wrapCls: String(wrap.className).slice(0, 90),
      wrapHtml: wrap.outerHTML.slice(0, 700),
      wrapBox: (() => { const r = wrap.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
      descendants: desc,
      allEditableInDialog: [...document.querySelectorAll('[role="dialog"] [contenteditable]')].map((e) => ({
        ce: e.getAttribute("contenteditable"), cls: String(e.className).slice(0, 60),
        testid: e.getAttribute("data-testid") || "", blocks: e.querySelectorAll('[data-block="true"]').length,
        box: (() => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })(),
      })),
      viewport: { w: innerWidth, h: innerHeight, y: scrollY },
    };
  });
  console.log(JSON.stringify(out.structure, null, 1).slice(0, 3000));
  // 放弃草稿（此时草稿为空，仍走一遍关闭流程）
  const closeBox = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (closeBox) {
    await page.mouse.click(closeBox.x, closeBox.y, { label: "关闭撰写框" });
    await page.waitForTimeout(1200);
    const sheet = await page.evaluate(() => ({
      cancel: [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].filter((e) => e.getBoundingClientRect().width > 0).length,
      save: [...document.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].filter((e) => e.getBoundingClientRect().width > 0).length,
    }));
    console.log("sheet:", JSON.stringify(sheet));
    if (sheet.cancel > 0) {
      const cb = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      await page.mouse.click(cb.x, cb.y, { label: "放弃草稿" });
      await page.waitForTimeout(1200);
    }
  }
  out.dialogAfter = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length);
  out.url = await page.url();
  console.log("dialogAfter:", out.dialogAfter, "url:", out.url);
} catch (e) { out.err = String(e).slice(0, 300); console.log("ERROR " + out.err); }
await writeFile("/tmp/ego-switch/editor-dom.json", JSON.stringify(out, null, 2));
try { await space.finish({ keep: [] }); } catch {}
