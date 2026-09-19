# 基准脚本

对照两种循环，回答「Jev 闭环到底省不省时间」：

- **A**：`ego-jev` 单进程闭环，每步由 Jev 决策
- **B**：经典循环——**每步一个独立进程** + 大模型以文本提示决策（就是「每走一步退出来交由大模型慢思考」的形态）

两组使用**同一元素表、同一任务、同一验证器**；计时都从导航之后开始。

```bash
# 1) 编辑 task.json（url / goal / verify / maxSteps[/texts]）
# 2) 跑对照（建议交替多轮取中位数）
./run-pair.sh A
./run-pair.sh B kimi-k3
```

环境变量：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `EGO_JEV_LIB` | 引擎路径 | 从 cwd 向上找 `ego-jev.mjs` |
| `BENCH_BASE_URL` | OpenAI 兼容网关 | `https://opencode.ai/zen/go/v1` |
| `BENCH_API_KEY` | 网关密钥（优先） | — |
| `BENCH_AUTH_FILE` / `BENCH_AUTH_PATH` | 从已有凭证文件按路径取密钥 | `~/.pi/agent/auth.json` / `opencode-go.key` |
| `BENCH_MODEL` | 对照组使用的大模型 | `kimi-k3` |
| `BENCH_TEXT_MODEL` | 需要生成文本时用的模型 | `deepseek-v4.1-flash` |
| `EGO_BROWSER_BIN` | ego-browser 可执行文件 | `ego-browser` |

注意：ego 内嵌运行时不能访问 loopback，所以不要在 ego 脚本里起本地服务；网关必须是外网可达的。

## 本项目自测结果（2026-09-19，macOS，ego lite 0.5.0.32，jev-1.13）

| 任务 | A | B | 结果 |
| --- | ---: | ---: | --- |
| HN 两步复合导航 | 中位 4.9s（1 进程，12 次浏览器调用） | 中位 9.7s（3 进程） | 约 2.0× |
| 维基百科搜索（两组都生成文本） | 中位 5.4s（1 步） | 中位 10.1s（2 进程） | 约 1.9× |

只有 3 对样本/任务，方差很大（对照组单轮 7.3s–22s），**不构成基准**。
