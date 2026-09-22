// 只读：量 TL1 点筛选后的真实重取生命周期（列表何时清空、何时重填、多久稳定）
const { writeFile } = await import("node:fs/promises");
const OUT = "/tmp/ego-switch/tl1-lifecycle.json";
const space = await taskSpace(`ego-tl1lc-${Date.now()}`);
const page = space.page("p1");
const out = { startedAt: new Date().toISOString() };
const ev = async (fn, ...rest) => (rest.length ? page.evaluate(fn, rest[0]) : page.evaluate(fn));
const snap = () => ev(() => {
  const links = document.querySelectorAll('a[href*="/status/"]').length;
  const labels = (document.body.innerText.match(/\[[^\]]*?前\]/g) || []);
  return { links, labels: labels.length, head: labels.slice(0, 3) };
});
const clickLabel = (label) => ev((lb) => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === lb);
  if (!b) return false;
  b.click();
  return true;
}, label);
const track = async (name, ms = 25000, step = 1000) => {
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < ms) {
    const s = await snap();
    samples.push({ t: Date.now() - t0, ...s });
    await page.waitForTimeout(step);
  }
  // 压缩：只保留与前一采样不同的样本 + 每 5 秒一个
  const kept = samples.filter((s, i) => i === 0 || s.links !== samples[i - 1].links || s.labels !== samples[i - 1].labels || s.t % 5000 < step);
  out[name] = { samples: samples.length, changes: kept };
  console.log(`  ${name}: ${samples.length} 次采样，变化点 ${kept.length} 个`);
  for (const s of kept) console.log(`    t=${s.t}ms links=${s.links} labels=${s.labels} head=${JSON.stringify(s.head)}`);
  return samples;
};
try {
  try { await page.goto("https://www.tl1.com/trending", { waitUntil: "domcontentloaded", timeout: 20000 }); } catch {}
  let n = 0;
  for (let i = 0; i < 10 && !n; i++) { await page.waitForTimeout(2000); n = (await snap()).links; }
  console.log("基础页:", JSON.stringify(await snap()));
  console.log("点 3h:");
  await clickLabel("3h");
  await track("afterFilter3h", 25000, 1000);
  console.log("再点 ≤20K:");
  await clickLabel("≤20K");
  await track("afterFilter20K", 25000, 1000);
  out.url = await page.url();
  console.log("final url:", out.url);
} catch (e) { out.err = String(e).slice(0, 300); console.log("ERROR " + out.err); }
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log("RAW: " + OUT);
try { await space.finish({ keep: [] }); } catch {}
