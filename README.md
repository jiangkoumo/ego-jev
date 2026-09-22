# ego-jev

[![skills.sh](https://skills.sh/b/jiangkoumo/ego-jev)](https://skills.sh/jiangkoumo/ego-jev)

**用 Jev（TypeSafe System One）驱动 ego lite 浏览器，把「下一步点哪里」的决策放进单个进程内闭环。**

> English summary: `ego-jev` replaces the per-step LLM round trip in browser automation with
> [TypeSafe](https://docs.typesafe.ai)'s System One model **Jev**. Jev reads one *indexed element
> table* and answers, in a single request, both the **operation** (`click` / `type_text` / `select` /
> `scroll_up` / `scroll_down` / `wait` / `done` / `blocked`) and the **target element**. Code owns
> observation, execution, verification and exit conditions. See [Benchmarks](#实测) — roughly **2×**
> faster than a per-step large-model loop on two measured tasks (3 pairs each, high variance).

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

- ✅ **决策往返**：Jev 约 1.0–1.5s/次，可用大模型 1.6–4.5s/次
  （实测 `kimi-k3` 1.8s、`minimax-m3` 1.6s、`glm-5.3` 3.2s、`qwen3.8-max` 3.5s、`deepseek-v4-pro` 4.5s）
- ✅ **每步退出浏览器上下文**：B 每步一个新进程，A 全程 1 个（进程启动实测仅 250–350ms/次，不是主要成本）
- ❌ **不省浏览器动作**：两边都是每步 1 次 `page.snapshot()` + 1 次批量 `page.evaluate()`

> ⚠️ 只有 3 对样本/任务且**方差很大**（对照组单轮 7.3s–22s），不构成基准。
> 目标准能用选择器写死时，直接写代码比两者都快。基准脚本见 [`examples/bench/`](examples/bench/)。

## 架构

```
页面 ──snapshot──► 索引化元素表（ref | role | 名称 | 当前值 | 勾选态 | 下拉选项 | 路径）
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

关键设计（借鉴 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)）：

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
./install.sh --test   # 顺带跑一次端到端冒烟测试
```

### 方式 3：把这段 prompt 丢给你的 Agent

> 帮我安装 https://github.com/jiangkoumo/ego-jev ：
> 1. 执行 `npx skills add jiangkoumo/ego-jev`（skills CLI 不可用就改成克隆仓库跑 `./install.sh`）；
> 2. 确认 `ego-browser --version` 正常，没有 ego lite 就先让我装；
> 3. 确认 `~/.config/typesafe/api_key` 存在且权限 600，缺了就问我要 Key——**不要自己编，也不要回显它**；
> 4. 跑下面「验证安装」里的命令，把真实输出和退出码报给我。

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
  --text "Jev" --until "/wiki/JEV" --steps 5 \
  "在搜索框输入 Jev 并提交"
# 期望：exit 0，且输出里 "success": true
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
  --until "/wiki/JEV" "在顶部搜索框输入 Jev 并提交"

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
| `text_model_failed` / `no_text_source` | 输入操作拿不到文本，**不会猜一个值填进去** |
| `action_failed` / `max_steps_reached` | 执行异常 / 超出步数预算 |

失败时先看 `reason` 再决定是否重试；不要盲目重跑同一目标。

## 已知限制（实测）

- **改选后需再点确认按钮的原生下拉**不稳定：Jev 可能重复改选同一选项而被 `stuck` 拦住。
  实测带 `--until` + `--steps ≥6` 约 2/3 成功，失败时明确报 `stuck` 而非静默错误。
  这类任务要么给 `--until`，要么把两步动作写死。
- **并非所有控件都进快照**：实测 DuckDuckGo 设置页 DOM 有 18 个复选框，快照里 0 个
  （自定义样式的隐藏 input 不进辅助树）——这类元素引擎无从感知。
  而部分站点的复选框在快照里既无定位器也无名称，只能按**文档顺序**兜底补齐；
  仅当数量完全一致时才敢用，否则显示「勾选态未知」而不会谎报。
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

## 仓库结构

```
SKILL.md                 技能本体（刻意放在根目录——`npx skills add` 就是找它）
AGENTS.md                给其他 Agent 的安装/验证指令（可直接粘贴的 prompt 在里面）
scripts/ego-jev.mjs      引擎
scripts/ego-jev          CLI（自动在 同目录 / 仓库根 / ~/.agents/lib 里找引擎）
examples/bench/          A/B 对照基准脚本
install.sh               手工安装（不装技能，只把 CLI 接进 PATH 并准备凭证）
update.sh                一键更新（幂等；自动识别克隆/拷贝两种安装方式）
```

## 致谢

- [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)（MIT）—— 本项目的运行基础。
  根目录的 `SKILL.md` 是本项目自带的**附加技能**，装在应用包之外，不是对它的文档做的修改
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) —— 架构灵感来源
  （dynamic operation + target、代码侧选项索引、推测性 target 头）
- [TypeSafe](https://docs.typesafe.ai) —— Jev / System One

本项目**没有**再分发 ego-lite 的任何文档或代码；`skill/ego-jev-section.md` 仅包含我们自己撰写的章节。

## License

MIT，见 [LICENSE](LICENSE)。
