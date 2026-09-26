# 预登记协议：A 栈 vs B 栈大样本验证（先写后跑，跑完不改）

> 本文件在**采集任何样本之前**写入。判据、样本量、统计方法与失败处理规则一经写入即冻结；
> 后续所有原始数据落在 `bench/raw/verify-*.jsonl`，若与本文件不符，以本文件为准并需在报告中说明偏离。
>
> **环境前置（2026-09-26 补注）**：B 栈需要 `browser-harness`（`bh`）与 `JEV_ULTRAFAST_DIR`；
> 本机已移除 bh，因此 B 栈目前**不可重跑**（已采样本与报告不受影响）。只跑 A 栈：
> `bash bench/verify.sh <轮数> --a-only`（先 `bash bench/verify.sh --check-env` 看环境）；
> 不加 `--a-only` 时缺 bh 会直接 exit 2，不会静默产出 `no_output`。

## 1. 被测对象（冻结版本）

| 项 | 值 |
| --- | --- |
| A 栈 | ego lite + `ego-jev` 引擎 **commit `70b566b`**（`scripts/ego-jev.mjs`，工作区干净、本次不改动） |
| A 栈校验 | 采集前后各记录一次 `md5 scripts/ego-jev.mjs`，必须一致 |
| B 栈 | browser-harness + `jev-ultrafast` **commit `c32df93`**（`pyproject.toml` version `0.1.0`） |
| Jev | `https://api.typesafe.ai/v1/systemone`，模型 `jev-latest` |
| 文本模型 | 两栈同一个：opencode zen `https://opencode.ai/zen/v1`，`minimax-m3`（A 通过调用方传参显式指定同一 baseUrl/model/key 与 `x-opencode-session` 头，B 读 `jev-ultrafast/.env`） |
| 浏览器 | 两栈共用同一个 Chrome（`~/.agent-chrome`，端口取自 `bh ensure`） |

## 2. 任务清单与成功判据（**唯一版本**）

判据只用**终态 URL / 页面断言**，不依赖"点了哪个按钮"或"走哪条路径"——这是上一轮的教训。

| # | 任务 id | 起始 URL | 目标描述（交给两栈的同一句话） | 成功判据（两栈语义等价） | 覆盖的交互类型 |
| --- | --- | --- | --- | --- | --- |
| 1 | `hn-nav` | https://news.ycombinator.com | 先打开 new 页面，再打开 comments 页面 | 终态 URL 含 `/newcomments` | 点击链（两个链接） |
| 2 | `hn-page2` | https://news.ycombinator.com | 翻到下一页（More） | 终态 URL 含 `p=2` | 翻页 + 需要滚动才能看到目标（More 链接 y=1117，视口外） |
| 3 | `wiki-search` | https://en.wikipedia.org/wiki/Main_Page | 在顶部搜索框输入 Jev 并提交搜索 | 终态不是 Main_Page，**且**满足任一：① `document.title` 匹配 `/Japanese encephalitis\|Search results/i`；② 终态 URL 含 `search=` | 文本生成 + 输入 + 提交 |
| 4 | `httpbin-form` | https://httpbin.org/forms/post | 把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单 | 页面可见文本同时匹配 `/custname"\s*:\s*"Jev"/` 与 `/topping"\s*:\s*"bacon"/`（即 httpbin 对表单的真实回显） | 文本生成 + 输入 + 复选框 + 提交 |
| 5 | `select-native` | http://127.0.0.1:8099/c.html | 把语言下拉框改选为 Dansk，然后点击 Confirm | 页面可见文本匹配 `/Selected:\s*Dansk/` | **原生 `<select>` 改选** + 确认按钮（A 旧引擎在此 0/3 卡死过，属已知能力差异点） |

判据机械校验（写协议前已做，非样本）：`/wiki/JEV` 与 `/wiki/Japanese_encephalitis` 两个终态的 `document.title` 都是
`日本脑炎 - 维基百科 --- Japanese encephalitis - Wikipedia`（同页，重定向）；`d.html?lang=da` 渲染 `Selected: Dansk`，
`d.html?lang=en` 渲染 `Selected: English`；HN `More` 链接 `href="?p=2"`、`y=1117`、视口外。

**页面断言在实现上如何取"可见文本"**：A 用 `document.body.innerText`；B 用其观测层返回的 `page["text"]`
（视口内可见文本，上限 6000 字符）。两者都是"当前可见文本"，本任务涉及的结果页都很小（httpbin `/post` 回显 476 字节），
不存在截断风险。**wiki 用 `document.title`**（两栈都能读，且与语言/翻译无关地包含英文原名）。

## 3. 采样与交替

- 每任务每栈 **10 次**；5 任务 × 2 栈 × 10 = **100 轮**。
- **A/B 交替**，且按轮次奇偶**翻转顺序**（奇轮 A→B，偶轮 B→A），以控制"同一轮内先后顺序"带来的时间漂移。
- 每轮记录：`round`、`order`、`stack`、`task`、`attempts`、`success`、`reason`、`elapsedMs`、`steps`、
  `jevCalls`、`textCalls`、`protocolCalls`（仅 A 有）、`finalUrl`、`assertDetail`。
- 计时口径（两栈对齐）：页面加载完成后再开始计时。A：`goto` + 等 800ms → t0；B：`Agent(...)` 构造完成
  （内部已 `Page.navigate` 并等 `readyState=complete`）+ 等 800ms → t0。每步之后与每轮开始前各查一次判据。

## 4. 失败与重试规则

- **harness 级失败**（脚本无任何输出行：ego 运行时异常、browser-harness 5s IPC 超时、进程超时）→ 最多重试到
  `attempts=3`，`attempts` 记入原始数据。
- **任务级失败**（有输出但判据不满足，如 `blocked` / `no_progress` / `max_steps_reached`）→ **保留、不重试、不丢弃**，
  计入成功率。
- 三次尝试仍无输出 → 记为 `reason=no_output` 的失败轮，同样保留。
- 任何被丢弃/替换的轮次都必须在报告中说明。

## 5. 统计方法（预先指定）

- **描述统计**（每任务每栈，成功样本）：中位数、Q1、Q3、min、max；另报成功率（全部有效轮）。
- **配对分析**：同一轮次的 `d_r = A_r − B_r`（A 与 B 在同一轮内相邻执行，控制时间漂移）。
  - 仅使用**两栈都成功**的轮次配对；配对轮数 < 5 时不出结论，只报未配对中位数。
  - 报：中位差、均值差、**bootstrap 95% 置信区间**（对配对差值重采样 10000 次，固定随机种子 `20260919`）、
    符号检验（`d<0` 与 `d>0` 的计数，双侧精确二项 p 值）。
- **判定规则（预先指定）**：
  - 若 bootstrap 95% CI **跨 0** → 结论写 **"无差异"**（即使中位数看起来偏向一边）。
  - 若 CI 不跨 0 → 报方向与幅度（中位差 ms 与相对百分比）。
  - 负差 = A 更快（`elapsedMs` 更小）。
- **噪声源分离**：另报每任务的 `jevCalls` 中位数与（B 可得的）单次 Jev 延迟中位数，用于说明总耗时差异
  是来自决策次数还是单次延迟。
- 允许并必须报告 null result；不为凑结论更换口径。

## 6. 产物

- `bench/verify-protocol.md`（本文件，预登记）
- `bench/raw/verify-<批次时间戳>.jsonl`（原始，每行一轮，含 `attempts` 与失败原因）
- `bench/raw/verify-analysis-<批次时间戳>.json` / `.txt`（统计结果，由脚本从 JSONL 生成）
- `VERIFY-REPORT.md`（≤80 行，首行结论；每任务一行结论：方向 / 幅度 / 区间是否跨 0）
- `PORT-REPORT.md` §3 增加一句指向 `VERIFY-REPORT.md`（不删除原有自陈缺陷）

## 7. 已知偏离预案

- 若某任务在某一栈上**全部失败**（成功率 0），该任务不出配对结论，报告中如实写明"该栈未能完成任务"。
- 若 `bh` 的 Chrome 实例中途挂掉，重连后继续，并把受影响轮次的 `attempts` 如实记录。
- 若引擎 md5 在采集期间发生变化，本次样本作废并说明（本协议第 1 节的校验就是为此）。
