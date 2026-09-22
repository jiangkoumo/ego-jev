# 结论：默认浏览器栈已切回 ego——5 个文件里「默认走 bh」的指引全部改成 ego（bh 保留为备用），两个技能改用 ego-browser 真实 API 并实测通过（TL1 抓到 50 条候选、Draft.js 能写入且按 `[data-block]` 回读、CNKI 拿到 14,072 条结果）。

被测环境：ego lite 0.5.0.32（`ego-browser nodejs`）；引擎**未改**（`scripts/ego-jev.mjs` md5 `d6f38705d1ba892ebeb691d040569a3a`，前后一致），未发现引擎缺陷。原始数据：`bench/raw/ego-switch-{tl1-fetch,draft-verify,skill-step4-run,click-focus,editor-dom,focus-diag,cnki-search}.json`。

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

**前提从头核实**（`ego-switch-tl1-fetch.json` 的 `xAccount` 步）：ego 侧 X 登录态已建立——`x.com/home` 直接进时间线（`loginWall=false`、DOM 内 6 条 `article`、首页撰写框存在），导航里有 `/jiangkoumo_`。

**TL1 抓取**：基础页 **50 条** → 点 `3h` + `≤20K` → URL 变 `/trending/hours/3/maxFans/20000` → 轮询后 `inWindow=true`（8 个时间标签全是 `[2小时前]`）→ 提取到 **50 条候选**（例 `https://x.com/NFT_Chen/status/2102297992179200329`）。`page.evaluate` 单次最大 **12ms**；`page.goto(..., domcontentloaded)` **未抛错**（bh 的 `goto_url` 必然超时——这条坑已按 ego 实测改写）。

**Draft.js 撰写框**（`ego-switch-draft-verify.json`，回复弹窗，写完放弃）：
1. 开框：`page.click(回复按钮)` **失败**（`ElementResolutionError: <div> intercepts pointer events`）→ 对**可见**副本 JS `.click()` 成功；
2. 聚焦：`page.click('[role=dialog] [data-testid=tweetTextarea_0][contenteditable=true]')` **有效**（`activeElement` 变成该编辑器，`ego-switch-click-focus.json`）；`page.mouse.click(rect 中心)` **无效**——`elementFromPoint` 命中的是 X 的 `[data-testid=ScrollSnap-List]` 覆盖层（`ego-switch-focus-diag.json`）；
3. 写入：`page.keyboard.insertText()`（中文正常）+ `page.keyboard.press("Enter")`（1 次 = 1 个新块）；实测该 testid **本身就是** contenteditable，没有嵌套子节点（`ego-switch-editor-dom.json`）；
4. 回读：`[data-block]` 块数组 = `["第一段…", "\n", "第二段…"]`；**同样内容 `innerText` 给的是 3 个换行** → 证实不能用 `innerText`；
5. 放弃：点 `app-bar-close` → 确认层 `cancel=1 / save=1` → 点 **放弃** → 弹窗关闭、URL 不变、回复数 6→6，**重开撰写框为空（`notSaved=true`，`blocksRaw=["\n"]`）**。

红线：提交/保存/点赞/转发/关注在 CDP 层拦截（`blockedClicks=[]`，全程未被触发）；技能里原有的「发布代码片段」已**删除**，改为「发布由用户本人点」。

**文档里的代码逐字可跑**：把 `SKILL.md` 步骤 4 那段代码原样取出执行（仅把 `tweetUrl` 占位符换成真帖、外包一层拦截 + 加验收断言），`ego-switch-skill-step4-run.json`：`readBlocks` 输出与文档标注一致（`["第一段：直接切入真实细节。","⏎","第二段：抛一个对方会有话聊的问题。"]`）、放弃后弹窗关闭、URL 不变、重开为空（`notSaved=true`）、拦截 0 次。

## ③ cnki-researcher（实测）

`ego-switch-cnki-search.json`：`page.goto` 检索页 → `page.fill("input.search-input","大语言模型")` → JS 点 `input.search-btn` → `page.waitForFunction("条结果")` **543ms** 命中 → **14,072 条结果**、首屏 **20 行**，标题/作者/期刊/日期/被引字段齐全（例：`“问题驱动+大语言模型”融合教学…`｜宫成荣; 常小红; 罗翔…｜心脏杂志｜2026-09-22 17:40）；**未出现验证码**。

## 未通过项 / 说明

1. `~/.codex/rules/default.rules` 只接受 `prefix_rule`，写不了「默认」注释；本次用**排序 + 新增 `ego-jev`** 表达默认——它本质是权限白名单，bh 权限保留即「备用栈仍可用」。
2. 技能里两条**沿用 bh 时代实测、ego 上未复测**的事实已显式标注（`Escape` 关不掉弹窗、`execCommand('selectAll')` 清空）；需要用到时先复测再采信。
3. X 侧全程未发布/回复/转发/点赞，只开撰写框写草稿并放弃（每轮核对：回复数不变 + 重开为空）。
4. 报告与原始数据放在 ego-jev 仓库（其余 4 个文件不在任何 git 仓库里，只能就地修改、无法提交）。
