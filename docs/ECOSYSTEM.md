# 生态一览：同一思路下的同类项目与上游

> English summary: a neutral, point-in-time census (2026-09-26) of projects that share the same
> idea — replace ego lite's per-step LLM turn with TypeSafe's **Jev**. Every "自述" cell quotes the
> project's own GitHub About **verbatim**; the three right-hand columns come from one GitHub file-tree
> query. **We have not run any of their code, so this page makes no performance comparison.**
> Stars and dates change over time — always treat the repository itself as authoritative.

## 核查日期与方法

- **核查日期**：2026-09-26。**★ 数与创建日期会变**，以各仓库当前页面为准。
- **数据来源**：GitHub REST API，只取两类可复算的公开字段——仓库元数据与默认分支的递归文件树。
- **复算方法**（把 `OWNER/REPO` 换掉即可；`gh` 是 GitHub 官方 CLI，也可用等价的 REST 调用）：

  ```bash
  # ① 元数据：★ / 创建日期 / About
  gh api repos/OWNER/REPO -q '{stars: .stargazers_count, created: .created_at[:10], about: .description}'
  # ② 默认分支的递归文件树（用来复算下面三列）
  br=$(gh api repos/OWNER/REPO -q .default_branch)
  gh api "repos/OWNER/REPO/git/trees/$br?recursive=1" -q '.tree[]|select(.type=="blob").path'
  ```

- **后三列的计数口径**（机械正则，不是人工判断）：
  - **测试类文件数**：文件树里路径匹配 `(^|/)(tests?|__tests__|spec)/`，**或**文件名匹配
    `(^|[._-])(test|spec)([._-]|$)` 且以代码后缀（`mjs/cjs/js/jsx/ts/tsx/py/rb/go/rs/java`）结尾——两个条件取并集。
  - **原始数据**：路径匹配 `(^|/)raw/` 的文件；没有就记 `—`。
  - **CHANGELOG**：仓库根下的 `CHANGELOG*` 文件。
- **这不是测试用例数，也不是质量评分**。各项目的测试约定不同（Go 用 `_test.go`、JS 用 `*.test.mjs`、
  有的把 fixture 放在 `tests/`），所以**这一列不能跨项目直接比较**，只表示「文件树里有多少个测试类文件」。
- **我们只照抄各项目自己的话**；没有引用的地方一律留空，不替它们总结实现细节。

## 同类项目

| 仓库 | ★ | 建于 | 自述（GitHub About 原文） | 测试类文件数 | 原始数据 | CHANGELOG |
| --- | --: | --- | --- | --: | --- | --- |
| romaluev/jev-ego | 17 | 2026-09-17 | Fast browser agent for ego lite. One TypeSafe request per step; an agent or Jev picks the move. | 9 | — | — |
| ZephyrDeng/ego-jev | 9 | 2026-09-21 | ego lite skill — each DOM step decided in ~0.4s, no LLM turn | 1 | — | — |
| **jiangkoumo/ego-jev（本仓库）** | 4 | 2026-09-19 | ego lite × Jev (TypeSafe System One): one indexed element table in, one operation + target out, single process. The measured one — committed raw bench data, 16 test suites, fail-closed execution guards, changelog with corrections, upstream-cited. | 16 | ✅ `bench/raw/`（83 个文件） | ✅ `CHANGELOG.md` |
| raydocs/egolite-jev | 3 | 2026-09-18 | npx skills add raydocs/ego-verified-actions — bounded ego-lite clicks with checkable SUCCESS_MATCH | 2 | — | — |
| shikaizhong-design/ego-jev-ultrafast | 3 | 2026-09-21 | Jev drives your Ego Lite browser: one typed-choice request per step. Single-file, zero-dependency port of browser-use/jev-ultrafast with multi-model benchmarks and extra guardrails. Unofficial. | 0 | —（有 `bench/` 脚本，无 `raw/` 数据） | — |
| ZHUBoer/ego-jev | 2 | 2026-09-19 | Complete browser tasks with Ego Lite and actively call Jev for semantic target selection, filtering, ranking, classification and text evidence judgments. | 3 | — | — |
| flazouh/ego-jev | 1 | 2026-09-22 | Drive ego-browser pages with TypeSafe Jev: code builds the allowed actions, Jev picks one, code acts and re-checks. | 10 | — | — |
| phd-peter/ego-jev | 1 | 2026-09-18 | （仓库未设置 About） | 4 | — | — |

说明：

- 表内 ★ / 日期 / 自述取自上节的 API 查询；**测试类文件数按上节口径复算**。本仓库的「16」对应
  `bench/test-*.mjs` 16 个套件（README 里的「16 套 / 429 项」是套件与检查项两个口径）。
- **我们没有运行过这些仓库的代码**，也没有阅读它们除 About 与文件树之外的内容；本文档不评价优劣、
  不排名、不比较性能。

## 上游与本仓库的关系

| 项目 | 关系 |
| --- | --- |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | 本仓库引擎的**代码级来源**：响应校验、动作执行器、观测层元素表、提示词规则等由其翻译/改写而来。许可与分级见 [`THIRD-PARTY.md`](../THIRD-PARTY.md) |
| [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) | **宿主**：本仓库通过 `ego-browser` 驱动它，不修改其应用包、不再分发其代码或文档 |
| [TypeSafe](https://docs.typesafe.ai) | **模型提供方**：Jev / System One，一次请求返回「操作 + 目标」 |

## 怎么核实我们的数字

- 原始基准数据：[`bench/raw/`](../bench/raw)（每次运行的 JSON，含时间戳）。
- 测试与可执行断言：[`bench/*.mjs`](../bench)（含 `test-release-consistency.mjs`、`test-wire-skill.mjs` 等）。
- 对照基准脚本：[`examples/bench/run-pair.sh`](../examples/bench/run-pair.sh)。
- **本文档不比较性能**：我们没跑过同类项目的代码，也就没有它们的耗时/成功率数据；要比较性能，
  必须用同一任务、同一机器、同一口径重新测量，并带上产生数字的脚本。

## 未复核 / 会变的

- 第三方目录 [aiskill.market](https://aiskill.market/skills/ego-jev-phd-peter) 上有一条 `ego-jev` 条目，
  页面标注更新于 2026-09-18。那是**目录自己的摘要**（非仓库 About），且页面显示的 ★ 数与 GitHub
  本轮查询不一致；本仓库未对该目录做独立复核。
- ★ 数、更新日期、以及各仓库的文件树都会随时间变化——**以仓库为准**。
