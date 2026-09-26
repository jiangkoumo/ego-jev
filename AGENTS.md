# AGENTS.md

给安装、验证、或修改本仓库的 AI Agent 看的说明。

## 这是什么

`ego-jev` 用 [TypeSafe](https://docs.typesafe.ai) 的 System One 模型 **Jev** 替代浏览器自动化里
「每步回到大模型思考」的往返：输入一张**索引化元素表**，一次请求返回**操作 + 目标元素**，
观察/执行/校验/退出条件都由代码负责。

它建立在 [ego lite](https://github.com/citrolabs/ego-lite)（`ego-browser`）之上，是**外挂**，
**从不修改 ego lite 应用包**。

## 安装

```bash
npx skills add jiangkoumo/ego-jev      # 推荐，一行装进 Agent 技能目录（含引擎与 CLI）
# 或：git clone https://github.com/jiangkoumo/ego-jev.git && cd ego-jev && ./install.sh --test
```

## 装完必须验证（别只看代码，跑起来）

```bash
ego-browser --version                                   # 前置条件
test -f ~/.config/typesafe/api_key && echo "key ok"     # 凭证存在
"<技能目录>/scripts/ego-jev" \
  --url "https://en.wikipedia.org/wiki/Main_Page" \
  --text "Jev" --until "/wiki/Jev" --steps 5 \
  "type Jev into the search box and submit"

# 接管过官方 ego-browser 入口的话，确认它还生效：
bash "<技能目录>/scripts/wire-agent-skills.sh" --check   # 期望 exit 0
```

期望：**exit 0** 且输出含 `"success": true`。退出码：`0` 达成 / `1` 未达成（space 保留供排查）
/ `2` 参数错误 / `3` 缺凭证。

## 硬约束

- **不要写 ego lite 应用包**（`/Applications/ego lite.app/…`）：供应商受签名，升级会替换
  `Resources/ego-skills/`，改动必然丢失。扩展只放包外。
- **接管官方入口只能在包外**：ego lite 会把官方 `ego-browser` 技能写进每个 Agent 的技能目录
  （`~/.agents/skills/ego-browser` 等），并在升级时重建。要加路由就改包外那一层，
  用 `scripts/wire-agent-skills.sh`（幂等、可 `--restore`），别改包内 SKILL.md。
- **凭证必须落盘成文件**：`ego-browser nodejs` 内嵌运行时只继承最小化登录环境，
  `TYPESAFE_API_KEY` 之类的**自定义环境变量不会传进去**。写到 `~/.config/typesafe/api_key`（600）。
- 不要提交任何密钥；文本模型配置可用 `apiKeyJson` 按路径引用已有凭证，不要复制。
- 保持可被 `npx skills add` 安装：`SKILL.md` 必须在仓库根，且只用相对路径引用 `scripts/…`。

## 运行时事实（实测踩过的坑，能省你很多时间）

| 行为 | 详情 |
| --- | --- |
| 静态 import 内置模块会静默杀死脚本 | `import { x } from "node:http"` → 无输出、exit 0。必须 `await import("node:…")` |
| 不能起服务、不能访问 loopback | `server.listen()` 回调不触发；`fetch("http://127.0.0.1:…")` 挂起后 exit 0；外部 HTTPS 正常 |
| `process.cwd()` 是 `/` | 脚本里不要依赖相对路径 |
| 自定义环境变量被剥离 | 传配置要在父进程把值替换进脚本文本 |
| `loc` 里可能含 `]` | 属性要从第一个 `[` 解析到**最后一个** `]`，否则 `input[name="a"]` 会被截断 |
| 勾选态不在快照里 | 用一次批量 `page.evaluate()` 读；DOM 与快照数量不一致时报告「未知」，不许猜 |
| 浏览器开着自动翻译 | 元素名/选项名可能被翻译；`--until` 不许比较 UI 字符串，比 URL 路径或 DOM 状态 |

## 仓库结构

```
SKILL.md                 技能本体（刻意放根目录，`npx skills add` 就是找它）
scripts/ego-jev.mjs      引擎
scripts/ego-jev          CLI（自动在 同目录 / 仓库根 / ~/.agents/lib 里找引擎）
scripts/wire-agent-skills.sh  把官方 ego-browser 入口接管成路由层（幂等，可 --check / --restore）
overlay/ego-browser/     路由层模板（渲染到 Agent 技能目录，不是装进应用包）
examples/bench/          A/B 对照基准（Jev 闭环 vs 每步大模型循环）
install.sh               手工安装（接 CLI 进 PATH + 准备凭证；`--wire` 顺便接管入口）
update.sh                一键更新（接管过则自动重接管）
```

## 开发约定

- 引擎改动在 `scripts/ego-jev.mjs`，保持导出稳定：`askJev`、`parseActionTargets`、`enrichTargets`、
  `buildQuestions`、`runJevStep`、`runJevAutonomousLoop`、`generateText`、`loadTextModelConfig`、
  `resolveTextApiKey`、`loadApiKey`。
- 改完引擎要重跑上面的冒烟测试**和** `./examples/bench/run-pair.sh A`。
- 改 `scripts/wire-agent-skills.sh` / `overlay/` 要重跑 `node bench/test-wire-skill.mjs`
  （用临时 HOME 造官方软链，无需浏览器与凭证），并在真机上 `--check` 一次。
- `scripts/ego-jev` 启动时会调 `wire-agent-skills.sh --if-enabled` 自愈（只在有启用标记时动手，失败静默，
  `EGO_JEV_NO_HEAL=1` 或 `EGO_JEV_CONFIG_DIR` 可控制）；改这块要重跑同一个单测（[29] 段覆盖）。
- 接管脚本要兼容 macOS 自带的 bash 3.2（没有 `local -n`、关联数组、`mapfile`）。
- 生成物必须确定性（不能写时间戳/随机数），否则 `--check` 会永远报漂移。
- 接管层只在 Agent 技能目录里写：`SKILL.md` 是生成的，`references/`、`scripts/`、`learnings/`
  是软链——不要把正文拷进去（会跟 App 版本脱节）。
- 只用真实命令输出和退出码宣称完成；不确定就明说哪一步失败。
- 报基准数字必须带上产生它的脚本。
