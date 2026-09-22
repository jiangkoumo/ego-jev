// 逐字执行 `~/.agents/skills/x-trending-reply/SKILL.md` 步骤 4 里那段代码，验证文档里的代码本身可跑。
// 与文档的差异只有两处（均为验收所需的脚手架，不改动被测量的路径）：
//   ① tweetUrl 的占位符换成真实帖子；
//   ② 在 space.page("p1") 外面包一层「提交/互动按钮 CDP 拦截」+ 在 finally 之前插入验收断言。
const { writeFile } = await import("node:fs/promises");

// ── 脚手架：提交/保存/点赞/转发/关注一律不派发（红线） ──
const BLOCK = new Set(["tweetButton", "tweetButtonInline", "confirmationSheetConfirm", "like", "unlike", "retweet", "repost", "bookmark", "follow", "share"]);
const blocked = [];
const guard = (raw) =>
  new Proxy(raw, {
    get(t, p) {
      if (p === "cdp") {
        return async (method, params) => {
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            try {
              const hit = await t.evaluate(({ x, y }) => {
                const el = document.elementFromPoint(x, y);
                const n = el?.closest("[data-testid]");
                return n ? `${n.getAttribute("data-testid") || ""}|${n.getAttribute("aria-label") || ""}` : "";
              }, { x: params.x, y: params.y });
              if (BLOCK.has(String(hit).split("|")[0])) { blocked.push(hit); console.log(`  ⛔ 拦截: ${hit}`); return { blocked: true }; }
            } catch { /* 导航中 */ }
          }
          return t.cdp(method, params);
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });

const space = await taskSpace(`x-reply-${Date.now()}`);
const page = guard(space.page("p1"));
const ev = (fn, ...rest) => (rest.length ? page.evaluate(fn, rest[0]) : page.evaluate(fn));
const tweetUrl = "https://x.com/NFT_Chen/status/2102297992179200329";
const REPLY_SEL = 'article[data-testid="tweet"] button[data-testid="reply"]';
const EDITOR_SEL = '[role="dialog"] [data-testid="tweetTextarea_0"][contenteditable="true"]';
const readBlocks = () => ev(() => JSON.stringify(
  [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"] [data-block="true"]')]
    .filter((b) => b.getBoundingClientRect().width > 0)
    .map((b) => (b.innerText || "").replace(/\n/g, "⏎"))
));
const replyCount = () => ev(() => {
  const a = [...document.querySelectorAll('article[data-testid="tweet"]')].find((e) => e.getBoundingClientRect().width > 0);
  const b = a ? a.querySelector('[data-testid="reply"]') : null;
  return b ? (b.getAttribute("aria-label") || "").trim() : null;
});
const result = { tweetUrl, blocked, steps: [] };
const log = (k, v) => { result.steps.push({ k, v }); console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
try {
  const before = await replyCount();
  log("replyCountBefore", before);

  // ── 以下到 finally 之前，是 SKILL.md 步骤 4 的代码（逐字） ──
  try {
    try { await page.goto(tweetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch {}

    await page.waitForSelector(REPLY_SEL, { timeout: 25000 });
    await ev((s) => {
      const b = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().width > 0);
      if (b) b.click();
    }, REPLY_SEL);
    await page.waitForSelector('[role="dialog"] [data-testid="tweetTextarea_0"]', { timeout: 20000, state: "visible" });
    await page.waitForTimeout(1200);

    await page.click(EDITOR_SEL, { label: "聚焦撰写框" });
    const focused = await ev(() => document.activeElement?.getAttribute("contenteditable") === "true");
    if (!focused) throw new Error("编辑器没拿到焦点，先停下重新观察，不要盲打");
    log("focused", focused);

    await page.keyboard.insertText("第一段：直接切入真实细节。");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("第二段：抛一个对方会有话聊的问题。");

    log("readBlocks", await readBlocks());

    const closeBox = await ev(() => {
      const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (closeBox) await page.mouse.click(closeBox.x, closeBox.y, { label: "关闭撰写框" });
    await page.waitForTimeout(1000);
    const cancelBox = await ev(() => {
      const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    log("discardSheetFound", Boolean(cancelBox));
    if (cancelBox) await page.mouse.click(cancelBox.x, cancelBox.y, { label: "放弃草稿" });
    await page.waitForTimeout(1200);
    // ── 文档代码结束 ──

    // 验收断言（脚手架）
    log("dialogClosed", await ev(() => [...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"]')].filter((e) => e.getBoundingClientRect().width > 0).length === 0));
    log("urlUnchanged", (await page.url()) === tweetUrl);
    log("replyCountAfter", await replyCount());
    // 重开确认「没保存」：编辑器必须是空的
    await page.waitForSelector(REPLY_SEL, { timeout: 25000 });
    await ev((s) => {
      const b = [...document.querySelectorAll(s)].find((x) => x.getBoundingClientRect().width > 0);
      if (b) b.click();
    }, REPLY_SEL);
    await page.waitForSelector('[role="dialog"] [data-testid="tweetTextarea_0"]', { timeout: 20000, state: "visible" });
    await page.waitForTimeout(1200);
    const reopened = await ev(() => JSON.stringify([...document.querySelectorAll('[role="dialog"] [data-testid="tweetTextarea_0"] [data-block="true"]')]
      .filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.innerText || "")));
    log("reopenedBlocksRaw", reopened);
    log("notSaved", JSON.parse(reopened).every((b) => b.trim() === ""));
    const cb2 = await ev(() => {
      const el = [...document.querySelectorAll('[role="dialog"] [data-testid="app-bar-close"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (cb2) await page.mouse.click(cb2.x, cb2.y, { label: "关闭撰写框" });
    await page.waitForTimeout(800);
    const c2 = await ev(() => {
      const el = [...document.querySelectorAll('[data-testid="confirmationSheetCancel"]')].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (c2) await page.mouse.click(c2.x, c2.y, { label: "放弃草稿" });
  } finally {
    // 文档里这里是 space.finish({keep: []})；断言已在上面跑完
  }
} catch (e) { result.err = String(e).slice(0, 300); console.log("ERROR " + result.err); }
log("blockedClicks", blocked);
await (await import("node:fs/promises")).mkdir("/tmp/ego-switch", { recursive: true });
await writeFile("/tmp/ego-switch/skill-step4-run.json", JSON.stringify(result, null, 2));
try { await space.finish({ keep: [] }); } catch {}
