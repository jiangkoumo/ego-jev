"""B 栈（browser-harness + jev-ultrafast）在同类滚动密集任务上的对照。

用法（BU_CDP_WS 由 bh ensure 提供）:
  JEV_ULTRAFAST_DIR=<jev-ultrafast 仓库路径> uv run --env-file .env python bench/reveal-run-b.py <task-id>

判据与 A 栈同类：终态 URL。X 侧只读（不点击发布/回复/转发/点赞、不输入内容）。
"""

import json
import os
import sys
import time

# B 栈对照需要 jev-ultrafast 仓库；它不在本仓库里，所以用环境变量显式给出（原来写死了本机路径）
_JEV_ULTRAFAST = os.environ.get("JEV_ULTRAFAST_DIR")
if not _JEV_ULTRAFAST:
    raise SystemExit("请设置 JEV_ULTRAFAST_DIR=<jev-ultrafast 仓库路径>（B 栈对照需要它）")
sys.path.insert(0, _JEV_ULTRAFAST)
try:
    import browser_harness  # noqa: F401  （B 栈的真实依赖；本机可能已移除 bh）
except ImportError:
    raise SystemExit(
        "B 栈脚本需要 browser-harness。本机若已移除 bh，只想跑 A 臂就用："
        "bash bench/verify.sh <轮数> --a-only（产品路径与 A 臂都不依赖它）"
    )
from jev_ultrafast import Agent  # noqa: E402

TASKS = {
    # X：首屏内的帖子（对照组）
    "x-first": (
        "https://x.com/home",
        "不要使用搜索框。打开时间线上第一条帖子的详情页（点它的时间戳链接）",
        lambda u: "/status/" in u,
        6,
    ),
    # X：首屏之外的帖子（需要滚动）
    "x-scroll": (
        "https://x.com/home",
        "不要使用搜索框。向下滚动时间线，打开一条首屏之外的帖子的详情页（点它的时间戳链接）",
        lambda u: "/status/" in u,
        10,
    ),
    # Wikipedia 搜索结果：首屏内 / 首屏外
    "wiki-first": (
        "https://en.wikipedia.org/w/index.php?search=Jev&fulltext=1",
        "不要使用搜索框重新检索。在当前结果列表里找到并打开标题为「Japanese encephalitis」的条目",
        lambda u: "/wiki/Japanese_encephalitis" in u,
        6,
    ),
    "wiki-deep": (
        "https://en.wikipedia.org/w/index.php?search=Jev&fulltext=1",
        "不要使用搜索框重新检索。在当前结果列表里找到并打开标题为「Jevons paradox」的条目",
        lambda u: "/wiki/Jevons_paradox" in u,
        8,
    ),
}

task_id = sys.argv[1]
url, goal, done_when, max_steps = TASKS[task_id]

out = {"stack": "B", "task": task_id, "url": url}
agent = Agent(url, [goal])
try:
    time.sleep(0.8)
    steps = 0
    started = time.perf_counter()
    status = agent.state["status"]
    while steps < max_steps:
        if done_when(agent.state["page"]["url"]):
            break
        if status in {"done", "blocked"}:
            break
        agent.command("tick")
        steps += 1
        status = agent.state["status"]
    elapsed = round((time.perf_counter() - started) * 1000)
    final = agent.state["page"]["url"]
    out.update(
        elapsedMs=elapsed,
        steps=steps,
        success=bool(done_when(final)),
        reason=f"status={status}",
        finalUrl=final,
        jevCalls=len(agent.state["decisions"]),
        actionLabels=[h.get("action") for h in agent.state["history"]],
        textCalls=len(agent.state["text_calls"]),
    )
finally:
    agent.close()

print(json.dumps(out, ensure_ascii=False))
