# ego-jev

[![skills.sh](https://skills.sh/b/jiangkoumo/ego-jev)](https://skills.sh/jiangkoumo/ego-jev)

**用 Jev（TypeSafe System One）驱动 ego lite 浏览器，把「下一步点哪里」的决策放进单个进程内闭环。**

> English summary: `ego-jev` replaces the per-step LLM round trip in browser automation with
> [TypeSafe](https://docs.typesafe.ai)'s System One model **Jev**. Jev reads one *indexed element
> table* and answers, in a single request, both the **operation** (`click` / `type_text` / `select` /
> `scroll_up` / `scroll_down` / `wait` / `done` / `blocked`) and the **target element**. Code owns
> observation, execution, verification and exit conditions.
>
> Measured after the engine rebuild: HN two-step navigation **4569ms → 1916ms** on the same task, and
> against browser-harness + jev-ultrafast over 100 pre-registered paired rounds — click chain
> **−378ms**, wiki search **−819ms** (using 1 Jev decision instead of 3), form filling **no
> difference**, native select **+248ms** in their favour. Raw data in
> [`bench/raw/`](bench/raw) via [VERIFY-REPORT.md](VERIFY-REPORT.md).

---

## 这是什么

[ego lite](https://github.com/citrolabs/ego-lite) 的 `ego-browser` 让 Agent 操作真实浏览器（复用你的登录态）。
但典型用法是每一步都退出浏览器上下文、回到大模型思考「点哪里」——每步一次模型往返。

`ego-jev` 把这一步换成一个小的 System One 模型 **Jev**：

- 只把**视口内的索引化元素表**发给它（不是整页快照），1.6KB ≈ 400 tokens 量级
- 一次请求同时问 **operation** 和各操作的 **target**（推测性问题，彼此不可见）
- 每个 target 头只列出与它兼容的元素，操作与目标不匹配天然被排除
- 代码负责：观察、执行、陈旧校验、死循环保护、退出判定、space 收尾

它**不是**想替代大模型：Jev 不生成文本、不做业务判断，只回答「下一步做什么、点哪个」。
需要生成内容时再调一个小文本模型（见[文本生成](#文本生成可选)）。

## 实测

**方法**：同任务、同元素表、同验证器，「交替 3 轮取中位数」。
A = `ego-jev` 单进程闭环；B = 经典循环（**每步一个独立进程** + 大模型 `kimi-k3` 思考）。
测于 macOS + ego lite 0.5.0.32 + `jev-1.13`，2026-09-19。

| 任务 | A（ego-jev） | B（经典循环） | 结果 |
| --- | ---: | ---: | --- |
| Hacker News 两步复合导航 | 中位 **4.9s**（1 进程，12 次浏览器调用） | 中位 **9.7s**（3 进程） | **约 2.0×** |
| 维基百科搜索（两组都要生成文本） | 中位 **5.4s**（1 步） | 中位 **10.1s**（2 进程） | **约 1.9×** |

省在哪里（实测分解）：

- ✅ **决策往返**：Jev 决策请求约 **0.35–0.52s/次**（整步合计约 1.0–1.4s），可用大模型 1.6–4.5s/次
  （实测 `kimi-k3` 1.8s、`minimax-m3` 1.6s、`glm-5.3` 3.2s、`qwen3.8-max` 3.5s、`deepseek-v4-pro` 4.5s）
  —— 2026-09-26 实测，服务端 `jev-1.13.0`；分阶段数字由 `renderJevSummary` 打印。
  旧文档的「单步决策约 1.0–1.5s」实为**整步耗时**，不是决策请求本身。
- ✅ **每步退出浏览器上下文**：B 每步一个新进程，A 全程 1 个（进程启动实测仅 250–350ms/次，不是主要成本）
- ✅ **省浏览器动作**（引擎重建后新增，现在是最大收益项）：默认观测是**一次 `page.evaluate`**
  自建 DOM 元素表（约 **2–4ms / ~2k 字符**），动作走**裸 CDP**（**13–16ms**）；
  旧路径是 `page.snapshot()` **110–130ms / 27484 字符**、`page.click(ref)` **788–1005ms**

> ⚠️ 上表是**引擎重建前**的测量（2026-09-19，3 对/任务，方差大）。重建后的数字见下。
> 目标能用选择器写死时，直接写代码比两者都快。基准脚本见 [`examples/bench/`](examples/bench/)。

### 引擎重建后（2026-09-22）

按剖析结果重建，不是按猜测——真实瓶颈是 **ego 的语义动作通道**，不是快照。
同任务隔离实验（5 臂 × 3 任务 × 3 次，全部 3/3 成功）：

| 任务 | 重建前 | 重建后 |
| --- | ---: | ---: |
| Hacker News 两步导航 | 4569ms | **1916ms** |
| httpbin 表单（填写+勾选+提交） | 6782ms | **3607ms** |
| 维基搜索（含文本生成） | 3663ms | 3634ms（受模型延迟主导，无变化） |

**与 browser-harness + jev-ultrafast 的预登记配对验证**（5 任务 × 2 栈 × 10 轮 = 100 轮，
bootstrap 95% CI，判定规则**跑前写死**）：

| 任务 | 结论 |
| --- | --- |
| HN 点击链 | **本体更快 −378ms**，CI[−1453,−313]，10/0 |
| 维基搜索 | **本体更快 −819ms**，CI[−1314,−195]；且只需 **1 次 Jev 决策**（对方 3 次）|
| 表单填写 | **无差异**（CI 跨 0）|
| 原生下拉 | 对方更快 **+248ms**，CI[163,426] |
| 翻页（目标在文档序 110/119）| 两栈都完不成 —— 能力边界，非速度问题 |

另外：**滚动若真的移动了视口或露出新元素就算进展** —— X 上必须连滚 >3 次的深帖任务 **0/6 → 6/6**。
详见 [`VERIFY-REPORT.md`](VERIFY-REPORT.md)，每个数字都能追到 [`bench/raw/`](bench/raw)。

## 架构

```
页面 ──page.evaluate──► 元素表（ref | role | 名称 | 当前值 | 勾选态 | 下拉选项 | 路径）
                        │
                        ▼
              单次 Jev 请求（并行、互不可见）
              ┌──────────────────────────────┐
              │ operation: click/type_text/… │
              │ click_target                 │ ← 只含可点元素
              │ type_text_target             │ ← 只含可输入元素
              │ select_target                │ ← 元素#选项序号
              │ input_text                   │ ← 候选文本（可选）
              └──────────────┬───────────────┘
                             ▼
                     只消费命中操作的那个头 → 执行 → 由代码判定是否达成
```

关键设计：

- **一次请求、多个 target 头**：避免串行的「先问操作再问目标」，也天然排除不兼容的目标
- **每个 target 头显式写明它假设的 operation**（并行问题读不到彼此答案）
- **`done` / `blocked` 就是 operation 之一**，不另设概率阈值
- **代码侧选项索引**：原生下拉的候选写成 `ref=6#2`，索引由代码持有，模型只做选择
- **Jev 无跨请求记忆**，所以「已完成步骤」由代码回填进 state，复合目标才稳
- **陈旧校验**：只执行与本次元素表一致的 ref，且比较页面变化时忽略 `#hash`

## 安装

### 方式 1：skills CLI（推荐，一行，支持 40+ 种 Agent）

```bash
npx skills add jiangkoumo/ego-jev
```

装完技能落在 Agent 的技能目录里（如 `~/.agents/skills/ego-jev/`），引擎和 CLI 一起带过去。

### 方式 2：克隆后跑安装脚本

```bash
git clone https://github.com/jiangkoumo/ego-jev.git
cd ego-jev
./install.sh          # 链接 CLI 进 ~/.local/bin，并准备凭证文件
./install.sh --wire   # 顺便接管官方 ego-browser 入口（见下）
./install.sh --test   # 顺带跑一次端到端冒烟测试
```

### 让 Agent 默认走 ego-jev（`--wire`）

ego lite 会把**官方** `ego-browser` 技能写进每个 Agent 的技能目录
（`~/.agents/skills/ego-browser`、`~/.claude/skills/ego-browser` …，由 App 在安装/升级时重建），
而官方正文不知道 ego-jev 存在——不管的话，Agent 默认照它写逐步脚本，ego-jev 根本不会被启动。

`scripts/wire-agent-skills.sh` 把这个入口接管成一层**路由层**（包外）：Agent 先看到的
「先路由、再决定写不写脚本」那一节是本技能加的，技能正文仍然软链到 App 的当前版本（升级自动跟随）：

```bash
bash scripts/wire-agent-skills.sh            # 接管 / 刷新（幂等；只写 Agent 技能目录，不碰应用包）
bash scripts/wire-agent-skills.sh --check     # 只读检查：入口还在不在、生成物是否过期（exit 1 = 需重跑）
bash scripts/wire-agent-skills.sh --restore   # 还原成官方软链（启用标记一并清掉）
```

退出码：`0` 正常 / `1` 需要处理（`--check` 发现漂移；或本次一个都没接管到）/ `2` 用法或环境错误。
`--vendor`（或 `EGO_JEV_VENDOR`）显式指定时就是权威：目录里没有 `SKILL.md` 直接报错，不回退自动探测。
`--check` 不只看生成物过期，也管「入口被 App 升回官方软链」「软链断向被删的旧版本目录」「入口直接不见了」，
并会提醒「官方技能是拷贝目录时脚本不覆盖」。`--restore` 不需要 ego lite 还在（不会自锁）。

接管会在 `~/.config/ego-jev/wire-enabled.json` 留下启用标记（含接管过的目录列表）；之后有两道自愈：
`./update.sh` 自动重接管/刷新（ego lite 升级会把入口重建回官方软链，甚至短时间变成断链），
`ego-jev` CLI 每次跑任务前也静默检查一次（实测 ~80ms，只在真漂移时才写盘；`EGO_JEV_NO_HEAL=1` 关闭）。
目录被记在标记里、入口又不见了时，会按启用意图把路由层重建回去。指向别处的软链不会被碰，
普通目录（官方技能的一份拷贝）不会被覆盖。路由只影响**新开的** Agent 会话（技能列表是启动时快照的）。

### 方式 3：把这段 prompt 丢给你的 Agent

> 帮我安装 https://github.com/jiangkoumo/ego-jev ：
> 1. 执行 `npx skills add jiangkoumo/ego-jev`（skills CLI 不可用就改成克隆仓库跑 `./install.sh`）；
> 2. 确认 `ego-browser --version` 正常，没有 ego lite 就先让我装；
> 3. 确认 `~/.config/typesafe/api_key` 存在且权限 600，缺了就问我要 Key——**不要自己编，也不要回显它**；
> 4. 跑下面「验证安装」里的命令，把真实输出和退出码报给我；
> 5. 接管官方 ego-browser 入口（让多步任务默认走 ego-jev）：`bash scripts/wire-agent-skills.sh`，
>    再用 `--check` 确认 exit 0。**只写 Agent 技能目录，不要改 `/Applications/ego lite.app` 里的任何文件。**

### 更新

```bash
cd ego-jev && ./update.sh          # 克隆安装：拉取 + 刷新软链 + 打印版本（幂等，可反复跑）
./update.sh --test                 # 顺带跑一次端到端冒烟
npx skills add jiangkoumo/ego-jev  # skills CLI 安装的：重跑一次即覆盖更新
```

`update.sh` 会自动判断你属于哪种安装方式：git 克隆就 `git pull --ff-only`（软链自动跟随，无需重装）；
skills CLI 装的是拷贝、会提示你重跑那条 `npx skills add`。**工作区有未提交改动时会跳过 pull**，
不会覆盖你的改动。

### 验证安装（别只看代码，跑起来）

```bash
ego-browser --version                                        # 前置条件
"<技能目录>/scripts/ego-jev" \
  --url "https://en.wikipedia.org/wiki/Main_Page" \
  --text "Jev" --until "/wiki/Jev" --steps 5 \
  "在搜索框输入 Jev 并提交"
# 期望：exit 0，且输出里 "success": true

# 接管过官方入口的话（--wire），看它是否还生效：
bash "<技能目录>/scripts/wire-agent-skills.sh" --check   # 期望：exit 0（漂移则 exit 1）
grep -l "先路由" ~/.agents/skills/ego-browser/SKILL.md     # 期望：打印出路径
```

### 凭证：必须落盘成文件

> **这是最容易踩的坑**：`ego-browser nodejs` 内嵌运行时只继承最小化登录环境（`HOME`/`PATH` 等），
> 父进程 `export` 的环境变量（含 `TYPESAFE_API_KEY`）**不会传进去**。所以凭证必须写成文件。

```bash
mkdir -p ~/.config/typesafe && printf '%s\n' 'YOUR_TYPESAFE_API_KEY' > ~/.config/typesafe/api_key
chmod 600 ~/.config/typesafe/api_key
```

从 [TypeSafe](https://docs.typesafe.ai) 获取 API Key。也可用 `TYPESAFE_API_KEY_FILE` 指定别的路径，
或 `--api-key` 直接传入。

查找顺序（全部是文件，因为 ego 运行时拿不到父进程环境变量）：
`--api-key` > `TYPESAFE_API_KEY`（仅普通 node 进程可见）> `TYPESAFE_API_KEY_FILE` >
`~/.config/ego-jev/credentials` > `~/.config/typesafe/api_key` >
`~/.zshrc` / `~/.bashrc` / `~/.bash_profile` / `~/.profile` 里的 `export TYPESAFE_API_KEY=…`。
所以已经 export 过 key 的机器不必再落盘一次。后端地址可用 `TYPESAFE_BASE_URL` 覆盖，
主后端失败时的降级端点用 `TYPESAFE_FALLBACK_BASE_URL`（不设即不降级，`fallback: false` 可关）——
**CLI 会在父进程读这两个变量并写进配置传给子进程**（ego 运行时自身读不到自定义环境变量）；
直接写 `ego-browser nodejs` 脚本时请改用 `options.baseUrl` / `options.fallbackBaseUrl`。

**没凭证也能先自测**：`ego-browser nodejs < bench/test-offline-e2e.mjs` 在 `about:blank` 上注入 DOM，
用 `options.ask` 注入确定性判定器（不联网、不需要 key），但观测、`locate`、裸 CDP 派发、结果断言
全走真实路径；失败时能分清是引擎坏了还是凭证/网络问题。

## 用法

命令行：

```bash
# 简单目标
ego-jev --url "https://example.com" "点击登录按钮并聚焦输入框"

# 推荐：给确定性成功条件（URL 包含该子串即判成功）
ego-jev --url "https://news.ycombinator.com" --until "/newcomments" \
  "先打开 new 页面，再打开 comments 页面"

# 需要输入文本：候选由调用方给，Jev 只选字段和选哪段文本
ego-jev --url "https://en.wikipedia.org/wiki/Main_Page" --text "Jev" \
  --until "/wiki/Jev" "在顶部搜索框输入 Jev 并提交"

# 复用已有 taskSpace，完成后保留供人工检查
ego-jev --space 3 --keep-space --steps 15 "点击未发送帖子并保存"
```

`--until` 给的是**确定性**退出条件，比依赖 Jev 自评 `done` 可靠得多，强烈建议带上。
退出码：`0` 达成 / `1` 未达成（此时 taskSpace 被保留供排查）/ `2` 参数错误 / `3` 缺凭证。

在 `ego-browser nodejs` 脚本里复用引擎：

```js
import { runJevAutonomousLoop } from "/path/to/ego-jev/ego-jev.mjs";

const result = await runJevAutonomousLoop(page, "先打开 new 页面，再打开 comments 页面", {
  maxSteps: 8,
  text: ["Jev"],                                                  // 可填文本候选（可选）
  check: async (p) => (await p.url()).includes("/newcomments"),    // 确定性成功条件（推荐）
});
console.log(result); // { success, reason, steps, history }
```

把「自动驾驶」作为**独立技能**装给 Agent（可选）：

```bash
npx skills add jiangkoumo/ego-jev          # 推荐
# 或本地链接：
mkdir -p ~/.agents/skills/ego-jev && ln -sfn "$PWD/SKILL.md" ~/.agents/skills/ego-jev/SKILL.md
```

> **不要**把 Jev 章节加进 ego lite 应用包里的 `SKILL.md`。那是供应商受签名的应用包，
> 升级会替换 `Resources/ego-skills/` 目录（版本号目录都会换），改动必然丢失。
> 本技能刻意放在包外，升级后无需重做。

## 文本生成（可选）

`--text` 的候选文本由调用方给出时，Jev 只做选择。若想让模型自己写文本（例如「搜索哥德尔不完备定理」
需要生成搜索词），配置一个 OpenAI 兼容端点：

```json
// ~/.config/typesafe/text_model.json
{
  "baseUrl": "https://your-endpoint/v1",
  "apiKeyJson": { "file": "~/.pi/agent/auth.json", "path": "opencode-go.key" },
  "model": "deepseek-v4.1-flash",
  "sessionHeader": "x-opencode-session",
  "sessionId": "ego-jev",
  "userAgent": "ego-jev/1.0"
}
```

- `apiKeyJson` **引用已有凭证文件**而不复制密钥；也可直接写 `apiKey`
- 生成结果**严格校验**：只接受恰好一个非空 `text` 字段的 JSON，不合格判 `text_model_failed` 而**不猜值**
- 也可在脚本里把 `textModel` 传成自定义 `async (input) => string` 函数接入任意模型
- `textModel: null` 显式禁用
- 实测某网关的 `deepseek-v4.1-flash` 会输出 `reasoning_content`，`reasoning:{enabled:false}` 无效，
  生成约 1.3–1.9s

## 退出原因

| reason | 含义 |
| --- | --- |
| `check_passed` / `jev_done` | 成功 |
| `blocked` | Jev 判定验证码/登录墙/无可用推进手段 |
| `no_progress` | 连续 5 次变更类动作页面无变化 |
| `stuck` | 同一动作连续 3 次无变化（含反复滚动） |
| `target_missing` | 选了需要目标的动作却没解析出目标（连续 2 次） |
| `no_targets` | 连续 3 次空快照（页面可能仍在加载） |
| `guard_rejected` | 执行前守卫拒绝（陈旧/遮挡/不可用，或命中危险动作词表 `dangerous_action`），该步未执行 |
| `text_model_failed` / `no_text_source` | 输入操作拿不到文本，**不会猜一个值填进去** |
| `action_failed` / `max_steps_reached` | 执行异常 / 超出步数预算 |

失败时先看 `reason` 再决定是否重试；不要盲目重跑同一目标。

## 已知限制（实测）

- **原生下拉的「选中项不在当前 options 里」有了一次重问**：选项在观测与执行之间被 JS 重建/重排时，
  不再当失败/无进展，而是**一次**带新选项的重问（`maxOptionRetries` 默认 1），重问仍失败才报 `stuck`。
- **旧的「维基语言选择器 2/3」基线元素已变**：`www.wikipedia.org` 的 77 项 `#searchLanguage`
  现在是 `opacity:0`（被自定义语言列表 UI 取代），引擎按可见性规则跳过它。同类任务在 DDG 设置页
  语言下拉实测 **6/6**（`bench/test-native-select.mjs`）。
- **默认的自建 DOM 元素表覆盖自定义控件，旧快照路径不覆盖**：实测 DuckDuckGo 设置页 DOM 有
  18 个复选框，默认 `observe: "dom"` 路径下 18 个全部进元素表（视口内 5 个；拉高视口后 18 个）；
  `observe: "snapshot"` 路径仍是 0 个（1×1 的自定义样式 input 不进辅助树）。
  部分站点的复选框在快照里既无定位器也无名称，只能按**文档顺序**兜底补齐；
  仅当数量完全一致时才敢用，否则显示「勾选态未知」而不会谎报。
- **无 role 的容器型可点元素已覆盖**：`<div onclick>` 卡片/行、`tabindex` 区块、`cursor:pointer`
  块级容器会被补成 `clickable-region`（映射到 `kind: clickable`，进同一套点击决策）。
  实测 YouTube 首页 3 个、X 首页 5 个；**真实 Jev 能选中它**（YouTube 视频元数据块 → `/watch`，
  见 `bench/test-realjev-region.mjs`）。与已收集的 a11y 元素做节点身份 + 祖先去重
  （嵌套容器只收最内层；被占满的容器、`<a href>` 内的容器、`<label for>` 都不与 a11y 元素双收），
  a11y 元素优先占预算。视口外的元素仍由「有界滚动揭示」处理（元素表只覆盖当前视口）。
- **跨 frame / shadow 的可点元素**：同源 iframe 与开放 shadow root 里的元素也进元素表。
  frame 内节点在主文档里没有 DOM 身份，因此打 `frameOrigin` 标：`locate` 做**逐层命中校验**
  （每层把点换算到该层坐标系，含 `clientLeft/clientTop`，断言该层 `elementFromPoint` **严格命中
  `<iframe>` 自身**）；任一层被遮挡即 `covered`、不派发，命中测试在元素自己的 root 里做。
  frame 链断 / `defaultView` 为 null → `frame_unresolved`；frame 元素到文档根的祖先链上有非 identity 的
  2D 线性变换（scale/rotate/skew）或 `zoom !== 1` → `frame_transformed`（纯平移、`translateZ(0)` 放行），
  两者都直接拒绝（不猜坐标、不退化成 {0,0}）。跨域 iframe 不处理。
- **危险动作前置拦截**：命中「支付/删除/退订」一类目标（中文 + 英文词表，我们自己的）时**不执行**，
  记为 `guardRejected=dangerous_action` 并**直接停**（不重试，重试不会让它变安全）。
  这是机制不是承诺——「不替你付款/删除」不再只靠 Jev 自评；`dangerGuard: false` 可整体关闭。
- **浏览器自动翻译会影响判断**：实测页面被译成中文后，元素名与选项名与目标语言不一致。
  Jev 跨语言选择正常，但 `--until` / `check` 用 UI 字符串比较会误判——请比对 URL 路径或 DOM 状态。
- **ego 运行时会静默吞掉两件事**（排查时很坑）：
  静态 `import ... from "node:http"` 会让整个脚本无输出、exit 0（必须用 `await import()`）；
  运行时不能起服务也不能访问 loopback（`fetch("http://127.0.0.1:...")` 会挂起后 exit 0）。
- **运行时拿不到自定义环境变量，且 `process.cwd()` 是 `/`**：`export FOO=bar` 在脚本里读不到，
  相对路径也不能用。要传配置只能在父进程把值替换进脚本文本（本项目的 CLI 就是这么做的）。
- **真实验证码/登录墙未测**（只在合成拦截页上验证过 `blocked` 分支）。
- Jev 走完**不等于业务正确**，最终页面状态仍要按 ego-browser skill 的观察纪律复核。

## 复跑基准

```bash
cd examples/bench
# 编辑 task.json（目标/URL/验证子串），然后：
./run-pair.sh A                 # ego-jev 单进程闭环
./run-pair.sh B kimi-k3         # 经典循环：每步一个进程 + 大模型
```

基准脚本需要 OpenCode Go（或任何 OpenAI 兼容网关）的凭证，路径写在脚本里，按需修改。

历史 A/B 对照的报告（`VERIFY-REPORT.md`、`PORT-REPORT.md`、`REVEAL-REPORT.md`、`BH-PORT-REPORT.md`）里，
**B 臂**是 `browser-harness + jev-ultrafast`。它的引擎已经移植进 `scripts/ego-jev.mjs`，宿主 `bh` 也已移除，
所以**驱动脚本已撤出仓库**（在 git 历史里，如 `git show 599a49b:bench/run-b.py`）。
已发布的 B 栈数字仍可复算：原始数据在 `bench/raw/`，`bench/analyze-*.mjs` 会从它重算表格。

现在只剩 A 臂，编排脚本与它自带的预检：

```bash
bash bench/verify.sh --check-env        # 预检（0 = ego-browser 就绪）
bash bench/verify.sh 10                 # 5 任务 × 10 轮，结果落 bench/raw/
--a-only                               # 旧命令，仍接受（现在只有 A 臂）
BENCH_OUT_DIR=/tmp/x bash bench/verify.sh 1   # 或写到别处，不污染仓库
```

仓库里有一条不变量测试守着这件事：`node bench/test-no-bh-dependency.mjs`（可执行脚本中不许出现
browser-harness 的调用面；驱动脚本不得回流；`--check-env` 契约成立）。

## 仓库结构

```
SKILL.md                 技能本体（刻意放在根目录——`npx skills add` 就是找它）
AGENTS.md                给其他 Agent 的安装/验证指令（可直接粘贴的 prompt 在里面）
scripts/ego-jev.mjs      引擎
scripts/ego-jev          CLI（自动在 同目录 / 仓库根 / ~/.agents/lib 里找引擎）
scripts/wire-agent-skills.sh   把官方 ego-browser 入口接管成路由层（--check / --restore）
overlay/ego-browser/     路由层的模板（接管时渲染到 Agent 技能目录）
examples/bench/          A/B 对照基准脚本（CLI 闭环 vs 每步大模型）
bench/verify.sh          A 臂验证编排（--check-env 预检；结果落 bench/raw/ 或 BENCH_OUT_DIR）
bench/test-no-bh-dependency.mjs  「不依赖 browser-harness」的不变量测试
install.sh               手工安装（接 CLI 进 PATH、准备凭证；`--wire` 顺便接管入口）
update.sh                一键更新（幂等；自动识别克隆/拷贝两种安装方式，并重接管入口）
```

## 致谢

- [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)（MIT）—— 本项目的运行基础。
  根目录的 `SKILL.md` 是本项目自带的**附加技能**，装在应用包之外，不是对它的文档做的修改
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT, Copyright (c) 2026 Browser Use）
  —— 本项目的**响应校验、动作执行器、观测层元素表、提示词规则与整体架构**部分由该项目翻译/改写而来。
  许可声明见 [`THIRD-PARTY.md`](THIRD-PARTY.md)；分级依据与并排证据见
  [`THIRD-PARTY-ASSESSMENT.md`](THIRD-PARTY-ASSESSMENT.md) 与 [`bench/raw/third-party-excerpts.md`](bench/raw/third-party-excerpts.md)
- [TypeSafe](https://docs.typesafe.ai) —— Jev / System One

本项目**没有**再分发 ego-lite 的任何文档或代码；`skill/ego-jev-section.md` 仅包含我们自己撰写的章节。

## License

MIT，见 [LICENSE](LICENSE)。
