// P0-1 验收：DOM 里「可点但没有 role」的容器型元素必须进元素表，并且真的能点。
//
// 为什么需要：旧候选选择器只认 a[href]/button/input/…/[role=…]，`<div onclick>` 卡片、行、
// tabindex 区块、cursor:pointer 自定义控件在 roleOf 里拿不到角色就被 `if (!role) continue` 整批丢掉。
// 本文件在 about:blank 上自造 DOM（完全不联网、不需要凭证），走真实的观测 + locate + 裸 CDP 派发：
//   [1] 元素表补全：cursor:pointer / onclick / tabindex 的容器进表，role=clickable-region
//   [2] 真的能点：派发真实鼠标事件后页面上的 window.__hit 变成 1（断言真实 DOM，不是 mock 回显）
//   [3] 去重：嵌套容器只收最内层；包住 <button> 的外层容器不收；<label for> 不与控件双收
//   [4] 预算优先级：a11y 元素仍然优先，容器型只在剩余额度里补
//
// 用法（测当前工作树）: sed "s|__REPO__|$PWD|g" bench/test-clickable-regions.mjs | ego-browser nodejs
// 直接 `< bench/test-clickable-regions.mjs`：走已安装技能（~/.agents/skills/ego-jev，本机是指向仓库的软链）
const { writeFile, mkdir } = await import("node:fs/promises");
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-jev";
const { BENCH, JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});
const { runJevStep } = await import(JE);

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ── 假 Jev：从请求体里真实的 criteria 键集合生成合法回答（默认 wait，不产生副作用）──
const realFetch = globalThis.fetch;
let lastBody = null;
let prefer = { operation: "wait" };
const stubJev = () => {
  globalThis.fetch = async (_url, init) => {
    lastBody = init.body;
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [head, question] of Object.entries(body.questions)) {
      const keys = Object.keys(question.criteria);
      const want = prefer[head];
      const choice = want && keys.includes(want) ? want : keys.find((k) => k !== "none") ?? keys[0];
      const rest = keys.filter((k) => k !== choice);
      const probabilities = { [choice]: 0.9 };
      for (const k of rest) probabilities[k] = 0.1 / rest.length;
      answers[head] = { choice, confidence: 0.9, probabilities };
    }
    return { ok: true, async json() { return { model: "stub", answers, usage: {} }; } };
  };
};

/** 从请求体的元素表里取某一行（ref | role | "名称" | …） */
const tableLines = (state) => (state.split("当前视口内可交互元素")[1] || "").split("\n").filter((l) => l.includes("ref="));
const findRef = (state, role, namePart) => {
  const line = tableLines(state).find((l) => l.includes(`| ${role} |`) && l.includes(namePart));
  return line ? (line.match(/ref=(\d+)/) || [])[1] : null;
};

// ── 自造 DOM：容器型可点元素 + 去重陷阱 ─────────────────────────────────────
const FIXTURE = `
  <div id="card" style="cursor:pointer;width:220px;height:56px;background:#eef" onclick="window.__hit=1">卡片文字</div>
  <div id="tabregion" tabindex="0" style="width:180px;height:40px;background:#efe">Tab 区块</div>
  <div id="outer" style="cursor:pointer;width:320px;height:120px;background:#ddd">
    <div id="inner" style="cursor:pointer;width:200px;height:48px;background:#ccc">内层区域</div>
  </div>
  <div id="wrap" style="cursor:pointer;width:260px;height:70px;background:#fdd">
    <button id="realbtn" style="width:70px;height:22px">真按钮</button>
  </div>
  <div id="tightwrap" style="cursor:pointer;width:200px;height:44px;background:#dff">
    <button id="fillbtn" style="width:200px;height:44px;display:block">占满按钮</button>
  </div>
  <a id="inlink" href="#anchor" style="display:block;width:220px;height:40px">
    <div id="linkdiv" style="cursor:pointer;width:220px;height:40px;background:#ffd">链接里的容器</div>
  </a>
  <label id="lab" for="cb" style="cursor:pointer;display:inline-block;width:140px;height:28px">勾选我</label>
  <input type="checkbox" id="cb">
`;

const space = await taskSpace(`ego-region-${Date.now()}`);
const page = space.page("p1");
try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => { document.body.innerHTML = html; }, FIXTURE);

  // ── [1] 元素表补全 ──
  console.log("\n[1] 容器型可点元素进元素表（role=clickable-region）");
  let cardRef = null;
  {
    stubJev();
    prefer = { operation: "wait" };
    const r = await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const state = JSON.parse(lastBody).state;
    const lines = tableLines(state);
    console.log("  元素表:\n" + lines.map((l) => "    " + l).join("\n"));
    check("走了 dom 观测路径", r.observeMode === "dom", String(r.observeMode));
    check("cursor:pointer+onclick 的卡片进表", Boolean(findRef(state, "clickable-region", "卡片文字")), lines.join(" / "));
    check("tabindex 区块进表", Boolean(findRef(state, "clickable-region", "Tab 区块")), lines.join(" / "));
    check("嵌套容器只收最内层（“内层区域”只出现一次）", lines.filter((l) => l.includes("clickable-region") && l.includes("内层区域")).length === 1, lines.join(" / "));
    check("小按钮的外层容器仍收（它补出了额外可点面积）", Boolean(findRef(state, "clickable-region", "真按钮")), lines.join(" / "));
    check("被占满按钮盖住的容器不收（同一块不双收）", Boolean(findRef(state, "button", "占满按钮")) && !lines.some((l) => l.includes("clickable-region") && l.includes("占满按钮")), "");
    check("<a href> 里的容器不收（a11y 链接已是精确目标）", Boolean(findRef(state, "link", "链接里的容器")) && !lines.some((l) => l.includes("clickable-region") && l.includes("链接里的容器")), "");
    check("真按钮仍在表里（role=button）", Boolean(findRef(state, "button", "真按钮")), "");
    check("<label for> 不与控件双收（checkbox 在、label 不在）", Boolean(findRef(state, "checkbox", "勾选我")) && !lines.some((l) => l.includes("clickable-region") && l.includes("勾选我")), "");
    cardRef = findRef(state, "clickable-region", "卡片文字");
  }

  // ── [2] 真的能点：真实鼠标事件 → window.__hit ──
  console.log("\n[2] 点击容器型可点元素真的触发（真实 DOM 断言）");
  {
    stubJev();
    prefer = { operation: "click", click_target: `ref=${cardRef}` };
    const r = await runJevStep(page, "点卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
    const hit = await page.evaluate(() => window.__hit || 0);
    check("未发生守卫拒绝", !r.guardRejected && !r.targetMissing, JSON.stringify({ guardRejected: r.guardRejected, targetMissing: r.targetMissing }));
    check("action=click 且目标解析成功", r.action === "click" && Boolean(r.target), JSON.stringify({ action: r.action, target: r.target }));
    check("页面上的 window.__hit === 1（点击真的派发了）", hit === 1, `hit=${hit}`);
  }

  // ── [3] a11y 预算优先级：大量容器不挤掉原生控件 ──
  console.log("\n[3] a11y 元素优先占预算");
  {
    // 80 个 cursor:pointer 容器**先插**、按钮**最后插**：
    // 只有真正的「a11y 优先占预算」才能让按钮（DOM 序第 81 位）进元素表；纯 DOM 序会把它挤出前 60。
    await page.evaluate(() => {
      document.body.innerHTML = "";
      for (let i = 0; i < 80; i++) {
        const d = document.createElement("div");
        d.style.cssText = "cursor:pointer;width:60px;height:6px;background:#eee";
        d.textContent = `容器${i}`;
        document.body.appendChild(d);
      }
      const b = document.createElement("button");
      b.id = "prioritybtn";
      b.textContent = "优先按钮";
      document.body.appendChild(b);
    });
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const state = JSON.parse(lastBody).state;
    const lines = tableLines(state);
    check("原生按钮没有被容器挤出元素表", Boolean(findRef(state, "button", "优先按钮")), `表内 ${lines.length} 行`);
    check("容器型元素确实也进了表（补全生效）", lines.filter((l) => l.includes("clickable-region")).length > 0, `表内 ${lines.length} 行`);
  }
  // ── [4] 反例：主文档先塞 2000 个空 div，再放 shadow / frame fixture ──
  console.log("\n[4] 2000 个空 div 之后，shadow/frame 里的 region 仍被发现（公平扫描）");
  {
    await page.evaluate(() => {
      document.body.innerHTML = "";
      // 2000 个不可点 div：旧实现会让它们吃光 region 扫描额度 / 挡住 shadow host 的发现
      const filler = document.createElement("div");
      for (let i = 0; i < 2000; i++) {
        const d = document.createElement("div");
        d.style.cssText = "height:0;width:0";
        filler.appendChild(d);
      }
      document.body.appendChild(filler);
      // shadow fixture（绝对定位，保证在视口内）
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:220px;height:60px";
      document.body.appendChild(host);
      const sr = host.attachShadow({ mode: "open" });
      sr.innerHTML = '<div id="scard" style="cursor:pointer;width:200px;height:44px;background:#ffe" onclick="window.__shit=1">shadow 反例卡片</div>';
      // frame fixture
      const f = document.createElement("iframe");
      f.style.cssText = "position:absolute;left:260px;top:0;width:300px;height:120px";
      f.srcdoc = '<html><body style="margin:0"><div id="fcard" style="cursor:pointer;width:220px;height:44px;background:#eef" onclick="window.__hit=1">frame 反例卡片</div></body></html>';
      document.body.appendChild(f);
    });
    await page.waitForTimeout(500);
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const state = JSON.parse(lastBody).state;
    const lines = tableLines(state);
    check("2000 空 div 之后：shadow 里的 region 仍进表", Boolean(findRef(state, "clickable-region", "shadow 反例卡片")), `表内 ${lines.length} 行`);
    check("2000 空 div 之后：frame 里的 region 仍进表", Boolean(findRef(state, "clickable-region", "frame 反例卡片")), `表内 ${lines.length} 行`);
  }
} catch (e) {
  check("容器型可点元素用例执行完成", false, String(e).slice(0, 400));
} finally {
  globalThis.fetch = realFetch;
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-clickable-regions-${stamp}.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-clickable-regions-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
