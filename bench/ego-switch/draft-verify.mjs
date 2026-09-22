// 实测验收：ego 上 X Draft.js 撰写框完整路径（写入 → [data-block] 回读 → 放弃草稿 → 复查未保存）
// 硬红线：只开撰写框写草稿；提交/保存/点赞/转发/关注在 CDP 层拦截；结束点「放弃」。
const { writeFile } = await import("node:fs/promises");
const OUT_DIR = "/tmp/ego-switch";
const OUT = `${OUT_DIR}/draft-verify.json`;
await (await import("node:fs/promises")).mkdir(OUT_DIR, { recursive: true });
const TWEET = "https://x.com/NFT_Chen/status/2102297992179200329";
const space = await taskSpace(`ego-draftv-${Date.now()}`);
const raw = space.page("p1");

const BLOCK_TESTIDS = new Set([
  "tweetButton", "tweetButtonInline", "confirmationSheetConfirm",
  "like", "unlike", "retweet", "repost", "bookmark", "follow", "share",
]);
const stats = { blocked: [] };
const page = new Proxy(raw, {
  get(target, prop) {
    if (prop === "cdp") {
      return async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          try {
            const hit = await target.evaluate(({ x, y }) => {
              const el = document.elementFromPoint(x, y);
              const node = el?.closest("[data-testid],button,[role='button']");
              return node ? `${node.getAttribute("data-testid") || ""}|${node.getAttribute("aria-label") || ""}` : "";
            }, { x: params.x, y: params.y });
            if (BLOCK_TESTIDS.has(String(hit || "").split("|")[0])) {
              stats.blocked.push(hit);
              console.log(`  ⛔ 拦截（提交/互动类按钮，不派发）: ${hit}`);
              return { blocked: true };
            }
          } catch { /* 页面可能在导航 */ }
        }
        return target.cdp(method, params);
      };
    }
    const v = target[prop];
    return typeof v === "function" ? v.bind(target) : v;
  },
});

const out = { startedAt: new Date().toISOString(), tweet: TWEET, steps: [] };
const log = (k, v) => { out.steps.push({ k, v }); console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const ev = async (fn, ...rest) => (rest.length ? page.evaluate(fn, rest[0]) : page.evaluate(fn));
const REPLY_SEL = 'article[data-testid="tweet"] button[data-testid="reply"]';
const EDITOR_SEL = '[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]';
const openComposer = async () => {
  await page.waitForSelector(REPLY_SEL, { timeout: 25000 });
  await ev((s) => {
    const b = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().width > 0);
    if (b) b.click();
    return Boolean(b);
  }, REPLY_SEL);
  await page.waitForSelector('[role="dialog"] [data-testid="tweetTextarea_0"]', { timeout: 20000, state: "visible" });
  await page.waitForTimeout(1500);
};
const focusEditor = async () => {
  await ev((s) => document.querySelector(s).focus(), EDITOR_SEL);
  await page.waitForTimeout(300);
  return ev(() => {
    const a = document.activeElement;
    return a ? { tag: a.tagName, editable: a.getAttribute("contenteditable") || "", testid: a.getAttribute("data-testid") || "" } : null;
  });
};
const readback = () =>
  ev(() => {
    const vis = [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"] [data-block="true"]')].filter((b) => b.getBoundingClientRect().width > 0);
    const wrap = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]');
    return JSON.stringify({
      blocks: vis.map((b) => (b.innerText || "").replace(/\n/g, "⏎")),
      blocksRaw: vis.map((b) => b.innerText || ""),
      blocksTotal: document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"] [data-block="true"]').length,
      innerText: wrap ? (wrap.innerText || "").replace(/\n/g, "⏎") : null,
    });
  });
const replyCount = () =>
  ev(() => {
    const a = [...document.querySelectorAll('article[data-testid="tweet"]')].find((e) => e.getBoundingClientRect().width > 0);
    const b = a ? a.querySelector('[data-testid="reply"]') : null;
    return b ? (b.getAttribute("aria-label") || "").trim() : null;
  });
const closeAndDiscard = async () => {
  const cb = await ev(() => {
    const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (!cb) return { closed: false, reason: "no_close_button" };
  await page.mouse.click(cb.x, cb.y, { label: "关闭撰写框" });
  await page.waitForTimeout(1200);
  const sheet = await ev(() => ({
    cancel: [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].filter((e) => e.getBoundingClientRect().width > 0).length,
    save: [...document.querySelectorAll('[data-testid="confirmationSheetConfirm"]')].filter((e) => e.getBoundingClientRect().width > 0).length,
  }));
  let chose = null;
  if (sheet.cancel > 0) {
    const b = await ev(() => {
      const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    await page.mouse.click(b.x, b.y, { label: "放弃草稿" });
    await page.waitForTimeout(1500);
    chose = "confirmationSheetCancel(放弃)";
  }
  return { closed: true, sheet, chose };
};

try {
  await page.goto(TWEET, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3500);
  log("replyCountBefore", await replyCount());

  // 1) 开撰写框（JS click；page.click 会被覆盖层截走）
  await openComposer();
  log("dialogOpened", true);

  // 1b) 对照：真实鼠标点击编辑器是否可行
  try {
    await page.click(EDITOR_SEL, { timeout: 3000, label: "点编辑器" });
    log("realClickEditor", "ok");
  } catch (e) { log("realClickEditor", `failed: ${String(e).slice(0, 120)}`); }

  // 2) 聚焦（程序化 focus；鼠标点击会被 X 的 ScrollSnap-List 层截走）
  log("focus", await focusEditor());

  // 3) 写入第一段
  await page.keyboard.insertText("第一段：ego 侧实测写入。");
  await page.waitForTimeout(400);
  log("afterPara1", JSON.parse(await readback()));

  // 4) 换行：1 次 Enter = 1 个新块（空行 = 2 次）
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  log("afterEnter2", JSON.parse(await readback()));

  // 5) 写入第二段
  await page.keyboard.insertText("第二段：用 [data-block] 回读校验。");
  await page.waitForTimeout(400);
  const finalRb = JSON.parse(await readback());
  log("blocksFinal", finalRb);
  out.readback = finalRb;
  out.writeMethod = "programmatic focus + keyboard.insertText";
  out.newlineMethod = 'keyboard.press("Enter")';

  // 6) 放弃草稿
  log("discard", await closeAndDiscard());
  log("dialogAfterDiscard", await ev(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length));
  log("urlAfterDiscard", await page.url());
  log("replyCountAfter", await replyCount());

  // 7) 复查「没有保存」：重开撰写框，编辑器必须是空的
  await openComposer();
  const recheck = JSON.parse(await readback());
  log("reopenedBlocks", recheck);
  out.notSaved = recheck.blocksRaw.every((b) => b.trim() === "");
  log("notSaved", out.notSaved);
  log("discardAgain", await closeAndDiscard());
  log("finalUrl", await page.url());
  log("blockedClicks", stats.blocked);
} catch (e) { out.err = String(e).slice(0, 400); console.log("ERROR " + out.err); }
out.endedAt = new Date().toISOString();
out.blockedClicks = stats.blocked;
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log("RAW: " + OUT);
try { await space.finish({ keep: [] }); } catch {}
