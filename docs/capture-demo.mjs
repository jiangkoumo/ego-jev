// docs/capture-demo.mjs — 录一次真实的 2 步任务，每一步动作后截一张图到 docs/demo-frames/。
//
// 为什么这么做：README 里的 demo 必须是**真实运行**产生的，不是手绘界面。这个脚本在
// `ego-browser nodejs` 里跑真实 Jev 决策（hacker news 首页 → new → comments，仓库既有基准任务），
// 每步动作后往页面注入一条我们自己的说明条（内容取自真实的 result，不是写死「成功」），再截图。
//
// 前置条件：ego-browser 已安装；Jev 凭证存在（~/.config/typesafe/api_key，见 SKILL.md）；
//           能访问 https://news.ycombinator.com。
// 运行（在仓库根）：
//   sed "s|__REPO__|$PWD|g" docs/capture-demo.mjs | ego-browser nodejs
// 产物：docs/demo-frames/frame-00.png（初始）、frame-01.png、frame-02.png… 与 trace.json
//
// 合成 GIF/MP4 见 docs/README.md。
const REPO_INJECTED = "__REPO__";
const REPO = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { join } = await import("node:path");
const { mkdir, writeFile } = await import("node:fs/promises");
const { runJevStep, loadApiKey } = await import(join(REPO, "scripts", "ego-jev.mjs"));

const FRAMES = join(REPO, "docs", "demo-frames");
await mkdir(FRAMES, { recursive: true });

const key = loadApiKey();
if (!key) {
  console.log("SKIP: 未找到 Jev 凭证（~/.config/typesafe/api_key），无法录 demo");
  process.exit(0);
}

const space = await taskSpace(`ego-jev-demo-${Date.now()}`);
const page = space.page("p1");
const trace = [];
try {
  await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(900);
  // 固定成 960 宽视口，GIF 才不会超宽（<= 960）
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 960, height: 600, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(300);

  // 注入我们自己的说明条（固定定位；文案由真实 trace 传进来，不写死「成功」）
  const shot = async (index, text) => {
    await page.evaluate((payload) => {
      const old = document.getElementById("ego-jev-caption");
      if (old) old.remove();
      const bar = document.createElement("div");
      bar.id = "ego-jev-caption";
      bar.textContent = payload.text;
      bar.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#0b0f14;color:#e6edf3;" +
        "font:600 22px/1.45 -apple-system,'PingFang SC','Helvetica Neue',sans-serif;padding:14px 20px;" +
        "box-shadow:0 -2px 12px rgba(0,0,0,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      document.body.appendChild(bar);
    }, { text });
    await page.waitForTimeout(150);
    const file = join(FRAMES, `frame-${String(index).padStart(2, "0")}.png`);
    await page.screenshot({ path: file });
    return file;
  };

  await shot(0, "Hacker News 首页 · 目标：先开 new，再开 comments");

  const goal = "先打开 new 页面，再打开 comments 页面";
  const progress = [];
  let done = false;
  for (let step = 1; step <= 6; step++) {
    const result = await runJevStep(page, goal, { apiKey: key, progress, maxText: 2000 });
    const label = result.targetLabel || result.target || "";
    trace.push({ step, action: result.action, target: label, changed: result.changed, urlAfter: result.urlAfter, reason: result.reason || null });
    // 说明条用真实结果里的短名（引号里的名称），不写死文案
    const quoted = (label.match(/"([^"]*)"/) || [])[1];
    const short = quoted ? `"${quoted}"` : label;
    await shot(step, `第 ${step} 步 · Jev 决策：${result.action}${short ? " " + short : ""}`);
    if (result.reason === "no_targets") { await page.waitForTimeout(700); continue; }
    if (result.error || result.blocked || result.isDone) break;
    progress.push(`${result.action} ${label}`.trim());
    if ((await page.url()).includes("/newcomments")) { done = true; break; }
  }

  try { await page.cdp("Emulation.clearDeviceMetricsOverride", {}); } catch { /* 清理失败不影响素材 */ }
  const finalUrl = await page.url();
  await writeFile(join(FRAMES, "trace.json"), JSON.stringify({ goal, done, finalUrl, trace }, null, 2));
  console.log(JSON.stringify({ done, finalUrl, frames: trace.length + 1, trace }, null, 2));
} catch (e) {
  console.log("ERROR " + String(e).slice(0, 300));
  process.exitCode = 1;
} finally {
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}
