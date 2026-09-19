---
name: ego-jev
description: 用 Jev（TypeSafe System One）给 ego-browser 的浏览器操作加速的**附加技能**。多步点击、翻页、搜索表单、导航跳转这类线性任务，可在单个进程内由 Jev 闭环决策，不再每走一步都退回大模型慢思考。同时记录了 ego 内嵌运行时的两条静默失败限制（静态 import 内置模块会无声退出、不能起服务也不能访问 loopback）、凭证为何必须落盘、实测对照数据与失效边界。当任务涉及 ego-browser 多步操作，或要写 ego-browser nodejs 脚本（尤其用到 await import / fetch）时读它。
metadata:
  version: "1.0.0"
  date: "2026-09-19"
  requires: ego-browser
---

# ego-jev — 给 ego-browser 装一个 Jev 决策闭环

这是一个**附加技能（外挂）**：它只存在于 `~/.agents/skills/ego-jev/`，**不修改 ego lite 应用包里的
任何文件**，因此 ego lite 升级不会把它冲掉。

基础用法、Space/Page/选择器/收尾纪律仍以 `ego-browser` 技能为准；本技能只负责「让 Jev 加速」这件事。

## 加速能力

多步按钮点击、翻页、搜索表单、导航跳转这类「下一步做什么很明确」的线性任务，不要每走一步都
退出来交给大模型慢思考。可以让 Jev（TypeSafe System One）在单个进程内闭环决策执行。

实测（2026-09-19, jev-1.13）：单步决策约 1.0–1.5s。**对照实测**（同任务、同元素表、同验证器，
交替 3 轮取中位数）：

| 任务 | Jev 单进程闭环 | 经典循环（每步一进程 + 大模型思考） | 结果 |
| --- | ---: | ---: | --- |
| HN 两步复合导航 | 中位 **4.9s**（1 进程，12 次浏览器调用） | 中位 **9.7s**（3 进程） | Jev 快 **~2.0×** |
| 维基百科搜索（两组都要生成文本） | 中位 **5.4s**（1 步） | 中位 **10.1s**（2 进程） | Jev 快 **~1.9×** |

差异主要来自**决策延迟**：Jev 约 1.0–1.5s/次，而可用大模型 1.6–4.5s/次（实测 kimi-k3 1.8s、
minimax-m3 1.6s、glm-5.3 3.2s、qwen3.8-max 3.5s、deepseek-v4-pro 4.5s；gpt-5.6-luna 与
grok-4.6 端点 503 不可用）。进程启动实测只占约 250–350ms/次，**不是**主要成本。

样本只有 3 对/任务且**方差很大**（经典组单轮 7.3s–22s，上述是不同批次中更好的那批），
不构成基准；只能说量级上 Jev 闭环约为经典循环的一半时间。基准脚本在 仓库的 `examples/bench/`
（`run-pair.sh` + `arm-a.js` / `arm-b-step.js`）。

**Jev 快在哪里、不快在哪里**：省的是**决策往返**（Jev 1.0–1.5s/次 vs 大模型 1.6–4.5s/次）
和**每步退出浏览器上下文**的开销；浏览器动作本身、快照、协议调用两边基本一样
（Jev 每步仍是 1 次 snapshot + 1 次批量 evaluate）。目标能用选择器写死时，直接写代码比两者都快。

**凭证**：`ego-browser nodejs` 内嵌运行时只继承最小化登录环境（HOME/PATH 等），shell 里
export 的变量不会传进去。所以 API Key 必须落盘到 `~/.config/typesafe/api_key`
（或 `TYPESAFE_API_KEY_FILE` 指向的文件，内容为 Key 一行，权限 600）。文件缺失时会直接报错。

**决策结构**（对齐 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) 的
dynamic operation + target）：每次观测产出「索引化元素表」，每个可交互元素一个 `ref`，并携带
当前值；一次请求同时问 **operation** 和各操作的 **target**（推测性问题，彼此不可见）；
每个 target 头只列出与它兼容的元素，executor 只消费命中操作对应的那个头。

```
ref=2 | textbox | "Query Field" | 当前值="hello world"
ref=4 | checkbox | "Subscribe Newsletter" | 未勾选
ref=6 | combobox | "Country Select" | 当前值="Japan" | 选项=[Switzerland|Japan|Germany]
ref=10 | anchor | "Next Page" | /next

operation: click / type_text / type_text_submit / select / scroll_up / scroll_down / wait / done / blocked
           └─ 只列出当前页面受支持的操作
click_target      ← 只含可点元素（按钮/链接/复选框，不含输入框与原生下拉）
type_text_target  ← 只含可输入元素（textbox/searchbox/textarea）
select_target     ← 原生下拉，候选写成 元素#选项序号（如 ref=6#2）
```

`done` / `blocked` 就是 operation 之一，不另设概率阈值；复选框/单选不会被当成可编辑元素。
原生下拉的选项索引与勾选态快照不暴露，由引擎额外做**一次**批量页面调用补齐。

1. **终端一行命令直接驱动**（在任何项目与路径下可用）：

```bash
# 简单目标
ego-jev --url "https://example.com" "点击登录按钮并聚焦输入框"

# 需要输入文本：候选由调用方给，Jev 只负责选字段和选哪段文本
ego-jev --url "https://en.wikipedia.org/wiki/Main_Page" --text "Jev" \
  --until "/wiki/JEV" "在页面顶部的搜索框中输入并提交搜索"

# 让模型自己写文本（已配置好，无需 --text）
ego-jev --url "https://en.wikipedia.org/wiki/Main_Page" "在维基百科搜索框里搜索哥德尔不完备定理"

# 复用已有 space，并在完成后保留 space 供人工检查
ego-jev --space 3 --keep-space --steps 15 "点击未发送帖子并保存"
```

`--until <substr>` 给确定性退出条件（URL 包含该子串即判成功），比依赖 Jev 自评 `done` 可靠得多，
强烈建议带上。退出码 0 表示成功，1 表示未达成目标（此时 space 会被保留供排查）。

#### 文本生成配置（`~/.config/typesafe/text_model.json`，当前指向 opencode-go）

```json
{
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "apiKeyJson": { "file": "~/.pi/agent/auth.json", "path": "opencode-go.key" },
  "model": "deepseek-v4.1-flash",
  "sessionHeader": "x-opencode-session",
  "sessionId": "ego-jev",
  "userAgent": "ego-jev/1.0",
  "headers": { "x-opencode-client": "ego-jev" }
}
```

- `apiKeyJson` **引用已有凭证文件**而非复制密钥；也可直接写 `apiKey`。
- `opencode-go` 必须带 `x-opencode-session`（稳定会话 id，用于路由与提示缓存），
  缺它直接 400 `MissingSessionID`。
- 实测 `deepseek-v4.1-flash` 会输出 `reasoning_content`，**`reasoning:{enabled:false}` 无效**，
  生成耗时 1.3–1.9s；答案在 `content` 字段，引擎只读它。带生成的整步约 3.8s。

2. **在任何 `ego-browser nodejs` 脚本中导入复用**：

```js
import { runJevAutonomousLoop } from "~/ego-jev/ego-jev.mjs";

// Jev 在当前页面自主连续操作，直到 check 通过或 Jev 判定 done
const result = await runJevAutonomousLoop(page, "依次打开 new 页面，再打开 comments 页面", {
  maxSteps: 8,
  text: ["Jev"],                                              // 可填文本候选（可选）
  check: async (p) => (await p.url()).includes("/newcomments"), // 确定性成功条件（推荐）
});
console.log(result); // { success, reason, steps, history }
```

配套导出：`askJev(state, questions, options)` 做单次判断、`parseActionTargets(snapshot)`
把快照解析成元素表（含 kind/当前值）、`enrichTargets(page, targets)` 一次批量调用补齐下拉选项与
勾选态、`buildQuestions(targets, { texts, hasTextSource })` 组装操作/目标问题、
`generateText(input, options)` / `loadTextModelConfig()` 文本生成、`runJevStep(page, goal, options)` 走一步。

### 边界（实测）

- Jev 只发一次并行判断、**无跨请求记忆**：复合目标（A 然后 B）依赖引擎回填的「已完成步骤」，
  已内置并已验证（两步导航、已填字段改写、下拉改选、勾选均通过）。更长链路未做专项评估。
- 元素每次快照都会重新编号；只取视口内 40 个可交互元素，并做**陈旧校验**：只执行与本次元素表
  一致的 `ref`，不一致记为 `staleTarget` 跳过。
- **文本来源**三选一：`--text` 候选（Jev 从中选，优先）→ `~/.config/typesafe/text_model.json`
  的模型（**当前已配置为 opencode-go / deepseek-v4.1-flash**；严格只接受恰好一个非空 `text`
  字段的 JSON，不合格则判 `text_model_failed` 而不是猜值）→ 都没有时不提供输入操作。
  可用 `textModel: null` 显式禁用，或传自定义 `async (input) => string` 函数接入其他模型。
- 由模型生成的文本会让落地 URL 不可预测（中文搜索词会被编码），这类任务不要指望 `--until`，
  靠 `jev_done` 或 `check` 判成功。
- 退出条件：`no_progress`（连续 5 次变更类动作页面无变化）、`stuck`（同一动作连续 3 次无变化，
  含反复滚动）、`target_missing`（选了需目标的动作却没解析出目标，连续 2 次）、`no_targets`
  （连续 3 次空快照）、`blocked`、`text_model_failed`、`no_text_source`、`action_failed`。
  失败时先看 `result.reason` 再决定是否重试。
- `blocked` 由 Jev 判断（验证码/登录墙/无可用推进手段/反复无进展）。合成拦截页已验证：
  纯拦截页首步即判 `blocked`，登录墙试一次后判 `blocked`。**真实**验证码站未测。
- 比较「页面是否变化」时忽略 URL 的 `#hash`：点锚点链接不算有进展。
- 每步浏览器调用：1 次 `page.snapshot()` + 1 次批量 `page.evaluate()`（补齐下拉选项/勾选态/
  真实值）+ url/title。这个批量调用是换取准确性的代价，不是免费。
- 真实站点实测：原生下拉能读到全选项（wikipedia.org 语言选择器 77 项，1 步改选成功）；
  但**并非所有控件都进快照**——DuckDuckGo 设置页 DOM 有 18 个复选框，快照里是 0 个，
  这类元素引擎无从感知。httpbin 表单的复选框在快照里既无 loc 也无名称，靠「文档顺序」
  兜底补齐名称与勾选态；仅当数量完全一致时才敢用，否则显示「勾选态未知」而不会谎报。
- 动作后不用固定延迟：先短静默，再用 `waitForLoadState("load")` 兜底捕捉**延迟导航**
  （实测下拉改选触发的跳转会晚于 400ms，若只用固定延迟会把“已跳转”误判成“未变化”，
  导致 Jev 重复执行同一动作）。
- **已知弱点：改选后需再点确认按钮的原生下拉**（如 wikipedia.org 语言选择器）不稳定：
  Jev 可能重复改选同一选项，被 `stuck` 拦住。实测带 `--until` + 足够 `--steps`（≥6）时
  约 2/3 成功，失败时报 `stuck` 而非静默错误。这类任务要么给 `--until`，要么把两步动作写死。
- Jev 走完不等于业务正确：仍要按本 Skill 的观察纪律复核最终页面状态。
- 该站可能开启自动翻译（实测 Chrome 把注入的英文表单译成中文，`Switzerland`→`瑞士`），
  元素名与选项名可能与目标语言不一致；Jev 跨语言选择正常，但用**字符串比较**做 `--until` 或
  `check` 会误判，请改用 URL 路径或 DOM 状态。

## ego 内嵌运行时的两条静默失败限制（实测）

写 `ego-browser nodejs` 脚本时踩过，两条都是**无声失败**，排查很坑：

1. **静态 import 内置模块会让整个脚本无声退出**：`import { createServer } from "node:http"`
   不报错、无输出、exit 0。**必须用 `await import("node:http")`**。
   本地文件与引擎同理，用 `await import("/绝对/路径.mjs")`。
2. **运行时不能起服务、也不能访问 loopback**：`server.listen()` 的回调永不触发；
   `fetch("http://127.0.0.1:…")` 会挂起后 exit 0。外部 HTTPS `fetch()` 正常。
   要测本地代码，把服务起在 ego 之外，用普通 node 进程去测。

配套的两条环境事实：

- **自定义环境变量一律不传入**（不止 `TYPESAFE_API_KEY`）：`export FOO=bar` 在运行时里读不到。
  需要传配置时，在**父进程把值替换进脚本文本**再送进去（`ego-jev` CLI 就是这么处理凭证的）。
- **`process.cwd()` 是 `/`**，不是 shell 的工作目录。脚本里不要依赖相对路径。

## 不要改应用包里的文件

有需要时不要在
`/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/*/Resources/ego-skills/ego-browser/SKILL.md`
里加内容：那是供应商受签名的应用包，升级会替换该目录（`Versions/0.5.0.32` → 新版本号），
改动会丢失。要扩展就放到包外的 `~/.agents/skills/<自己的技能>/`。
