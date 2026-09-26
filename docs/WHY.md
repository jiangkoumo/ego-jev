# 为什么是「可插拔决策层」，而不是又一个包装

> English summary: this project is not a thin rename of a model call. Three things make it a **layer**,
> and each is recomputable: (1) the decision request itself is ~0.35–0.52 s (median 434 ms over 10
> samples, served by `jev-1.13.0`) while one main-model step is ~1.6–4.5 s; (2) phase instrumentation
> shows the bottleneck has moved *off* the decision and *onto* execution (0.56–0.99 s per step);
> (3) the execution layer is **fail-closed** — stale refs, occlusion, cross-frame hit-test failures and
> dangerous targets all end in **zero dispatches**, never a guessed coordinate. Every number below is
> tied to a source and a recompute command. Unverified boundaries are listed explicitly, and ecosystem
> facts live in [`ECOSYSTEM.md`](ECOSYSTEM.md) instead of being repeated here.

## 一句话

「把每一步交给一个小模型选动作」这件事，别人也能做。差在**层**：观测、执行、退出条件是代码，
判定器是可替换的一层，执行层护栏与判定器解耦。下面的三组数字就是这三件事各自的证据。

**本文只写我们实测过的东西**；没测的一律进「未验证边界」，不做外推。

## 证据① 决策请求延迟：本体一次 ~0.35–0.52 s，主模型一步 1.6–4.5 s

数字：单次决策请求 **352–524 ms（10 次采样，中位 434 ms）**，服务端自报 `jev-1.13.0`；
对照的一次主模型判断是 **1.6–4.5 s**。

出处（都在仓库里，可直接 grep）：

- `SKILL.md`「加速能力」：`实测（2026-09-26, 服务端 jev-1.13.0, 维基百科搜索任务）…决策请求本身约 0.35–0.52s（10 次采样 352–524ms，中位 434ms）`
- `README.md`「为什么需要它」与「省在哪里（实测分解）」：主模型 `kimi-k3` 1.8 s、`minimax-m3` 1.6 s、
  `glm-5.3` 3.2 s、`qwen3.8-max` 3.5 s、`deepseek-v4-pro` 4.5 s
- `CHANGELOG.md` `0.2.0`「更正」：旧文档把「整步 1.0–1.5 s」误写成决策耗时，实测决策请求本身是
  352–524 ms

复算命令：

```bash
# 每次运行都会打印分阶段耗时，看「决策 NNNms」这一段；服务端实际模型也在同一行
ego-decision-layer --url "https://en.wikipedia.org/wiki/Main_Page" --text "Jev" \
  --until "/wiki/Jev" "在顶部搜索框输入并提交"
# 或核对本文引用的原始文字：
grep -n "352" SKILL.md README.md CHANGELOG.md
```

测量纪律：请求里写的是浮动别名，**服务端实际服务哪版只看响应里的 `model` 字段**；
`renderJevSummary` 会把它打印出来（上面的命令会看到）。

**原始数据缺口（如实）**：这 10 次采样的逐条原始行**没有进仓库**——单元测试输出
（`bench/raw/test-*`）在 `.gitignore` 里被当作可再生产物忽略了（忽略注释见 `.gitignore`）。
工作区里能追到的最接近的原始数据是

```
bench/raw/test-p14-phases-2026-09-26T06-50-24-834Z.json
```

它是同名任务的一次 **5 次**采样：`decideMs` = 407 / 524 / 483 / 443 / 425（中位 443 ms，
服务端 `jev-1.13.0`）——量级一致，但**不是同一批**。要更硬的证据，请用上面的命令当下重测并留档。

## 证据② 瓶颈已经不在决策，在执行

数字：单步的大头是**执行（派发 + 稳定等待）0.56–0.99 s**，而不是决策（0.35–0.52 s）。

出处：`SKILL.md`「加速能力」同段；`CHANGELOG.md` `0.2.0`「更正」：
`分阶段数据显示单步的大头是「派发 + 稳定等待」0.56–0.99s，而不是决策（0.35–0.52s）`。

复算：`renderJevSummary` 打印一行
`阶段耗时: 观测 Nms | 决策 Nms | 执行 Nms | 校验 Nms（合计 Nms）`，CLI 每次收尾都会打印它；
同一行也在每个任务的收尾输出里。上面那个 `test-p14-phases` 原始文件里 `phases.executeMs` =
564 / 750 / 663 / 664 / 702，整步合计 990–1292 ms——执行确实是最大一段。

这条对「为什么值得做」很关键：真正省下来的是**决策往返**，但单步耗时的大头现在已经转移到
执行通道，所以后续优化应当看执行而不是继续压决策。

## 证据③ 执行层 fail-closed：四类情况都是 0 次派发

数字：**陈旧 ref、被遮挡（含跨 frame 命中失败）、frame 祖先带缩放/旋转、危险动作**
这四类，一律**不派发任何鼠标事件**（不是「尽量避开」，是断言 `cdp === 0`）。

出处 / 复算（两条都可离线跑，无网络、无凭证；断言里直接查派发次数）：

```bash
node bench/test-guardrails.mjs                      # 39 项：陈旧 / 守卫拒绝 / 危险动作 / 不合格响应
ego-browser nodejs < bench/test-frame-targets.mjs   # 37 项：frame 命中逐层校验、遮挡、transform 拒绝
```

- `bench/test-guardrails.mjs` 的断言包括「守卫拒绝时没有派发鼠标事件」（`page.calls.cdp === 0`）、
  「陈旧决策不执行」、「命中 → 没有派发任何鼠标事件」、「循环 → 始终没有派发」。
- `bench/test-frame-targets.mjs` 在遮挡、宽边框、`transform` 三类场景后断言
  `window.__hit === 0`（frame 内真实 DOM 未被触碰），并保留「未被遮挡时真的点中」的对照
  （`window.__hit === 1`）——不是把命中测试全局关掉。

这两条是可执行断言，跑一次就能自己确认，不需要信本文的叙述。

## 为什么说它是「层」

- **判定器可插拔**：契约 `decide({ state, questions, options }) → { answers, meta }`；默认 System One，
  也能切到本地 / 自建的 OpenAI 兼容端点（`kind: "openai-compatible"`），还用 `options.ask`
  支持注入。
- **执行层与判定器解耦**：换后端不会绕过旧 `ref` 校验、遮挡 / 跨 frame 命中测试、危险动作拦截，
  以及候选合法性校验。
- **退出条件由代码判定**：`--until <substr>` 或脚本里的 `check`，不靠模型自评 `done`。
- **诚实的能力声明**：没有校准置信度的后端（本地文本模型）跳过置信度阈值升级，但**绝不伪造概率**。

细节与用法见 [`../SKILL.md`](../SKILL.md) 与 [`../README.md`](../README.md)；
同类项目与上游的生态事实见 [`ECOSYSTEM.md`](ECOSYSTEM.md)（本文不重复）。

## 未验证边界（不许比证据更强）

- **本地模型后端只有 stub 验证**：`kind: "openai-compatible"` 只用假 `fetch` 测过请求体形状、
  严格 JSON 解析与护栏；**没在真实的本地推理服务上端到端跑过**。
- **跨域 iframe 不处理**：读不到 `contentDocument`，这类树不在观测范围内。
- **frame 祖先带缩放 / 旋转时直接拒绝**（`frame_transformed`；`zoom !== 1` 同样拒绝）：
  这是有意的 fail-closed 取舍，不是「支持了变换后的 frame」——宁可不点，也不猜坐标。
- **危险动作词表是启发式**：命中「支付 / 删除 / 退订」一类目标时不执行并直接停（`dangerous_action`），
  但词表是我们自己拟的中英词表，`remove` / `pay` 这类词可能误伤；`dangerGuard: false` 可整体关闭。
- **真实验证码 / 登录墙未测**：只在合成拦截页上验证过 `blocked` 分支。
- **`--handoff-prompt` 只是指派文本**：它让「派活给子代理」时能显式点名，但不是强制机制，
  也不改变执行成功率；路由触发率来自决策探针（n=5/6、单机单模型、只报计划），不能外推。

## 证据索引

| 数字 / 结论 | 出处 | 复算 |
| --- | --- | --- |
| 决策请求 352–524 ms（中位 434 ms，10 次） | `SKILL.md`「加速能力」、`CHANGELOG.md` 0.2.0「更正」 | 跑一次任务看 `renderJevSummary` 的「决策」段 |
| 主模型一步 1.6–4.5 s | `SKILL.md`、`README.md`「为什么需要它」 | 同上；模型清单逐项列在文中 |
| 执行 0.56–0.99 s（当前瓶颈） | `SKILL.md`、`CHANGELOG.md` 0.2.0「更正」 | `renderJevSummary` 的「执行」段 |
| 四类拒绝 = 0 次派发 | `bench/test-guardrails.mjs`、`bench/test-frame-targets.mjs` | 直接跑这两个测试（断言 `cdp === 0` / `window.__hit === 0`） |
| 路由是否生效 | `--route-status` / `renderJevSummary` 的 `route` 段 | `ego-decision-layer --route-status`（只读 JSON） |
