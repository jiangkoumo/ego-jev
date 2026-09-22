const space = await taskSpace(`x-trending-${Date.now()}`);
const page = space.page("p1");
const ev = (fn, ...rest) => (rest.length ? page.evaluate(fn, rest[0]) : page.evaluate(fn));
try {
  // 1) 打开基础页。ego 的 goto 用 domcontentloaded 实测直接成功（bh 的 goto_url 必然超时）；
  //    仍建议 try/catch 兜底：吞掉超时后导航其实已生效。
  try { await page.goto("https://www.tl1.com/trending", { waitUntil: "domcontentloaded", timeout: 20000 }); } catch {}

  // 2) 等异步列表出数据（实测约 6 秒才渲染出 50 条）
  const links = () => ev(() => document.querySelectorAll('a[href*="/status/"]').length);
  let n = 0;
  for (let i = 0; i < 10 && !n; i++) { await page.waitForTimeout(2000); n = await links(); }

  // 3) 点筛选：时间 1h~8h｜粉丝 ≤5K/≤10K/≤20K/≤50K/≤100K｜互动 ≥2次~≥10次｜另有「5M蹭楼」
  const clickButton = (label) => ev((lb) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === lb);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  await clickButton("3h");        // 1~4 小时处于 For You 爬坡期
  await page.waitForTimeout(1000);
  await clickButton("≤20K");      // 博主粉丝上限
  await page.waitForTimeout(500);
  console.log("URL（筛选会编码进路径）:", await page.url());

  // 4) 关键：筛选是异步重取（ego 实测 3h 约 1s 换完；≤20K 约 6s 时还有一次短暂清空再回填）
  //    → 必须轮询，不能固定短等待，也不能假定“一次就稳定”。
  //    ⚠️ 不能拿“时间窗变了”当成功条件：列表会先被清空，那也算“变了”，会在空列表上提前退出。
  //    判定必须是「有数据 + 时间标签都不超出窗口」，并且**记录筛选前的分布**：
  //    旧列表本来就可能是 1~4h，只看一轮就当真会把“还没重取”误判成“筛选已生效”。
  //    ⚠️ 「条数稳定」必须用 status 链接数来判，不能用时间标签数（标签数会被截断成同一个值，永远“稳定”）。
  const snap = () => ev(() => ({
    links: document.querySelectorAll('a[href*="/status/"]').length,
    labels: (document.body.innerText.match(/\[[^\]]*?前\]/g) || []),
  }));
  const hourAge = (label) => { const m = label.match(/(\d+)\s*小时前/); return m ? Number(m[1]) : null; };
  const beforeAges = (await snap()).labels;   // 基础页（未筛选）的年龄分布，用于对照
  const noOutOfWindow = (labels) => labels.length >= 8 && labels.every((t) => { const h = hourAge(t); return h === null || h <= 4; });
  // 连续 3 个采样（每 2s）条数一致且都在窗口内，才算「重取完成」。实测 ≤20K 在 ~6s 时还会清空重填一次，
  // 所以单次采样或只等两拍都不够；3 拍自适应地等过那次清空。
  const waitStable = async (budget = 20) => {
    let stable = 0, prev = -1, sawEmpty = false, waited = 0;
    for (let i = 0; i < budget; i++) {
      await page.waitForTimeout(2000);
      waited += 2000;
      const s = await snap();
      if (!s.labels.length) { sawEmpty = true; stable = 0; prev = -1; continue; }   // 筛选会先清空列表
      const good = noOutOfWindow(s.labels) && s.links >= 8;
      stable = good && s.links === prev ? stable + 1 : good ? 1 : 0;
      prev = s.links;
      if (stable >= 3) return { ok: true, snap: s, sawEmpty, waited };
    }
    return { ok: false, snap: { links: prev, labels: [] }, sawEmpty, waited };
  };
  let r = await waitStable();
  if (!r.ok) {
    // 兜底：回基础页重来（直接打开带筛选的 URL 实测拿不到数据）
    try { await page.goto("https://www.tl1.com/trending", { waitUntil: "domcontentloaded", timeout: 20000 }); } catch {}
    for (let i = 0; i < 10 && !(await links()); i++) await page.waitForTimeout(2000);
    await clickButton("3h");
    await page.waitForTimeout(1500);
    await clickButton("≤20K");
    r = await waitStable();
  }
  console.log("筛选前年龄:", JSON.stringify(beforeAges.slice(0, 6)), "| 筛选后条数:", r.snap.links, "| 曾见空列表:", r.sawEmpty, "| 等待:", r.waited + "ms", "| 窗口符合:", r.ok);

  // 5) 提取候选（用 innerText，并回退到 textContent——异步渲染时 innerText 可能还未填充），
  //    并**按帖子自身的时间标签再过滤一遍**（UI 筛选不可信，见下面第 6 条坑）。
  const posts = await ev(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/status/"]')) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const t = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      if (t) out.push({ url: a.href, rawText: t.slice(0, 400) });
    }
    return out;
  });
  const ageOf = (raw) => { const m = raw.match(/\[(\d+)\s*小时前\]/); return m ? Number(m[1]) : null; };
  const candidates = posts.filter((p) => { const h = ageOf(p.rawText); return h !== null && h >= 1 && h <= 4; });
  console.log(`候选 ${posts.length} 条，其中自报 1~4h 的 ${candidates.length} 条`);
  console.log(JSON.stringify(candidates, null, 1));
} finally {
  await space.finish({ keep: [] });
}