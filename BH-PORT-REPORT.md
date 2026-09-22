# 结论：把 bh 的「滚动算进展」搬进 ego-jev 后，X 上必须连滚 >3 次的深帖任务从 **0/6 变 6/6**（累计滚动 5–9 步、同动作最长连续 5–6 次，不再被 `stuck` 中止）、X 合计 14/20→18/18，emoji 截断改为按码点后本地边界用例 21/21 且 X 上 34 次运行 0 次 Jev 400，hn-nav/wiki-search/select-native 配对 bootstrap CI 全部跨 0，无回归。

被测 revision：final `3e8c77a`（引擎 md5 `d6f38705d1ba892ebeb691d040569a3a`）＝ `afe315a`（md5 `ee62dc5e5d81ac908834996a1ea65bf3`）+ 审阅后的滚轮兜底基线修补；X/无回归两套数据在 `ee62dc5e` 上采集，final 引擎另跑了 x-far 复核（该修补只影响滚轮兜底分支，X 的滚动全部走直连分支，`滚动=动了`）。改动前 = HEAD `e29c3a9`（md5 `9b760682cebac9fdde7d4172639a928a`，冻结为 `bench/scroll-baseline-engine.mjs`）。下面每个数字都由 `node bench/bh-port-summary.mjs` 从 `bench/raw/` 原始文件重算，不是手抄。

## P0-1 滚动感知的进展判定（依据：REVEAL-REPORT ①②③——0/15、`stuck` 12 次、B 的 `fingerprint()` 含 scroll）
实现：进展 = URL/导航变化 **或** 滚动动作真的移动了视口（`scrollMoved`，动作后实测；退回鼠标滚轮时以「派发滚轮前那一刻」的 `scrolled.y` 为基线再读一次 `scrollY`）**或** 上一步是滚动且本轮观测露出新元素（`newTargetCount`，观测层本来就在算）。有界性没放开：到页面边界后视口不再移动、也不再露新元素，`sameActionStreak` 照常累加到 `maxSameAction` 停止，`maxSteps` 仍是硬上限——`bench/test-scroll-progress.mjs` 27/27（[2] 边界必须停、[5] 滚入不成环、[7] 陈旧基线不得被当成进展）。

| 任务（目标深度） | old | new | 新引擎 滚动步 / 最长同动作 |
| --- | --- | --- | --- |
| x-control（首屏） | 6/6 | 6/6 | 0 / 1 |
| x-below（1.2–4 屏） | 6/6 | 5/5 | 1–4 / ≤2 |
| x-deep（>1.8 屏） | 2/2 | 1/1 | 4 / 2 |
| **x-far（>2.5 屏，必须连滚 >3 次）** | **0/6（6×`stuck`）** | **6/6** | **5,9,6,5,6,7 / 5,5,6,5,6,5** |
| **X 合计** | **14/20** | **18/18** | — |

`bench/x-scroll-pair.js`：4 任务 × 2 引擎 × 6 轮，配对、奇偶轮翻转先后、只读互锁拦截 0 次；失败原因分布 old `{stuck:6}` / new `{}`。final 引擎复核（`x-scroll-pair-postreview-*`，x-far × 3 轮）：old 0/3（3×`stuck`）→ new 3/3。

**「相对 0/15」必须说清**：用产出 0/15 的那个 harness（`reveal-tasks.js`）原样只换引擎，新引擎仍是 **0/7（7×`max_steps_reached`）**。原因是该 harness 一轮里先测锚点、跑任务前再 `goto` 一次，而 X 时间线每次加载内容都变，测到的帖子在开跑那次加载里往往已不存在：`bench/x-one-step.js` 证明**同一次加载**里目标在元素表内、Jev 以 0.99/0.99/0.99 置信度点中它；`bench/x-diagnose.js` 证明重新加载后 state 里没有该帖，Jev 只能一路滚。故 0/15 不是有效基线，有效对照是上表的配对数据（已记入未解决项 1）。

## 补充方向 A（先滚入视口再动作）：已实现，但 X 上未被触发
按官方 SKILL.md:241（`/Applications/ego lite.app/…/0.5.0.32|0.5.1.11/Resources/ego-skills/ego-browser/SKILL.md`，两侧已核对）补回「动作自动滚入视口」：命中测试报 `offscreen` 时用代码持有的 DOM 身份 `scrollIntoView`，**重新命中**后才派发（每步最多一次）。单测证明机制成立（`test-scroll-progress.mjs` [4][5]），但 X 的 18 次运行 `intoViewCount` 合计 **0**——X 的卡点不是够不到（目标在元素表第 40/60 项），而是「目标不在这次加载里」，所以 X 的收益全部来自 P0-1。B（表纳入视口外元素）与 C（站点级批量抽取）未做：B 与「不许调大 `maxTargets`」冲突且无触发证据；C 是站点专用工具、不属引擎层，且本次目标都在 60 项表内。

## P0-2 emoji 安全截断（依据：REVEAL-REPORT ④——X 235 项里 5 项命中、整轮 `action_failed`）
所有截断点改为按码点（元素 name/value、下拉选项、可见文本、快照路径、`enrichTargets` 的 options/liveValue/label），并在 `askJev` 对 state/questions 做最后一道孤立代理清理。验收：`bench/test-emoji-clip.mjs` **21/21**（含「旧 `slice(0,60)` 在同一输入上确实切出孤立代理」的对照，证明用例真卡在边界上）；X 只读侧 `bench/x-emoji-audit.js` 3/3 探针孤立代理 0、UTF-8 往返无损（其中 2/3 的 state 里确实出现了 emoji）；X 上新引擎 **34 次运行 0 次 `harness_error`/`action_failed`**（400 会落在其中）。

## 无回归（`bench/scroll-noregress.js`，6 轮配对，d = 新−旧）

| 任务 | old | new | 中位差 | bootstrap 95% CI（10000 次，种子 20260922） | 跨 0 |
| --- | --- | --- | --- | --- | --- |
| hn-nav | 6/6 | 6/6 | −6ms | [−576, 186] | 是 |
| wiki-search | 6/6 | 6/6 | −900ms | [−1228, 217] | 是 |
| select-native | 6/6 | 6/6 | −13ms | [−270, 509] | 是 |

延迟导航 `bench/delayed-nav.js` new-observable **3/3**（orig-legacy 0/3 与改动前完全一致，那是未改动的基线引擎）；`bench/test-guardrails.mjs` **23/23**；仓库冒烟测试 exit 0 且 `"success": true`；`./examples/bench/run-pair.sh A` exit 0 `success:true`。

## P1：三项都「有数据支持不改」
* 表单路径（bh 快 5.4%）：VERIFY-REPORT 的 100 轮预登记配对里 httpbin-form 的 CI = [−587, +859] 跨 0，已判「无差异」——不构成改动依据。
* 揭示触发太窄：新引擎 18 次 X 运行揭示 **0** 次（旧引擎 1 次且随后 `stuck`）。滚动本身已能露出并点中目标，无证据表明放宽触发条件有收益。
* 未移植项（截图/录制、250 项动作上限、`recent_actions` 原始形状）：无可测依据——X 上 0.99 置信度的决策只用 60 项元素表 + 2500 字符可见文本；元素表本就限 60（内部候选 240），250 上限不适用；已完成步骤已由 `progress` 回填。

## 未解决 / 限制
1. REVEAL-REPORT 的 0/15 不能当基线（harness 缺陷，见上），本报告用配对数据替代，未重跑旧 harness 的 15 轮。
2. `SKILL.md`（commit b88f307）仍写着 X 是「known non-starter」，与新数据矛盾；未改（超出工单范围）。
3. x-deep 锚点稀缺：X 首屏常只渲染 3 条，6 轮里两臂各只测到 1–2 轮，n 很小；有量的证据在 x-far。
4. Jev 若在页面边界交替上/下滚，仍会跑到 `maxSteps`（有界但不算漂亮），本次未观察到。
5. `bench/raw/x-scroll-dryrun*` 是 1 轮 harness 校验，不计入任何报告数字。
6. fresh-context 只读审阅（`reviewer`）的 2 条意见已核实并修复：① 滚轮兜底的 `scrollMoved` 基线用了观测时的 `scrollInfo.y`（隔着一次 Jev 请求，可能把页面自己滚动误判成本次滚动有进展）→ 改用紧邻滚轮的 `scrolled.y`，并补 [7] 回归用例；② 报告原写「最长连续滚动 5–9 次」实为累计步数（同动作最长 5–6），已改。审阅未发现阻断项。

## 复现
```
node bench/bh-port-summary.mjs                    # 报告里每个数字 → 原始文件
node bench/test-scroll-progress.mjs               # 27/27（无需浏览器）
node bench/test-guardrails.mjs                    # 23/23
ego-browser nodejs < bench/test-emoji-clip.mjs    # 21/21
ego-browser nodejs < bench/scroll-noregress.js    # 无回归配对（需 8099 上的 /tmp/ego-jev-nav 静态服务）
ego-browser nodejs < bench/x-scroll-pair.js       # X 配对（严格只读）
```
原始数据：`bench/raw/` 下 `x-scroll-pair-*`（含 `-postreview-*`）、`x-frozen-new-*`、`x-one-step-*`、`x-diagnose-*`、`x-emoji-audit-*`、`scroll-noregress-*`、`delayed-nav-2026-09-22T09-02-33-690Z.json`、`test-emoji-clip-*`、`test-scroll-progress-*`、`test-guardrails-2026-09-22T09-22-25.txt`。
