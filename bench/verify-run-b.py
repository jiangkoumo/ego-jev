"""B 栈验证运行器（预登记协议 §2/§3）：browser-harness + jev-ultrafast。

判据与 A 栈逐字对应，只用终态 URL / 页面断言，不看"点了哪个按钮"。
页面断言取 B 观测层返回的 page["text"]（视口内可见文本）与 page["title"]。
用法（BU_CDP_WS 由 bh ensure 提供）:
  JEV_ULTRAFAST_DIR=<jev-ultrafast 仓库路径> uv run --env-file .env python bench/verify-run-b.py <task-id>
"""

import json
import os
import re
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

RE_WIKI_TITLE = re.compile(r"Japanese encephalitis|Search results", re.I)
RE_CUSTNAME = re.compile(r'custname"\s*:\s*"Jev"')
RE_TOPPING = re.compile(r'topping"\s*:\s*"bacon"')
RE_SELECTED_DANSK = re.compile(r"Selected:\s*Dansk")


def assert_hn_nav(page):
    ok = "/newcomments" in page["url"]
    return ok, page["url"]


def assert_hn_page2(page):
    ok = "p=2" in page["url"]
    return ok, page["url"]


def assert_wiki(page):
    url, title = page["url"], page.get("title") or ""
    ok = ("Main_Page" not in url) and (bool(RE_WIKI_TITLE.search(title)) or "search=" in url)
    return ok, f'title="{title[:80]}" url={url[:70]}'


def assert_httpbin_form(page):
    text = page.get("text") or ""
    ok = bool(RE_CUSTNAME.search(text)) and bool(RE_TOPPING.search(text))
    return ok, f'custname={bool(RE_CUSTNAME.search(text))} topping={bool(RE_TOPPING.search(text))} url={page["url"][:60]}'


def assert_select_native(page):
    text = page.get("text") or ""
    ok = bool(RE_SELECTED_DANSK.search(text))
    return ok, f'text="{text.strip()[:40]}" url={page["url"][-20:]}'


TASKS = {
    "hn-nav": ("https://news.ycombinator.com", "先打开 new 页面，再打开 comments 页面", assert_hn_nav, 6),
    "hn-page2": ("https://news.ycombinator.com", "翻到下一页（More）", assert_hn_page2, 8),
    "wiki-search": (
        "https://en.wikipedia.org/wiki/Main_Page",
        "在顶部搜索框输入 Jev 并提交搜索",
        assert_wiki,
        6,
    ),
    "httpbin-form": (
        "https://httpbin.org/forms/post",
        "把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单",
        assert_httpbin_form,
        8,
    ),
    "select-native": ("http://127.0.0.1:8099/c.html", "把语言下拉框改选为 Dansk，然后点击 Confirm", assert_select_native, 6),
}

task_id = sys.argv[1]
url, goal, assert_fn, max_steps = TASKS[task_id]

out = {"stack": "B", "task": task_id, "url": url}
agent = Agent(url, [goal])
try:
    time.sleep(0.8)  # 与 A 栈「导航后等 800ms」对齐
    steps = 0
    started = time.perf_counter()
    status = agent.state["status"]
    while steps < max_steps:
        if assert_fn(agent.state["page"])[0]:
            break
        if status in {"done", "blocked"}:
            break
        agent.command("tick")
        steps += 1
        status = agent.state["status"]
    elapsed = round((time.perf_counter() - started) * 1000)
    ok, detail = assert_fn(agent.state["page"])
    history = agent.state["history"]
    out.update(
        elapsedMs=elapsed,
        steps=steps,
        success=ok,
        reason=f"status={status}",
        finalUrl=agent.state["page"]["url"],
        assertDetail=detail,
        jevCalls=len(agent.state["decisions"]),
        textCalls=len(agent.state["text_calls"]),
        jevLatencyMs=[d.get("latency_ms") for d in agent.state["decisions"]],
        textLatencyMs=[t.get("latency_ms") for t in agent.state["text_calls"]],
        perStepMs=[h.get("latency_ms") for h in history],
        actionLabels=[h.get("action") for h in history],
    )
finally:
    agent.close()

print(json.dumps(out, ensure_ascii=False))
