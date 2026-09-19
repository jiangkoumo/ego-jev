// 单步耗时分解：观测层成本 + Jev 延迟随载荷大小的变化
// 用法: ego-browser nodejs < bench/probe-latency.js
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const JE = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/scripts/ego-jev.mjs";
const { askJev, parseActionTargets, enrichTargets, buildActionMenu, buildQuestions } = await import(JE);
const BENCH = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench";
const KEY = (await readFile(process.env.HOME + "/.agents/lib/backups/typesafe-api-key.bak", "utf8")).trim();
const GOAL = "先打开 new 页面，再打开 comments 页面";
const RUNS = 3;

// —— 原型：一次 evaluate 自建元素表（jev-ultrafast snapshot.js 的最小移植）——
const OBSERVE = () => {
  const nodes = (window.__egoJevNodes ||= new Map());
  const nextRef = { v: window.__egoJevNext || 1 };
  const roleOf = (e) => {
    const explicit = (e.getAttribute("role") || "").toLowerCase();
    if (explicit) return explicit;
    const t = e.tagName;
    if (t === "A") return "link";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (t === "SUMMARY" || t === "BUTTON") return "button";
    if (t === "INPUT") {
      const ty = (e.type || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "search") return "searchbox";
      if (ty === "number") return "spinbutton";
      if (["text", "email", "url", "tel", "password"].includes(ty)) return "textbox";
    }
    return null;
  };
  const nameOf = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return "";
    seen.add(e);
    const ref = (e.getAttribute("aria-labelledby") || "")
      .split(/\s+/).map((id) => nameOf(document.getElementById(id), seen)).filter(Boolean).join(" ");
    return (
      ref || e.getAttribute("aria-label") ||
      [...(e.labels || [])].map((l) => nameOf(l, seen)).filter(Boolean).join(" ") ||
      (["button", "submit", "reset"].includes(e.type) ? e.value : "") ||
      e.getAttribute("alt") || e.getAttribute("title") || e.getAttribute("placeholder") ||
      (e.tagName === "INPUT" ? "" :
        [...e.childNodes].map((n) => n.nodeType === 3 ? n.textContent :
          n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true" ? nameOf(n, seen) : "").join(" ").trim())
    );
  };
  const out = [];
  for (const e of document.querySelectorAll(
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],[role]')) {
    if (["password", "file", "hidden"].includes(e.type)) continue;
    if (e.closest('[aria-hidden="true"],[inert]')) continue;
    if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    if (e.matches(":disabled") || e.closest('[aria-disabled="true"]')) continue;
    const role = roleOf(e);
    if (!role) continue;
    const r = e.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    let id = null;
    for (const [k, v] of nodes) { if (v === e) { id = k; break; } }
    if (id === null) { id = nextRef.v++; nodes.set(id, e); }
    const item = { ref: `ref=${id}`, role, name: nameOf(e).replace(/\s+/g, " ").trim().slice(0, 60) };
    if ("value" in e && e.type !== "checkbox" && e.type !== "radio") item.value = String(e.value).slice(0, 60);
    if (typeof e.checked === "boolean") item.checked = e.checked;
    if (e.tagName === "SELECT") item.options = [...e.options].map((o) => o.textContent.trim().slice(0, 40)).slice(0, 30);
    out.push(item);
    if (out.length >= 60) break;
  }
  window.__egoJevNext = nextRef.v;
  return out;
};

const out = {};
for (const url of ["https://news.ycombinator.com", "https://en.wikipedia.org/wiki/Main_Page"]) {
  const task = await taskSpace("ego-probe-" + Date.now());
  const page = task.page("p1");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(1000);
  const rec = { url, samples: [] };

  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    const snap = await page.snapshot();
    const tSnap = Date.now() - t0;

    const t1 = Date.now();
    const parsed = parseActionTargets(snap, { limit: 40 });
    const menu = buildActionMenu(parsed);
    const tParse = Date.now() - t1;

    const t2 = Date.now();
    const enriched = await enrichTargets(page, parsed, {});
    const tEnrich = Date.now() - t2;
    const menuEnriched = buildActionMenu(enriched);

    const t3 = Date.now();
    const dom = await page.evaluate(OBSERVE);
    const tDom = Date.now() - t3;
    const menuDom = buildActionMenu(
      dom.map((d) => ({
        ref: d.ref, role: d.role, kind: d.options ? "selectable" : d.checked !== undefined ? "checkable" : /text|search|spin/.test(d.role) ? "editable" : "clickable",
        name: d.name, value: d.value || "", checked: d.checked, options: d.options, url: "",
      }))
    );

    // 同一批问题，只换 state 载荷
    const mkState = (table) => [`用户最终目标: ${GOAL}`, `当前页面: ${url}`, "当前视口内可交互元素 (ref | role | 名称 | 当前值 | 链接路径):", table].join("\n");
    const questions = buildQuestions(parsed, { hasTextSource: false });

    const t4 = Date.now();
    let bigOk = true;
    try { await askJev(mkState(menuEnriched), questions, { apiKey: KEY }); } catch (e) { bigOk = String(e).slice(0, 80); }
    const tJevBig = Date.now() - t4;

    const t5 = Date.now();
    let smallOk = true;
    try { await askJev(mkState(menuDom), questions, { apiKey: KEY }); } catch (e) { smallOk = String(e).slice(0, 80); }
    const tJevSmall = Date.now() - t5;

    rec.samples.push({
      snapMs: tSnap, snapshotChars: snap.length, parseMs: tParse, enrichMs: tEnrich,
      domMs: tDom, domCount: dom.length,
      menuChars: menuEnriched.length, menuDomChars: menuDom.length,
      jevBigMs: tJevBig, jevSmallMs: tJevSmall, bigOk, smallOk,
    });
    console.log(`  ${url} #${i + 1} | snapshot ${tSnap}ms/${snap.length}ch | evaluate ${tDom}ms/${dom.length}项/${menuDom.length}ch | enrich ${tEnrich}ms | Jev(大) ${tJevBig}ms | Jev(小) ${tJevSmall}ms`);
  }
  out[url] = rec;
  await task.finish({ keep: [] });
}
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/probe-latency-${stamp}.json`, JSON.stringify(out, null, 2));
console.log("RAW: " + `${BENCH}/raw/probe-latency-${stamp}.json`);
