// 量 ego 的观测成本：a11y 快照 vs 一次 DOM 自建元素表
const task = await taskSpace("ego-obs-cost-probe");
const page = task.page("p1");

const BUILD = (limit) => {
  const out = [];
  const roleOf = (el) => {
    const r = (el.getAttribute("role") || "").toLowerCase();
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (["submit", "button", "reset"].includes(ty)) return "button";
      return "textbox";
    }
    return t;
  };
  const nameOf = (el) =>
    (el.getAttribute("aria-label") ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
      el.closest("label")?.textContent ||
      el.getAttribute("placeholder") ||
      (el.tagName === "INPUT" ? el.value : "") ||
      el.textContent ||
      "").replace(/\s+/g, " ").trim().slice(0, 60);
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role],[onclick]')) {
    if (out.length >= limit) break;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const e = { role: roleOf(el), name: nameOf(el), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    if (typeof el.checked === "boolean" && ["checkbox", "radio"].includes(e.role)) e.checked = el.checked;
    if (el.tagName === "SELECT") e.options = [...el.options].slice(0, 30).map((o) => o.textContent.trim());
    if (el.value) e.value = String(el.value).slice(0, 40);
    out.push(e);
  }
  return out;
};

for (const url of ["https://news.ycombinator.com", "https://en.wikipedia.org/wiki/Main_Page"]) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(1200);

  const t0 = Date.now();
  const snap = await page.snapshot();
  const snapMs = Date.now() - t0;

  const t1 = Date.now();
  const table = await page.evaluate(BUILD, 60);
  const tableMs = Date.now() - t1;

  console.log(`\n=== ${url}`);
  console.log(`  ego 快照      : ${snapMs}ms, ${snap.length} 字符（≈${Math.round(snap.length / 4)} tokens）`);
  console.log(`  自建元素表    : ${tableMs}ms, ${table.length} 项, ${JSON.stringify(table).length} 字符（≈${Math.round(JSON.stringify(table).length / 4)} tokens）`);
  console.log(`  提速倍数      : ${(snapMs / Math.max(tableMs, 1)).toFixed(1)}x`);
}
await task.finish({ keep: [] });
