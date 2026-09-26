// docs/make-social-preview.mjs — 用真实截图 + 我们自己写的标题条合成 GitHub 社交预览图（1280x640）。
//
// 做法：把 docs/demo-frames/frame-02.png（真实运行的最后一帧）作为 data URL 喂进一个本地 HTML，
// 在 1280x640 视口里渲染后截图。不引外部字体/素材，图片走仓库内相对路径。
// 运行（在仓库根）：
//   sed "s|__REPO__|$PWD|g" docs/make-social-preview.mjs | ego-browser nodejs
// 产物：docs/social-preview.png（1280x640）
const REPO_INJECTED = "__REPO__";
const REPO = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { join } = await import("node:path");
const { readFile } = await import("node:fs/promises");

const frame = await readFile(join(REPO, "docs", "demo-frames", "frame-02.png"));
const dataUrl = "data:image/png;base64," + frame.toString("base64");

const space = await taskSpace(`ego-jev-social-${Date.now()}`);
const page = space.page("p1");
try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  await page.evaluate((payload) => {
    document.body.style.margin = "0";
    document.body.innerHTML = `
      <div style="width:1280px;height:640px;box-sizing:border-box;background:#0b0f14;color:#e6edf3;
                  font-family:-apple-system,'PingFang SC','Helvetica Neue',sans-serif;
                  display:flex;align-items:center;gap:44px;padding:56px 60px">
        <div style="flex:0 0 430px">
          <div style="font:800 62px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-1px">ego-jev</div>
          <div style="margin-top:20px;font-size:26px;line-height:1.42;color:#c9d4df">
            用 Jev 把「下一步点哪里」<br>放进单个浏览器进程内闭环
          </div>
          <div style="margin-top:26px;font-size:19px;line-height:1.6;color:#8b98a5">
            决策请求 0.35–0.52s · 观测一次 evaluate<br>动作裸 CDP · 代码判定退出
          </div>
          <div style="margin-top:32px;font-size:17px;color:#5b6673">
            真实运行录屏 · Hacker News 两步导航
          </div>
        </div>
        <img id="shot" style="flex:1 1 auto;min-width:0;max-width:720px;border:1px solid #232c36;
                              border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.55)">
      </div>`;
    document.getElementById("shot").src = payload.dataUrl;
  }, { dataUrl });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(REPO, "docs", "social-preview.png") });
  try { await page.cdp("Emulation.clearDeviceMetricsOverride", {}); } catch { /* 清理失败不影响产物 */ }
  console.log("wrote docs/social-preview.png");
} catch (e) {
  console.log("ERROR " + String(e).slice(0, 300));
  process.exitCode = 1;
} finally {
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}
