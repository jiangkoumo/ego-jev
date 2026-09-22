# 结论：默认浏览器栈已切回 ego——5 个文件里「默认走 bh」的指引全部改成 ego（bh 保留为备用），两个技能改用 ego-browser 真实 API 并实测通过（TL1 抓到 50 条候选、Draft.js 能写入且按 `[data-block]` 回读、CNKI 拿到 14,072 条结果）。

被测环境：ego lite 0.5.0.32（`ego-browser nodejs`）；引擎**未改**（`scripts/ego-jev.mjs` md5 `d6f38705d1ba892ebeb691d040569a3a`，前后一致），未发现引擎缺陷。原始数据：`bench/raw/ego-switch-{tl1-fetch,tl1-fetch-v2,tl1-lifecycle,tl1-final.log,reply-click-error,draft-verify,skill-step4-run,click-focus,editor-dom,focus-diag,cnki-search,cnki-search-v2}.json`；探针脚本（含逐字提取的 `skill-step1-verbatim.mjs`）：`bench/ego-switch/`。

## ① 规则切换（5 个文件逐个核对）

| 文件 | 改了什么 |
| --- | --- |
| `~/.pi/agent/AGENTS.md` | 「工具与环境指针」首条改为**默认 ego lite**（`ego-browser`，多步任务用 `ego-jev`）；bh 降为**备用栈**并保留其存在原因（macOS TCC） |
| `~/Documents/x-growth/AGENTS.md` | 铁律 #4 驱动改 ego；**Draft.js 那条经验保留**并按实测改写 API（`fill()` 对 Draft.js 无效 → 聚焦 + `keyboard.insertText()`；回读用 `[data-block]` 不用 `innerText`）；bh 保留为备用栈、`~/.agent-chrome` 仍不许删 |
| `~/.codex/rules/default.rules` | `ego-browser`、`ego-jev` 排到最前，`bh`/`browser-harness` 保留为备用权限 |
| `~/.agents/skills/x-trending-reply/SKILL.md` | 全文驱动换成 ego（见 ②） |
| `~/.agents/skills/cnki-researcher/SKILL.md` | 执行模式：默认 ego、bh/MCP 降为备用；新增 ego 实测流程（见 ③） |

核对方式：对 5 个文件逐个 `grep -n -iE "browser-harness|\bbh\b"`，剩余命中**全部**是「备用栈 / 历史对照」表述，没有「默认走 bh」的指引。注：`~/.codex/rules` 里那两条是权限白名单而非默认值；`html-deck-to-pptx` 里的 `Bh` 是几何变量，不是 bh。

## ② x-trending-reply（实测：只读抓取 + 只写草稿）

**前提从头核实**（`ego-switch-tl1-fetch-v2.json` 的 `xHome` 步）：ego 侧 X 登录态已建立——`x.com/home` 直接进时间线（`loginWall=false`、DOM 内 `articles` 非空、首页撰写框存在），导航里有 `/jiangkoumo_`；TL1 的 `page.goto(..., domcontentloaded)` **未抛错**（同文件 `tl1GotoThrew=null`）。

**TL1 抓取**（`ego-switch-tl1-fetch-v2.json`、`ego-switch-tl1-lifecycle.json`，以及技能里那段代码的**逐字运行日志** `ego-switch-tl1-final.log`）：基础页 **50 条** → 点 `3h` + `≤20K` → URL 变 `/trending/hours/3/maxFans/20000` → 提取候选并**按帖子自报时间再过滤**：一次得 50/50、逐字运行得 34/34，**全部落在 1~4h 窗口**（全 `[2小时前]`；条数 34~50 随站点实时列表波动）。`page.evaluate` 单次最大 **12ms**。

重取生命周期（只读量测，1s 采样）：基础页时间标签是混合的（`[4小时前] [2小时前] [22小时前]`）；点 `3h` 后 **约 1 秒**就换成全 `[2小时前]`；点 `≤20K` 后约 2 秒更新，**约 6 秒时观察到一次短暂清空再回填**（`links` 50→8→50）。bh 时代“~15 秒”的说法**未在 ego 上复现**。
⚠️ 基础页前 8 个时间标签**本来就**可能是 `[2小时前]`，所以“窗口条件成立”**不能**证明筛选重取已完成——因此判定改成：**所有时间标签不超窗 + status 链接数连续 3 个采样（每 2s）稳定**，再**按帖子自报时间过滤**候选（逐字运行实测等待 6000ms 后稳定）。

**Draft.js 撰写框**（`ego-switch-draft-verify.json`，回复弹窗，写完放弃）：
1. 开框：`page.click(回复按钮)` **失败**（原始报错 `ElementResolutionError: page.click timed out after 3000ms: page.click failed: <div> intercepts pointer events`，见 `ego-switch-reply-click-error.json`）→ 对**可见**副本 JS `.click()` 成功（同文件 `jsClickDialog=true`）；
2. 聚焦：`page.click('[role=dialog] [data-testid=tweetTextarea_0][contenteditable=true]')` **有效**（`activeElement` 变成该编辑器，`ego-switch-click-focus.json`）；`page.mouse.click(rect 中心)` **无效**——`elementFromPoint` 命中的是 X 的 `[data-testid=ScrollSnap-List]` 覆盖层（`ego-switch-focus-diag.json`）；
3. 写入：`page.keyboard.insertText()`（中文正常）+ `page.keyboard.press("Enter")`（1 次 = 1 个新块）；实测该 testid **本身就是** contenteditable，没有嵌套子节点（`ego-switch-editor-dom.json`）；
4. 回读：`[data-block]` 块数组 = `["第一段…", "\n", "第二段…"]`；**同样内容 `innerText` 给的是 3 个换行** → 证实不能用 `innerText`；
5. 放弃：点 `app-bar-close` → 确认层 `cancel=1 / save=1` → 点 **放弃** → 弹窗关闭、URL 不变、回复数 6→6，**重开撰写框为空（`notSaved=true`，`blocksRaw=["\n"]`）**。

红线：提交/保存/点赞/转发/关注在 CDP 层拦截（`blockedClicks=[]`，全程未被触发）；技能里原有的「发布代码片段」已**删除**，改为「发布由用户本人点」。

**文档里的代码逐字可跑**：把 `SKILL.md` 步骤 4 那段代码原样取出执行（仅把 `tweetUrl` 占位符换成真帖、外包一层拦截 + 加验收断言），`ego-switch-skill-step4-run.json`：`readBlocks` 输出与文档标注一致（`["第一段：直接切入真实细节。","⏎","第二段：抛一个对方会有话聊的问题。"]`）、放弃后弹窗关闭、URL 不变、重开为空（`notSaved=true`）、拦截 0 次。

## ③ cnki-researcher（实测）

`ego-switch-cnki-search-v2.json`（落盘全部 20 行）：`page.goto` 检索页 → `page.fill("input.search-input","大语言模型")` → JS 点 `input.search-btn` → `page.waitForFunction("条结果")` **556ms** 命中 → **14,073 条结果**、首屏 **20 行全部有标题/作者/来源/发表时间**（例：`“问题驱动+大语言模型”融合教学…`｜宫成荣; 常小红; 罗翔…｜心脏杂志｜2026-09-22 17:40）；**未出现验证码**。⚠️ `td.quote`（被引）/`td.download`（下载）两列存在但**本页 20 行都为空**（该页按发表时间排最新/网络首发文献）——不能说“被引也取到了”。

## 未通过项 / 说明

1. `~/.codex/rules/default.rules` 只接受 `prefix_rule`，写不了「默认」注释；本次用**排序 + 新增 `ego-jev`** 表达默认——它本质是权限白名单，bh 权限保留即「备用栈仍可用」。
2. 技能里两条**沿用 bh 时代实测、ego 上未复测**的事实已显式标注（`Escape` 关不掉弹窗、`execCommand('selectAll')` 清空）；需要用到时先复测再采信。
3. X 侧全程未发布/回复/转发/点赞，只开撰写框写草稿并放弃（每轮核对：回复数不变 + 重开为空）；`blockedClicks=[]`，拦截器覆盖 `tweetButton*/confirmationSheetConfirm/like/unlike/retweet/repost/bookmark/follow/share`。
4. fresh-context 只读审阅（`reviewer`）提了 5 条，逐条核实后均已修：① description 还写着“按授权发布回复”（与发布门禁矛盾）→ 改为“起草回复草稿（发布由用户本人操作）”；② TL1 窗口判定可能在旧列表上提前通过（已用数据证实：基础页前 8 个标签本就是 `[2小时前]`）→ 改为读全部标签（≥8 且不超窗）+ 记录筛选前分布/是否见空列表/实际等待，并**新增按帖子自报时间过滤**，重跑后 50/50 在窗；③ 报告里几项断言当时没落在原始文件（登录态 / `goto` 是否抛错 / 回复按钮报错 / 拦截器类别）→ 重跑并落盘（`tl1-fetch-v2` / `reply-click-error`），探针脚本也进仓库；④ 工作流图 `评论<10` 与正文 `<15` 矛盾 → 改 `<15`；⑤ CNKI“被引也取到”过度声称 → 按落盘的全部 20 行改正（两列为空）。
5. 其余 4 个文件不在任何 git 仓库里，只能就地修改、无法提交；`bench/ego-switch/*.mjs` 是探针脚本（结果写到 `/tmp/ego-switch/`），仓库里的 `bench/raw/ego-switch-*.json` 是它们的输出副本。
