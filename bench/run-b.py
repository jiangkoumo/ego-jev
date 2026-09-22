"""B 栈驱动器：browser-harness + jev-ultrafast，计时协议与 A 栈对齐。

用法（BU_CDP_WS 由 bh ensure 提供）:
  JEV_ULTRAFAST_DIR=<jev-ultrafast 仓库路径> uv run --env-file .env python bench/run-b.py hn-nav

与 A 栈对齐的计时口径：Agent 构造完成（页面已加载）之后才 t0，随后逐步决策；
每一步之后与下一轮开始前都检查一次成功条件。输出一行 JSON 到 stdout。
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
from jev_ultrafast import Agent  # noqa: E402

TASKS = {
    "hn-nav": (
        "https://news.ycombinator.com",
        "先打开 new 页面，再打开 comments 页面",
        lambda u: "/newcomments" in u,
        6,
    ),
    "wiki-search": (
        "https://en.wikipedia.org/wiki/Main_Page",
        "在顶部搜索框输入 Jev 并提交搜索",
        # 按回车与点 Search 按钮是两个不同的合法终态，两者都算搜索已提交
        lambda u: ("/wiki/JEV" in u)
        or ("/wiki/Japanese_encephalitis" in u)
        or ("index.php?search=" in u)
        or ("Special:Search" in u),
        6,
    ),
    "httpbin-form": (
        "https://httpbin.org/forms/post",
        "把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单",
        lambda u: u.rstrip("/").endswith("/post") and "/forms/" not in u,
        8,
    ),
}

task_id = sys.argv[1]
url, goal, done_when, max_steps = TASKS[task_id]

out = {"stack": "B", "task": task_id, "url": url}
agent = Agent(url, [goal])
try:
    time.sleep(0.8)  # 与 A 栈的「导航后等 800ms」对齐
    steps = 0
    started = time.perf_counter()
    success = False
    while steps < max_steps:
        if done_when(agent.state["page"]["url"]):
            success = True
            break
        agent.command("tick")
        steps += 1
        if agent.state["status"] in {"done", "blocked"}:
            success = agent.state["status"] == "done"
            break
    elapsed = round((time.perf_counter() - started) * 1000)
    final = agent.state["page"]["url"]
    if done_when(final):
        success = True
    history = agent.state["history"]
    out.update(
        elapsedMs=elapsed,
        steps=steps,
        success=success,
        status=agent.state["status"],
        finalUrl=final,
        jevCalls=len(agent.state["decisions"]),
        textCalls=len(agent.state["text_calls"]),
        perStepMs=[h.get("latency_ms") for h in history],
        actionLabels=[h.get("action") for h in history],
        elapsedPerAction=[h.get("elapsed_ms") for h in history],
        jevLatencyMs=[d.get("latency_ms") for d in agent.state["decisions"]],
        textLatencyMs=[t.get("latency_ms") for t in agent.state["text_calls"]],
    )
finally:
    agent.close()

print(json.dumps(out, ensure_ascii=False))
