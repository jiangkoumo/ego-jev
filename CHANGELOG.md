# 更新日志

版本号只有一个来源：`SKILL.md` frontmatter 里的 `metadata.version`。本文件顶部条目、
`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` 都必须与它一致；
改版本后跑 `node bench/test-release-consistency.mjs`。

每个版本按 **新增 / 修复 / 更正 / 未验证** 分组。「更正」记的是被实测推翻的旧结论，
不是新功能；「未验证」如实列出还没测过的边界。

## 0.3.1 — 2026-09-26

### 修复

- **`--restore` 会被下一次 CLI 运行静默撤销**：`--ensure`（CLI 首跑接管）只认「有启用标记」与
  「检测到官方入口」，没有「用户已明确选择不接管」的持久状态。于是 `--restore` 清掉标记后，
  下次跑 `ego-jev` 又会把入口接管回去（只打一行提示）——**用户的显式决定被自动流程反转**。
  现在 `--restore` 会写一个持久化的 opt-out 标记（`~/.config/ego-jev/opted-out`，内容确定性，
  无时间戳/随机数），`--ensure` 见到它直接退出、什么都不做（连官方入口都不探测）。
- **opt-out 状态下的诊断文案自相矛盾**：明明是「已按用户选择不接管」，末行仍打印
  「所有 ego-browser 入口都已接管且最新」。现在该状态打印「按你的选择未接管任何入口
  （重新启用命令见上）」；已接管状态与漂移状态的文案不变。

### 更正

- **`--restore` 现在是粘性的**：它不再只是「这一次还原」，而是「以后也别自动接管」。
  重新启用必须用**显式动作**：`bash scripts/wire-agent-skills.sh`（或 `./install.sh` 的接管步骤）
  会清掉 opt-out 标记并恢复接管；自动路径（`--ensure` / `--if-enabled`）永远不解除它。

### 新增

- `--status-json` / `ego-jev --route-status` 增加 `optedOut` 字段；`--check` 在 opt-out 状态下
  输出「已按用户选择不接管」并 **exit 0**（这是健康状态，不是漂移）。
  「没有 opt-out 的普通未接管」仍按既有语义 `exit 1`（回归保护已加进测试）。

### 未验证

- 同 0.3.0：hooks 方案未做、路由触发率未量化、个人作用域技能在 Cowork / 云会话不加载未实测。

## 0.3.0 — 2026-09-26

> **破坏性变更（安装默认行为）**：`./install.sh` 现在**默认**接管官方 `ego-browser` 入口；
> `ego-jev` CLI 首次运行也会在检测到官方入口时接管一次。想退回旧行为：安装加 `--no-wire`，
> 或随时 `bash scripts/wire-agent-skills.sh --restore`（把入口还原成官方软链，并移除所有 always-on 块）。

### 新增

- **首装就默认接管**：`install.sh` 默认执行接管（`--wire` 仍接受，视为显式启用；`--no-wire` 跳过）。
  接管失败时安装仍然成功（提示原因 + 明确说 CLI 仍可用），只有显式 `--wire` 才让安装退出非零。
- **CLI 首跑一次性接管**：`scripts/ego-jev` 跑任务前看一眼官方入口——已接管过就静默刷新；
  没接管过但检测到官方入口，就首跑接管一次并打印一行说明（含 `--restore` 还原命令）；
  两者都不是则什么都不做（不建目录、不打噪音）。`EGO_JEV_NO_WIRE=1` 整体关闭（旧名
  `EGO_JEV_NO_HEAL=1` 仍接受）。这步任何失败只降级为一行提示，**不改变任务的退出码**。
- **`--check` 给出结论而不是「跳过」**：没有官方入口的目录明确写「无需接管（没有官方
  `ego-browser` 入口；该 Agent 通过自身的 ego-jev 技能被发现）」，并汇总
  **已接管 N / 无需接管 M / 漂移 K**；有漂移仍 exit 1。`--check` 保持只读（连 mtime 都不变）。
- **always-on 路由块（显式开关，默认不写任何用户文件）**：
  `bash scripts/wire-agent-skills.sh --always-on <file>` 向指定文件插入一段带标记的说明块
  （`<!-- ego-jev:route begin -->` … `end`），幂等、可 `--restore` 精确移除，首次写入前备份到
  同目录 `.bak`。适合放在项目 `AGENTS.md` 或 `~/.claude/CLAUDE.md`：让 Agent 在读任何技能之前
  就知道「多步线性浏览器任务先走 ego-jev」。
- **路由可审计**：新增只读命令 `scripts/ego-jev --route-status`，输出机器可读 JSON
  （`enabled` / `dirs[]` / `summary{n,m,k}` / `alwaysOn[]` / `vendor` / `generatedHash`），
  不起浏览器、不需要凭证、不建 TaskSpace。同一份信息作为 `route` 段写进 CLI 的结果 JSON，
  `renderJevSummary` 也带一行（`路由: 已接管 2 / 无需 1 / 漂移 0 · always-on 1`）。
- **`--restore` 一次清两样**：同时把接管层还原成官方软链、并移除所有已记录的 always-on 块。

### 修复

- `--check` 对「目录里没有官方入口」只打一行「跳过」，用户看不出结论；现在给出明确结论与原因。
- CLI 自愈只在**已有启用标记**时才动手，导致「装完但从未接管」的机器永远不会走 ego-jev；
  现在首跑接管。

### 更正

- 旧文档把 `--wire` 写成可选的「顺便」动作，实际效果是多数用户装完仍走官方正文；
  0.3.0 起默认接管，`--no-wire` 才是显式跳过。

### 未验证

- **hooks 方案没做**：`SessionStart` / `UserPromptSubmit` 注入 `additionalContext` 是唯一
  「必须发生」的强制层，但它要写用户的 Agent settings；本轮只文档说明，不自动改用户设置。
- **路由触发率没有量化**：没有测「Agent 实际走 ego-jev 的比例」（需要另一套 grader）。
- **always-on 的覆盖边界如实记录**：个人作用域技能在 Cowork / 云会话里不加载，always-on 那行
  一样受会话类型限制；它只影响读这个文件的 Agent。

## 0.2.0 — 2026-09-26

> 本次把 `SKILL.md` 里从未发布过的 `1.0.0` 占位对齐到实际发布线 `0.2.0`。`1.0.0` 从未打过 tag、
> 也从未发布，而项目仍有公开已知边界（跨域 iframe 不处理、危险词表是启发式、真实验证码站未测），
> 宣称 1.x 属过度声明。此后版本号只从 `SKILL.md` 读。

### 新增

- **元素表补全：无 role 的容器型可点元素**。`<div onclick>` 卡片/行、`tabindex` 区块、
  `cursor:pointer` 块级容器补成 `clickable-region`（映射到既有 `kind: clickable`，问题层与执行层未改）。
  a11y 元素优先占预算；嵌套容器只收最内层；被占满的容器、`<a href>` 里的容器、`<label for>`
  都不与 a11y 元素双收。实测 YouTube 首页 3 个、X 首页 5 个；真实 Jev 能选中它
  （YouTube 视频元数据块 → `/watch`，见 `bench/test-realjev-region.mjs`）。
- **跨 frame / shadow 观测**。观测根扩到主文档 + 同源 iframe 文档 + 开放 shadow root；
  shadow host 的发现改成惰性遍历并跨 root 公平推进（旧实现只看主文档前 2000 个节点，
  靠后的 shadow root 永远进不了观测根）。
- **跨 frame 派发的 fail-closed 守卫**。逐层命中校验：每层把点换算到该层坐标系（含
  `clientLeft/clientTop`），断言该层 `elementFromPoint` 严格命中承载下一层的 `<iframe>` 自身；
  任一层不成立即 `covered`。`defaultView` 为 null / frame 链断 → `frame_unresolved`；
  frame 元素到文档根的祖先链上有非 identity 的 2D 线性变换（scale/rotate/skew）或 `zoom !== 1`
  → `frame_transformed`（纯平移、`translateZ(0)` 放行）。全部 0 次 CDP 派发，
  不再退化成 `{0,0}` 后盲点。
- **判定器可注入（`options.ask`）+ 离线端到端自测**。`options.ask` 与引擎自己的 `askJev` 同签名
  （state 文本 + questions 对象）。新增 `bench/test-offline-e2e.mjs`：在 `about:blank` 上注入 DOM，
  用注入判定器跑「真实观测 → 真实 `locate` → 裸 CDP 派发 → 真实 DOM 断言」，不联网、不需要凭证，
  并断言整个用例一次 `fetch` 都没发。
- **服务端实际模型版本 + 分阶段耗时**。`askJev` 把响应里的 `model` / `usage` 带回（`receipt` 载体），
  每步产出 `phases`（观测 / 决策 / 执行 / 校验）并累计到循环；新增导出 `renderJevSummary`，
  CLI 收尾打印这张表。请求里写的是浮动别名 `jev-latest`，服务端实际服务哪个版本只有响应的
  `model` 字段能回答。
- **危险动作前置拦截**。目标名称 / 选项文本命中「支付 / 删除 / 退订」词表（中文 + 英文，我们自己的）
  时不执行，记 `guardRejected=dangerous_action` 并直接停（不重试）；`dangerGuard: false` 可整体关闭。
- **凭证查找链 + 后端可降级**。查找顺序：`--api-key` > `TYPESAFE_API_KEY`（仅普通 node 可见）>
  `TYPESAFE_API_KEY_FILE` > `~/.config/ego-jev/credentials` > `~/.config/typesafe/api_key` >
  rc 文件（`~/.zshrc` / `~/.bashrc` / `~/.bash_profile` / `~/.profile`）里的
  `export TYPESAFE_API_KEY=…`——全部是文件，因为 ego 运行时拿不到父进程环境变量。
  后端地址 `TYPESAFE_BASE_URL` 可覆盖；主后端失败时的降级端点 `TYPESAFE_FALLBACK_BASE_URL`
  （不设即不降级，`fallback: false` 可关）；这两个变量由 CLI 在父进程读取后写进配置传给子进程。
- **原生下拉二次决策**。观测时选中的 option 到执行时可能已经不在 DOM 的 options 里；
  旧实现把它当失败 / 无进展，最后 `stuck`。现在改为**一次**带新选项的重问
  （`maxOptionRetries` 默认 1），重问仍失败才显式报 `stuck`。

### 修复

- **跨 frame 父层命中校验过宽**：旧判定接受 iframe 的祖先（`hit.contains(fe)`），于是 iframe 设
  `pointer-events:none`、外面套一个可点击 wrapper 时，校验通过而 CDP 点到 wrapper，代码却记执行成功。
  改为严格命中 iframe 自身（iframe 没有可命中的后代，放宽从来不需要）。
- **只查 frame 自身 transform**：祖先 `scale` / `rotate` / `skew` 会让 frame 内坐标换算失真，
  点击可能落到别处而放大的 iframe 仍满足命中测试。改为沿祖先链逐个检查 2D 线性部分与 `zoom`
  （解析 `matrix` / `matrix3d`），纯平移与 `translateZ(0)` 放行。
- **`TREE_SCAN_CAP` 声明与实现不一致**：注释说它是「所有 root 的合计上限」，但保底配额让最坏上界
  变成 `8000 + 31×2000`。改成跨 root 轮转（与 region 扫描同款），上限成为硬约束。
- **frame × shadow 组合恒被误拒**：frame 内 shadow root 里的元素，命中测试用的是 frame 的
  `Document.elementFromPoint`（只返回 shadow host），身份对不上，恒判 `covered`。改用元素自己的 root。

### 更正

- **决策延迟口径**：旧文档写「单步决策约 1.0–1.5s」，实测那其实是**整步耗时**；
  决策请求本身 352–524ms（10 次采样，中位 434ms）。整步 1.0–1.4s。
- **当前瓶颈在执行**：分阶段数据显示单步的大头是「派发 + 稳定等待」0.56–0.99s，
  而不是决策（0.35–0.52s）。旧说法「省的是决策往返」仍然成立（决策比大模型快），
  但单步耗时的大头已经不在决策那一段。
- **维基语言选择器旧基线失效**：`www.wikipedia.org` 上那个 77 项的 `#searchLanguage` 现在是
  `opacity:0`（被自定义语言列表 UI 取代），引擎按可见性规则跳过它——旧「约 2/3 成功」的基线
  无法在原元素上复现。同类「原生下拉改选」在 DuckDuckGo 设置页语言下拉实测 6/6
  （`bench/test-native-select.mjs`）。

### 未验证

- **跨域 iframe 不处理**：读不到 `contentDocument`，这类树不在观测范围内。
- **frame 祖先带缩放 / 旋转时直接拒绝**：这是有意的 fail-closed 取舍，不是「支持变换后的 frame」。
  宁可拒绝也不猜坐标。
- **危险词表是启发式**：`remove` / `pay` 这类词可能误伤；站点改版后词表可能要调。
- **降级路径默认关闭，且没有真实第二后端验证**：只用假端点验证了机制本身。
- **真实验证码 / 登录墙未测**：只在合成拦截页上验证过 `blocked` 分支。

## 0.1.0 — 2026-09-22

首个带 tag 的发布（release 标题「引擎重建 + 一键更新」）。

### 新增

- 按剖析结果重建引擎：观测改成一次 `page.evaluate` 自建 DOM 元素表（约 2ms，替代 110–130ms 的
  `page.snapshot()`），动作改成裸 CDP `Input.dispatchMouseEvent`（13–16ms，替代 788–1005ms 的
  `page.click`），等待改成可观察条件。HN 两步导航端到端 4569ms → 1675ms。
- 响应校验、执行期守卫、滚动感知的进展判定、按码点截断（emoji 安全）。
- `update.sh` 一键更新，并在 README 记录。

### 更正

- 撤回「X 等虚拟化站点不可用」的警告：那个 0/15 是用有缺陷的 harness 测出来的
  （锚点在另一次页面加载里测量），不是引擎能力问题。
