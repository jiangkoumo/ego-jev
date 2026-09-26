# docs/ —— demo 素材（全部由真实运行产生）

这些素材不是手绘界面：帧、GIF、MP4、社交预览图都来自 `ego-browser` 里一次**真实**的
Jev 决策运行（仓库既有基准任务：hacker news 首页 → `new` → `comments`）。重做步骤：

## 1. 录帧（需要 ego-browser + Jev 凭证 + 网络）

```bash
cd <仓库根>
sed "s|__REPO__|$PWD|g" docs/capture-demo.mjs | ego-browser nodejs
```

脚本自己驱动 `runJevStep`：每一步动作后往页面注入一条说明条（文案取自**真实**的
`result.action` / `result.targetLabel`，不是写死「成功」），再截图到 `docs/demo-frames/frame-NN.png`
（`frame-00` 是初始页）。同时写 `docs/demo-frames/trace.json`，里面是真实 trace 与最终 URL。
视口固定 960×600，所以帧宽不会超过 960。

## 2. 合成 GIF / MP4（ffmpeg）

```bash
FF=/opt/homebrew/bin/ffmpeg
"$FF" -y -framerate 1/1.4 -i docs/demo-frames/frame-%02d.png \
  -vf "split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  -loop 0 docs/demo.gif
"$FF" -y -framerate 1/1.4 -i docs/demo-frames/frame-%02d.png \
  -vf "format=yuv420p" -r 30 -movflags +faststart docs/demo.mp4
```

GIF：960 宽、每帧 1.4s、循环。MP4：同样 960 宽、4.2s。

## 3. 社交预览图（1280×640）

```bash
sed "s|__REPO__|$PWD|g" docs/make-social-preview.mjs | ego-browser nodejs
```

把真实最后一帧作为 data URL 喂进本地 HTML，加我们自己的标题条，在 1280×640 视口里渲染后截图。

## 4. 横幅

`docs/banner.svg` 是手写 SVG（自包含，不引外部字体或素材）。

## 文件

| 文件 | 说明 |
| --- | --- |
| `banner.svg` | README 顶部横幅（手写 SVG） |
| `capture-demo.mjs` | 录帧脚本（真实运行，输出到 `demo-frames/`） |
| `demo-frames/frame-*.png` | 真实截图（初始 + 每步动作后） |
| `demo-frames/trace.json` | 真实 trace（步骤、动作、目标、URL） |
| `demo.gif` / `demo.mp4` | 由上面的帧合成 |
| `make-social-preview.mjs` | 社交预览图脚本（1280×640） |
| `social-preview.png` | GitHub 社交预览图 |
