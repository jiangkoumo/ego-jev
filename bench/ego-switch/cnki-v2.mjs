// 实测（v2）：ego 上跑 CNKI 基础检索，落盘全部结果行 + 摸清各列的真实选择器
const { writeFile } = await import("node:fs/promises");
const OUT = "/tmp/ego-switch/cnki-search-v2.json";
const QUERY = "大语言模型";
const space = await taskSpace(`ego-cnki-${Date.now()}`);
const page = space.page("p1");
const out = { startedAt: new Date().toISOString(), query: QUERY, steps: [] };
const log = (k, v) => { out.steps.push({ k, v }); console.log(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
try {
  await page.goto("https://kns.cnki.net/kns8s/search", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("input.search-input", { timeout: 30000 });
  log("captchaBefore", await page.evaluate(() => {
    const o = document.querySelector("#tcaptcha_transform_dy");
    return o ? { top: Math.round(o.getBoundingClientRect().top), visible: o.getBoundingClientRect().top >= 0 } : null;
  }));
  await page.fill("input.search-input", QUERY);
  log("filledValue", await page.evaluate(() => document.querySelector("input.search-input")?.value));
  await page.evaluate(() => document.querySelector("input.search-btn")?.click());
  const t0 = Date.now();
  await page.waitForFunction(() => (document.body.innerText || "").includes("条结果"), undefined, { timeout: 30000 });
  log("resultsArrivedMs", Date.now() - t0);
  log("captchaAfter", await page.evaluate(() => {
    const o = document.querySelector("#tcaptcha_transform_dy");
    return o ? { top: Math.round(o.getBoundingClientRect().top), visible: o.getBoundingClientRect().top >= 0 } : null;
  }));

  // 表头 + 第一行各单元格的类名（确认列映射）
  log("headers", await page.evaluate(() => [...document.querySelectorAll(".result-table-list thead tr th")].map((th) => ({ cls: String(th.className).slice(0, 40), text: (th.innerText || "").trim() }))));
  log("firstRowCells", await page.evaluate(() => {
    const tr = document.querySelector(".result-table-list tbody tr");
    if (!tr) return null;
    return [...tr.querySelectorAll("td")].map((td) => ({ cls: String(td.className).slice(0, 40), text: (td.innerText || "").trim().slice(0, 40) }));
  }));

  const parsed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".result-table-list tbody tr")];
    const boxes = [...document.querySelectorAll(".result-table-list tbody input.cbItem")];
    const cell = (row, cls) => (row.querySelector(`td.${cls}`)?.innerText || "").trim();
    return {
      count: (document.body.innerText.match(/([\d,]+)\s*条结果/) || [])[1] || null,
      rowCount: rows.length,
      list: rows.map((row, i) => {
        const titleLink = row.querySelector("td.name a.fz14");
        return {
          n: i + 1,
          title: (titleLink?.innerText || "").trim(),
          href: titleLink?.href || "",
          exportId: boxes[i]?.value || "",
          authors: [...row.querySelectorAll("td.author a.KnowledgeNetLink")].map((a) => (a.innerText || "").trim()).join("; "),
          journal: (row.querySelector("td.source a")?.innerText || "").trim(),
          date: cell(row, "date"),
          citations: cell(row, "quote"),
          downloads: cell(row, "download"),
          allCells: [...row.querySelectorAll("td")].map((td) => ({ cls: String(td.className), text: (td.innerText || "").trim().slice(0, 24) })),
        };
      }),
    };
  });
  out.result = parsed;
  log("resultCount", parsed.count);
  log("rowCount", parsed.rowCount);
  log("rowsWithCitations", parsed.list.filter((r) => r.citations).length);
  log("rowsWithTitle", parsed.list.filter((r) => r.title).length);
  console.log("  前 3 条:");
  for (const r of parsed.list.slice(0, 3)) console.log(`    ${r.n}. ${r.title} | ${r.authors} | ${r.journal} | ${r.date} | 被引"${r.citations}" 下载"${r.downloads}"`);
  console.log("  第 1 行原始单元格:", JSON.stringify(parsed.list[0]?.allCells));
} catch (e) { out.err = String(e).slice(0, 400); console.log("ERROR " + out.err); }
out.endedAt = new Date().toISOString();
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log("RAW: " + OUT);
try { await space.finish({ keep: [] }); } catch {}
