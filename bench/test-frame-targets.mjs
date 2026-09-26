// P0-2 验收：跨 frame（同源 iframe）的可点元素也要能观测、能 fill/click。
//
// 为什么需要：observeDom 以前只查主文档，iframe 里的元素根本不进元素表。即使收进来，
// locateForInput 会用主文档的 document.elementFromPoint 做身份比对——那里只能命中 <iframe>，
// 拿不到 frame 内节点，于是每个 frame 目标都被误判成 covered。
// 本文件在 about:blank 上自造同源 iframe（不联网、不需要凭证），走真实的观测 + locate + 裸 CDP 派发：
//   [1] frame 内的输入框/按钮/容器区域进元素表，且带 frameOrigin 标
//   [2] 真实派发后 frame 内 input.value 变成填进去的文本（断言 frame 内真实 DOM）
//   [3] 真实派发后 frame 内 window.__hit === 1（容器区域点击生效）
//   [4] 对照：主文档里被遮挡的目标仍判 covered（身份比对没有被全局关掉）
//
// 用法（测当前工作树）: sed "s|__REPO__|$PWD|g" bench/test-frame-targets.mjs | ego-browser nodejs
// 直接 `< bench/test-frame-targets.mjs`：走已安装技能（~/.agents/skills/ego-jev，本机是指向仓库的软链）
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
const tableLines = (state) => (state.split("当前视口内可交互元素")[1] || "").split("\n").filter((l) => l.includes("ref="));
const findRef = (state, role, namePart) => {
  const line = tableLines(state).find((l) => l.includes(`| ${role} |`) && l.includes(namePart));
  return line ? (line.match(/ref=(\d+)/) || [])[1] : null;
};

// 主文档：一个被 overlay 遮挡的容器（用于 covered 对照）；下面挂一个同源 iframe
const MAIN_HTML = `
  <div id="covered" style="cursor:pointer;position:absolute;left:20px;top:20px;width:160px;height:40px;background:#fee" onclick="window.__covered=1">被遮挡的容器</div>
  <div id="overlay" style="position:absolute;left:0;top:0;width:420px;height:140px;background:rgba(0,0,0,0.02);z-index:9"></div>
`;
const FRAME_HTML = `<html><body style="margin:0;font:14px sans-serif">
  <input id="fin" aria-label="frame 输入框" style="width:220px;height:30px">
  <button id="fbtn" style="width:120px;height:32px">frame 按钮</button>
  <div id="fcard" style="cursor:pointer;width:220px;height:52px;background:#eef" onclick="window.__hit=1">frame 卡片</div>
</body></html>`;

const space = await taskSpace(`ego-frame-${Date.now()}`);
const page = space.page("p1");
try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((payload) => {
    document.body.style.margin = "0";
    document.body.innerHTML = payload.mainHtml;
    const f = document.createElement("iframe");
    f.id = "fr";
    f.style.cssText = "position:absolute;left:0;top:160px;width:420px;height:200px;border:1px solid #888";
    f.srcdoc = payload.frameHtml;
    document.body.appendChild(f);
    // 开放的 shadow root：document.querySelectorAll 不穿透，必须自己遍历
    const host = document.createElement("div");
    host.id = "shadowhost";
    host.style.cssText = "position:absolute;left:0;top:380px;width:320px;height:120px";
    document.body.appendChild(host);
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML =
      '<input id="sin" aria-label="shadow 输入框" style="width:200px;height:28px">' +
      '<div id="scard" style="cursor:pointer;width:200px;height:44px;background:#ffe" onclick="window.__shit=1">shadow 卡片</div>';
  }, { mainHtml: MAIN_HTML, frameHtml: FRAME_HTML });
  await page.waitForTimeout(500);
  const frameReady = await page.evaluate(() => {
    const d = document.getElementById("fr")?.contentDocument;
    return Boolean(d && d.getElementById("fin"));
  });
  check("同源 iframe 内容已就绪", frameReady === true, String(frameReady));

  // ── [1] frame 内元素进元素表 ──
  console.log("\n[1] 同源 iframe 内的元素进元素表");
  let inputRef = null;
  let cardRef = null;
  {
    stubJev();
    prefer = { operation: "wait" };
    const r = await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const state = JSON.parse(lastBody).state;
    const lines = tableLines(state);
    console.log("  元素表:\n" + lines.map((l) => "    " + l).join("\n"));
    check("走了 dom 观测路径", r.observeMode === "dom", String(r.observeMode));
    check("frame 内输入框进表", Boolean(findRef(state, "textbox", "frame 输入框")), lines.join(" / "));
    check("frame 内按钮进表", Boolean(findRef(state, "button", "frame 按钮")), lines.join(" / "));
    check("frame 内容器区域进表（clickable-region）", Boolean(findRef(state, "clickable-region", "frame 卡片")), lines.join(" / "));
    // frameOrigin 标：直接看引擎产出的 target 对象
    const obs = await page.evaluate(() => {
      const out = [];
      for (const [id, el] of window.__egoJev.nodes) {
        if (el.ownerDocument !== document) out.push({ id, tag: el.tagName });
      }
      return out;
    });
    check("frame 内节点被登记进引擎节点表（供 locate 取回）", obs.length >= 3, JSON.stringify(obs));
    inputRef = findRef(state, "textbox", "frame 输入框");
    cardRef = findRef(state, "clickable-region", "frame 卡片");
  }

  // ── [2] fill：真实派发后 frame 内 input.value 变化 ──
  console.log("\n[2] fill frame 内输入框（真实 DOM 断言）");
  {
    stubJev();
    prefer = { operation: "type_text", type_text_target: `ref=${inputRef}`, input_text: "t0" };
    const r = await runJevStep(page, "填入文本", { apiKey: "stub", metrics: {}, maxText: 0, text: ["hello-frame"] });
    const value = await page.evaluate(() => document.getElementById("fr").contentDocument.getElementById("fin").value);
    check("action=type_text 且目标解析成功", r.action === "type_text" && Boolean(r.target), JSON.stringify({ action: r.action, target: r.target }));
    // 不变量：要么被拒绝，要么动作真的在真实 DOM 上生效——不允许「派发了但落在别处」的静默错点
    check("fill frame：要么被拒绝，要么真的生效", r.guardRejected ? r.guardRejected === "covered" && value === "" : value === "hello-frame", JSON.stringify({ guardRejected: r.guardRejected, value }));
  }

  // ── [3] click：真实派发后 frame 内 window.__hit 变化 ──
  console.log("\n[3] click frame 内容器区域（真实 DOM 断言）");
  {
    stubJev();
    prefer = { operation: "click", click_target: `ref=${cardRef}` };
    const r = await runJevStep(page, "点卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
    const hit = await page.evaluate(() => document.getElementById("fr").contentWindow.__hit || 0);
    check("action=click 且目标解析成功", r.action === "click" && Boolean(r.target), JSON.stringify({ action: r.action, target: r.target }));
    check("click frame：要么被拒绝，要么真的生效", r.guardRejected ? r.guardRejected === "covered" && hit === 0 : hit === 1, JSON.stringify({ guardRejected: r.guardRejected, hit }));
  }

  // ── [4] 对照：主文档里被遮挡的目标仍判 covered ──
  console.log("\n[4] 对照：主文档里被遮挡的目标仍判 covered（身份比对没被全局关掉）");
  {
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const state = JSON.parse(lastBody).state;
    const coveredRef = findRef(state, "clickable-region", "被遮挡的容器");
    check("被遮挡的容器进了元素表", Boolean(coveredRef), tableLines(state).join(" / "));
    if (coveredRef) {
      stubJev();
      prefer = { operation: "click", click_target: `ref=${coveredRef}` };
      const r = await runJevStep(page, "点被遮挡的容器", { apiKey: "stub", metrics: {}, maxText: 0 });
      const hit = await page.evaluate(() => window.__covered || 0);
      check("主文档被遮挡目标 → guardRejected=covered", r.guardRejected === "covered", JSON.stringify(r.guardRejected));
      check("遮挡目标没有被执行（window.__covered 未置位）", hit === 0, `hit=${hit}`);
    }
  }
  // ── [5] shadow DOM：开放 shadow root 里的输入框/容器区域 ──
  console.log("\n[5] shadow DOM 里的元素（观测 + fill + click）");
  {
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const state = JSON.parse(lastBody).state;
    const lines = tableLines(state);
    const sinRef = findRef(state, "textbox", "shadow 输入框");
    const scardRef = findRef(state, "clickable-region", "shadow 卡片");
    check("shadow 内输入框进表", Boolean(sinRef), lines.join(" / "));
    check("shadow 内容器区域进表", Boolean(scardRef), lines.join(" / "));
    if (sinRef) {
      stubJev();
      prefer = { operation: "type_text", type_text_target: `ref=${sinRef}`, input_text: "t0" };
      const r = await runJevStep(page, "填入文本", { apiKey: "stub", metrics: {}, maxText: 0, text: ["hello-shadow"] });
      const value = await page.evaluate(() => document.getElementById("shadowhost").shadowRoot.getElementById("sin").value);
      check("shadow fill：要么被拒绝，要么真的生效", r.guardRejected ? r.guardRejected === "covered" && value === "" : value === "hello-shadow", JSON.stringify({ guardRejected: r.guardRejected, value }));
    }
    if (scardRef) {
      stubJev();
      prefer = { operation: "click", click_target: `ref=${scardRef}` };
      const r = await runJevStep(page, "点 shadow 卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
      const hit = await page.evaluate(() => window.__shit || 0);
      check("shadow click：要么被拒绝，要么真的生效", r.guardRejected ? r.guardRejected === "covered" && hit === 0 : hit === 1, JSON.stringify({ guardRejected: r.guardRejected, hit }));
    }
  }
  // ── [6] overlay 盖住 iframe：跳 frame 目标必须判 covered，且 0 次 CDP 派发 ──
  console.log("\n[6] overlay 盖住 iframe（border 1px）→ covered，不派发");
  {
    await page.evaluate((payload) => {
      document.body.innerHTML = payload.main;
      const f = document.createElement("iframe");
      f.id = "frcov";
      f.style.cssText = "position:absolute;left:0;top:160px;width:420px;height:200px;border:1px solid #888";
      f.srcdoc = payload.frame;
      document.body.appendChild(f);
    }, { main: MAIN_HTML.replace("height:140px", "height:400px"), frame: FRAME_HTML });
    await page.waitForTimeout(400);
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const cardRef = findRef(JSON.parse(lastBody).state, "clickable-region", "frame 卡片");
    check("被 overlay 盖住的 frame 目标仍进元素表", Boolean(cardRef), tableLines(JSON.parse(lastBody).state).join(" / "));
    if (cardRef) {
      stubJev();
      prefer = { operation: "click", click_target: `ref=${cardRef}` };
      const r = await runJevStep(page, "点 frame 卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
      const hit = await page.evaluate(() => document.getElementById("frcov").contentWindow.__hit || 0);
      check("被遮挡 frame 目标 → guardRejected=covered", r.guardRejected === "covered", JSON.stringify(r.guardRejected));
      check("被遮挡 frame 目标没有被派发（window.__hit 仍为 0）", hit === 0, `hit=${hit}`);
    }
  }

  // ── [7] overlay 盖住 + 宽边框：仍要拒绝（不因坐标偏移而错点） ──
  console.log("\n[7] overlay 盖住 iframe（border 24px）→ covered，不派发");
  {
    await page.evaluate((payload) => {
      document.body.innerHTML = payload.main;
      const f = document.createElement("iframe");
      f.id = "frcovb";
      f.style.cssText = "position:absolute;left:0;top:160px;width:468px;height:248px;border:24px solid #333";
      f.srcdoc = payload.frame;
      document.body.appendChild(f);
    }, { main: MAIN_HTML.replace("height:140px", "height:440px"), frame: FRAME_HTML });
    await page.waitForTimeout(400);
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const cardRef = findRef(JSON.parse(lastBody).state, "clickable-region", "frame 卡片");
    if (cardRef) {
      stubJev();
      prefer = { operation: "click", click_target: `ref=${cardRef}` };
      const r = await runJevStep(page, "点 frame 卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
      const hit = await page.evaluate(() => document.getElementById("frcovb").contentWindow.__hit || 0);
      check("宽边框+遮挡 → guardRejected=covered", r.guardRejected === "covered", JSON.stringify(r.guardRejected));
      check("宽边框+遮挡 → 没有错点（window.__hit 仍为 0）", hit === 0, `hit=${hit}`);
    } else {
      check("宽边框+遮挡的 frame 目标进表", false, tableLines(JSON.parse(lastBody).state).join(" / "));
    }
  }

  // ── [8] 宽边框但未被遮挡：clientLeft 计入，click 仍生效（否则会错点） ──
  console.log("\n[8] 宽边框 iframe（border 24px，未被遮挡）→ clientLeft 计入，click 生效");
  {
    await page.evaluate((payload) => {
      document.body.innerHTML = "";
      const f = document.createElement("iframe");
      f.id = "frborder";
      f.style.cssText = "position:absolute;left:0;top:0;width:468px;height:248px;border:24px solid #333";
      f.srcdoc = payload.frame;
      document.body.appendChild(f);
    }, { frame: FRAME_HTML });
    await page.waitForTimeout(400);
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const cardRef = findRef(JSON.parse(lastBody).state, "clickable-region", "frame 卡片");
    check("宽边框 frame 目标进表", Boolean(cardRef), tableLines(JSON.parse(lastBody).state).join(" / "));
    if (cardRef) {
      stubJev();
      prefer = { operation: "click", click_target: `ref=${cardRef}` };
      const r = await runJevStep(page, "点 frame 卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
      const hit = await page.evaluate(() => document.getElementById("frborder").contentWindow.__hit || 0);
      check("宽边框未被遮挡 → 未被守卫拒绝", !r.guardRejected, JSON.stringify(r.guardRejected));
      check("宽边框：clientLeft 计入，window.__hit === 1", hit === 1, `hit=${hit}`);
    }
  }

  // ── [9] 外层 frame 有非 identity transform：直接拒绝，不猜坐标 ──
  console.log("\n[9] transform 的 iframe → frame_transformed，不派发");
  {
    await page.evaluate((payload) => {
      document.body.innerHTML = "";
      const f = document.createElement("iframe");
      f.id = "frtf";
      f.style.cssText = "position:absolute;left:0;top:0;width:420px;height:200px;transform:scale(1.5);transform-origin:top left";
      f.srcdoc = payload.frame;
      document.body.appendChild(f);
    }, { frame: FRAME_HTML });
    await page.waitForTimeout(400);
    stubJev();
    prefer = { operation: "wait" };
    await runJevStep(page, "看一眼", { apiKey: "stub", metrics: {}, maxText: 0 });
    const cardRef = findRef(JSON.parse(lastBody).state, "clickable-region", "frame 卡片");
    if (cardRef) {
      stubJev();
      prefer = { operation: "click", click_target: `ref=${cardRef}` };
      const r = await runJevStep(page, "点 frame 卡片", { apiKey: "stub", metrics: {}, maxText: 0 });
      const hit = await page.evaluate(() => document.getElementById("frtf").contentWindow.__hit || 0);
      check("transform frame → guardRejected=frame_transformed", r.guardRejected === "frame_transformed", JSON.stringify(r.guardRejected));
      check("transform frame → 没有派发（window.__hit 仍为 0）", hit === 0, `hit=${hit}`);
    } else {
      check("transform frame 目标进表", false, tableLines(JSON.parse(lastBody).state).join(" / "));
    }
  }
} catch (e) {
  check("跨 frame 用例执行完成", false, String(e).slice(0, 400));
} finally {
  globalThis.fetch = realFetch;
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-frame-targets-${stamp}.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-frame-targets-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
