// 诊断：ego 的 mouse.click 到底点到了谁；Draft 编辑器为什么拿不到焦点
const { writeFile } = await import("node:fs/promises");
const TWEET = "https://x.com/NFT_Chen/status/2102297992179200329";
const space = await taskSpace(`ego-focus-${Date.now()}`);
const page = space.page("p1");
const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (k, v) => { out.steps.push({ k, v }); console.log(`  ${k}: ${JSON.stringify(v)}`); };
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

  // 装监听：记录真实到达的 click 事件
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener("click", (e) => {
      window.__clicks.push({ x: e.clientX, y: e.clientY, tag: e.target.tagName, ce: e.target.getAttribute("contenteditable") || "", testid: e.target.getAttribute("data-testid") || "", cls: String(e.target.className).slice(0, 50) });
    }, true);
  });

  const info = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]');
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + Math.min(r.height / 3, 20));
    const chain = [];
    let node = document.elementFromPoint(cx, cy);
    while (node && chain.length < 6) {
      chain.push({ tag: node.tagName, ce: node.getAttribute("contenteditable") || "", testid: node.getAttribute("data-testid") || "", cls: String(node.className).slice(0, 45), pe: getComputedStyle(node).pointerEvents });
      node = node.parentElement;
    }
    const cs = getComputedStyle(el);
    return {
      cx, cy, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      editorPointerEvents: cs.pointerEvents, editorVisibility: cs.visibility, editorZ: cs.zIndex,
      isEditorAncestorOfHit: el.contains(document.elementFromPoint(cx, cy)),
      hitChain: chain,
      scrollY,
    };
  });
  log("editorInfo", info);

  await page.mouse.click(info.cx, info.cy, { label: "聚焦撰写框" });
  await page.waitForTimeout(500);
  log("recordedClicks", await page.evaluate(() => window.__clicks));
  log("activeElement", await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a.tagName, ce: a.getAttribute("contenteditable") || "", testid: a.getAttribute("data-testid") || "", cls: String(a.className).slice(0, 50) };
  }));

  // 对照：程序化 focus 后 insertText 是否有效
  await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]');
    el.focus();
  });
  await page.waitForTimeout(300);
  log("activeAfterProgrammaticFocus", await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a.tagName, ce: a.getAttribute("contenteditable") || "", testid: a.getAttribute("data-testid") || "" };
  }));
  await page.keyboard.insertText("程序化聚焦后 insertText 测试");
  await page.waitForTimeout(400);
  log("blocksAfterProgrammaticInsert", await page.evaluate(() =>
    JSON.stringify([...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"] [data-block="true"]')].map((b) => (b.textContent || "").replace(/\n/g, "⏎")))
  ));

  // 放弃草稿
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
    log("confirmSheet", sheet);
    if (sheet.cancel > 0) {
      const cb = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      await page.mouse.click(cb.x, cb.y, { label: "放弃草稿" });
      await page.waitForTimeout(1500);
    }
  }
  log("dialogAfterDiscard", await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length));
  log("url", await page.url());
} catch (e) { out.err = String(e).slice(0, 300); console.log("ERROR " + out.err); }
await writeFile("/tmp/ego-switch/focus-diag.json", JSON.stringify(out, null, 2));
try { await space.finish({ keep: [] }); } catch {}
