# 第三方代码来源评估：decider-loop.mjs ↔ jev-ultrafast（只读结构对照，不含法律结论）

对照对象：我方 `scripts/decider-loop.mjs`（md5 `d6f38705d1ba892ebeb691d040569a3a`，1665 行）
↔ 对方 `~/Documents/scratchpad/jev-ultrafast/jev_ultrafast/`（MIT，Copyright (c) 2026 Browser Use，revision `c32df93`）。
对方工作树有一处**先于本次会话**的本地改动（`model.py`，mtime 2026-09-19，仅 opencode 网关头/端点/`field_text` reasoning，**未触及** `validate_choice` 与 `questions` 结构）；本次评估对它**全程只读**。
方法：逐项比对**步骤序列 / 控制流 / 常量阈值 / 错误处理顺序 / 命名与字段名**；并排摘录与 `文件:行` 见 `bench/raw/third-party-excerpts.md`。
分级：**A** 独立实现 ｜ **B** 结构相近的翻译 ｜ **C** 近乎逐行翻译。

| # | 项（我方位置） | 级别 | 一句证据 |
| --- | --- | --- | --- |
| 1 | 观测层元素表 `decider-loop.mjs:245-460` | **B**（子部分达 C） | `safe`/`visible`(`274-277`)、`nameOf` 8 步回退链(`288-307`)、`roleOf` 映射表(`309-333`)、`roles` **14** 项(`346-349`)、`selector` 拼接(`350-353`)、候选过滤阶段同序(`358-368`)、文本 walker 条件(`406-425`) 与 `snapshot.js:9-10,12-23,24-27,28-43,56-61,82-91` 逐条对应；但输出契约(`ref/kind/guard` vs `node/label/rect/kind`)、guard 字段数(6 vs 14)、条数上限(60/240+unseen-first vs 250+`omitted_actions`)、无 `marker/page_key/fingerprint`、滚动(600 vs 560)、显式 role 接受范围(对方限表内、我方接受任意小写 role) 均已改写 |
| 2 | `validateChoice` `decider-loop.mjs:907-925` | **C** | 5 条判据**同序同阈值**：choice∈ids → 键集合相等 → 所有数(含 confidence)有限且在 [0,1] → `\|Σp−1\| < 0.02` → `p[choice] ≥ max−1e-6`；仅失败通道不同（对方 `raise ValueError`，我方返回 7 种 reason）——对应 `model.py:59-76` |
| 3 | 提示词规则 `decider-loop.mjs:929-943` | **B** | `NEXT_ACTION`（`questions.py:3-14`，**17 个句单位**）→ 我方覆盖 **15 个、主题顺序一致**，但只有 **4 句是严格同序 1:1**，其余为合并/位移（①+③ 移到②之后；④+⑤、⑬+⑭、⑮+⑯ 各自合并），且 ⑥+⑩ 被并成“自动补全**或**搜索/提交”（语义有改动），漏掉 date-picker 与 “If Search/Submit is visible…” 两句；`TARGET`（5 句）→ 我方 4 句、前两句合并 |
| 4 | 动作后等待 `settle` `decider-loop.mjs:998-1050` | **B** | 同位置（动作后、下次观测前）+ 同「自动补全 vs 普通」区分；但机制重写：对方 `browser.py:47-77` 用页面内 `Promise`+`setTimeout(200/50)`+`rAF×2`+选项可见性 ↔ 我方 Node 侧 `sleep(40)`+轮询 `URL/readyState`（静默窗 120/220ms）+有界等 `domcontentloaded`；我方 `955-996` 注释记录了弃用对方机制的两条实测理由 |
| 5 | 架构 dynamic operation + target `decider-loop.mjs:8-16,828-900,1116-1200` | **B** | 设计同构：一次请求同时问 operation 与各 operation 的 target 头、每个头只列兼容元素、代码侧给下拉选项编号(`index:opt` ↔ `ref=N#idx`)、只校验被选中 operation 的那个头、`DONE/BLOCKED` 作为 operation（`model.py:119-152`）；差异：文件组织(4 模块 vs 单文件)、state 编码(JSON 对象 vs 文本)、陈旧判定(`marker/page_key/guards` vs URL+滚动位移+6 字段 guard)、循环护栏(`MAX_STEPS=60`+决策预算 `MAX_STEPS*2`+连续无变化阻断 vs 另加 stuck/no_progress/guard/target_missing/invalid/reveal)、我方 `type_text`/`type_text_submit` 共用一个 target 头 |
| 6 | 动作执行器（**注释未点名，本次评估发现**）`decider-loop.mjs:468-489,511-521,545-563` | **C** | 与 `browser.py:145-190` 近乎逐行：入参前检查序列与顺序一致（连接 → disabled/aria-disabled/inert → `checkVisibility` → readOnly(fill) → rect/中心/视口 → `elementFromPoint` 命中）；下拉可用性谓词相同（`!o.disabled && !o.closest('optgroup[disabled]')`）+ 同 `value` 赋值与 input/change 派发；鼠标 `mousePressed`+`mouseReleased` 两个事件；填充用 `keyDown 'a'/KeyA, modifiers = darwin ? 4 : 2, commands:["selectAll"]` + `keyUp` + `Input.insertText`（**平台常量 4/2 相同**） |

**总判：存在代码级翻译**（2 项 C + 4 项 B，且第 1 项多个子部分达 C）——与「仅借鉴思路/算法/需求」不一致。

**事实**（MIT 原文第 1 段）：在 "the Software **or substantial portions of the Software**" 的所有副本中随附版权与许可声明，是 MIT 列出的许可条件之一。上表的分级与 `文件:行` 是本次评估的全部结论；「是否构成版权法意义上的实质性部分」「是否需要随附」**不在本次评估范围**，由主持人判断。

**建议（若主持人决定随附）**：新增 `THIRD-PARTY.md`，建议内容如下（许可全文从对方 `LICENSE` 原样粘贴，不要改写）：

```markdown
# 第三方代码

## jev-ultrafast — Browser Use
- 来源：https://github.com/browser-use/jev-ultrafast（本次对照 revision c32df93）
- 许可：MIT License — Copyright (c) 2026 Browser Use
- 涉及范围：`scripts/decider-loop.mjs` 的观测层元素表构建、`validateChoice` 响应校验、
  `NEXT_ACTION`/`TARGET` 提示词、动作后等待、动作执行器，以及 dynamic operation + target 架构；
  分级依据见 `THIRD-PARTY-ASSESSMENT.md`，并排证据见 `bench/raw/third-party-excerpts.md`
- 许可全文：（此处粘贴 jev-ultrafast/LICENSE 全文）
```

**本次未做的判断**：未评估「是否构成实质性部分」「是否需要其他合规动作」；未改动引擎、README、注释或对方仓库（全程只读）。
