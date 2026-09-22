// A 栈验证运行器（预登记协议 §2/§3）。模板：__TASK__ 由 verify.sh 替换。输出一行 JSON。
// 判据只用终态 URL / 页面断言，不看"点了哪个按钮"。
const { readFile } = await import("node:fs/promises");
// 仓库根：本文件是模板，由 verify.sh 用 sed 注入 __REPO__；若直接跑则回退到已安装技能。
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { BENCH, JE, RAW, loadBenchApiKey, loadBenchTextModel } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行，或先 npx skills add jiangkoumo/ego-jev`);
});
const { runJevAutonomousLoop } = await import(JE);

const RE_WIKI_TITLE = /Japanese encephalitis|Search results/i;
const RE_CUSTNAME = /custname"\s*:\s*"Jev"/;
const RE_TOPPING = /topping"\s*:\s*"bacon"/;
const RE_SELECTED_DANSK = /Selected:\s*Dansk/;

const TASKS = {
  "hn-nav": {
    url: "https://news.ycombinator.com",
    goal: "先打开 new 页面，再打开 comments 页面",
    maxSteps: 6,
    assert: async (page) => {
      const url = await page.url();
      return { ok: url.includes("/newcomments"), detail: url };
    },
  },
  "hn-page2": {
    url: "https://news.ycombinator.com",
    goal: "翻到下一页（More）",
    maxSteps: 8,
    assert: async (page) => {
      const url = await page.url();
      return { ok: url.includes("p=2"), detail: url };
    },
  },
  "wiki-search": {
    url: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "在顶部搜索框输入 Jev 并提交搜索",
    maxSteps: 6,
    assert: async (page) => {
      const url = await page.url();
      const title = await page.title();
      const ok = !/Main_Page/.test(url) && (RE_WIKI_TITLE.test(title) || url.includes("search="));
      return { ok, detail: `title="${title.slice(0, 80)}" url=${url.slice(0, 70)}` };
    },
  },
  "httpbin-form": {
    url: "https://httpbin.org/forms/post",
    goal: "把 Customer name 填成 Jev，勾选 topping 里的 Bacon，然后提交表单",
    maxSteps: 8,
    assert: async (page) => {
      const url = await page.url();
      const text = await page.evaluate(() => document.body.innerText);
      const ok = RE_CUSTNAME.test(text) && RE_TOPPING.test(text);
      return { ok, detail: `custname=${RE_CUSTNAME.test(text)} topping=${RE_TOPPING.test(text)} url=${url.slice(0, 60)}` };
    },
  },
  "select-native": {
    url: "http://127.0.0.1:8099/c.html",
    goal: "把语言下拉框改选为 Dansk，然后点击 Confirm",
    maxSteps: 6,
    assert: async (page) => {
      const text = await page.evaluate(() => document.body.innerText);
      return { ok: RE_SELECTED_DANSK.test(text), detail: `text="${text.trim().slice(0, 40)}" url=${(await page.url()).slice(-20)}` };
    },
  },
};

const taskId = "__TASK__";
const task = TASKS[taskId];
const KEY = await loadBenchApiKey();
const textModel = await loadBenchTextModel();

const space = await taskSpace(`ego-verify-${taskId}-${Date.now()}`);
const page = space.page("p1");
let out = { stack: "A", task: taskId, url: task.url };
try {
  await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(800);
  const metrics = {};
  const t0 = Date.now();
  const r = await runJevAutonomousLoop(page, task.goal, {
    apiKey: KEY, textModel, maxSteps: task.maxSteps, metrics,
    check: async (p) => (await task.assert(p)).ok,
  });
  const elapsedMs = Date.now() - t0;
  const verdict = await task.assert(page);
  out = {
    ...out,
    elapsedMs, steps: r.steps, success: verdict.ok, reason: r.reason,
    finalUrl: await page.url(), assertDetail: verdict.detail,
    jevCalls: metrics["jev.request"] || 0,
    textCalls: r.history.filter((h) => h.text && h.action?.startsWith("type_text")).length,
    protocolCalls: Object.values(metrics).reduce((a, b) => a + b, 0),
    perStepMs: r.history.map((h) => h.stepDurationMs),
    actionLabels: r.history.map((h) => `${h.action}${h.target ? ":" + h.target : ""}${h.option ? "=" + h.option : ""}`),
    invalidResponses: r.history.filter((h) => h.invalidResponse).length,
    guardRejected: r.history.filter((h) => h.guardRejected).length,
  };
} catch (e) {
  out = { ...out, elapsedMs: null, steps: null, success: false, reason: "harness_error", error: String(e).slice(0, 200) };
}
try { await space.finish({ keep: [] }); } catch { /* 空间已关闭 */ }
console.log(JSON.stringify(out));
