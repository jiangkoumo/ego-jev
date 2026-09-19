// 修复验证的统计：功能验收（hn-page2 成功率）+ 无回归（配对 old vs new，bootstrap CI）
// 用法: node bench/analyze-fix.mjs
const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
const RAW = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench/raw";
const SEED = 20260919, BOOT = 10000;

const newest = (re) => readdirSync(RAW).filter((f) => re.test(f)).sort().pop();
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const quantile = (s, p) => {
  if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const describe = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[s.length - 1] };
};
const bootstrapCI = (diffs, rand) => {
  const out = [];
  for (let i = 0; i < BOOT; i++) {
    const s = [];
    for (let j = 0; j < diffs.length; j++) s.push(diffs[Math.floor(rand() * diffs.length)]);
    out.push(quantile([...s].sort((a, b) => a - b), 0.5));
  }
  out.sort((a, b) => a - b);
  return { lo: quantile(out, 0.025), hi: quantile(out, 0.975) };
};
const logC = (n, k) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; };
const binomTwoSided = (k, n) => {
  if (!n) return 1;
  let tail = 0;
  const pk = Math.exp(logC(n, k) - n * Math.log(2));
  for (let i = 0; i <= n; i++) { const p = Math.exp(logC(n, i) - n * Math.log(2)); if (p <= pk + 1e-12) tail += p; }
  return Math.min(1, tail);
};

const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const out = { generatedAt: new Date().toISOString(), seed: SEED, bootstrapResamples: BOOT };

// ── 1) 功能验收：hn-page2 old vs new ──
const p2file = newest(/^fix-hn-page2-.*\.json$/);
const p2 = JSON.parse(readFileSync(`${RAW}/${p2file}`, "utf8"));
say(`=== 1. 功能验收 hn-page2（判据：${p2.predicate}）===\n数据源: ${p2file}  （${p2.rounds} 轮 × 2 引擎，交替）`);
out.hnPage2 = { sourceFile: p2file, rounds: p2.rounds, engines: {} };
for (const which of ["old", "new"]) {
  const rs = p2.records.filter((r) => r.engine === which);
  const ok = rs.filter((r) => r.success);
  const d = describe(ok.map((r) => r.elapsedMs));
  out.hnPage2.engines[which] = { success: `${ok.length}/${rs.length}`, elapsed: d, steps: ok.length ? describe(ok.map((r) => r.steps)).median : null, jevCalls: ok.length ? describe(ok.map((r) => r.jevCalls)).median : null, reasons: rs.reduce((a, r) => { if (!r.success) a[r.reason] = (a[r.reason] || 0) + 1; return a; }, {}) };
  say(`  ${which.padEnd(4)}: 成功率 ${ok.length}/${rs.length}  成功中位 ${d ? Math.round(d.median) : "-"}ms  IQR[${d ? Math.round(d.q1) : "-"}..${d ? Math.round(d.q3) : "-"}]  步中位 ${out.hnPage2.engines[which].steps}  Jev中位 ${out.hnPage2.engines[which].jevCalls}  失败原因 ${JSON.stringify(out.hnPage2.engines[which].reasons)}`);
}

// ── 2) 无回归：配对 old vs new ──
const nrfile = newest(/^fix-noregress-.*\.json$/);
const nr = JSON.parse(readFileSync(`${RAW}/${nrfile}`, "utf8"));
say(`\n=== 2. 无回归（同会话配对，新−旧；负数=新更快）===\n数据源: ${nrfile}  （${nr.rounds} 轮 × 2 引擎，交替，奇偶轮翻转先后）`);
out.noRegress = { sourceFile: nrfile, rounds: nr.rounds, tasks: {} };
for (const task of ["hn-nav", "wiki-search", "select-native"]) {
  const rows = nr.records.filter((r) => r.task === task);
  const oldOk = rows.filter((r) => r.engine === "old" && r.success).map((r) => r.elapsedMs);
  const newOk = rows.filter((r) => r.engine === "new" && r.success).map((r) => r.elapsedMs);
  const diffs = [], pairs = [];
  for (let round = 1; round <= nr.rounds; round++) {
    const ro = rows.find((r) => r.round === round && r.engine === "old");
    const rn = rows.find((r) => r.round === round && r.engine === "new");
    if (ro?.success && rn?.success) { diffs.push(rn.elapsedMs - ro.elapsedMs); pairs.push({ round, old: ro.elapsedMs, new: rn.elapsedMs, d: rn.elapsedMs - ro.elapsedMs }); }
  }
  const rand = mulberry32(SEED);
  const ci = diffs.length ? bootstrapCI(diffs, rand) : null;
  const winsNew = diffs.filter((d) => d < 0).length, winsOld = diffs.filter((d) => d > 0).length;
  const crossesZero = ci ? ci.lo <= 0 && ci.hi >= 0 : null;
  out.noRegress.tasks[task] = {
    old: { success: `${oldOk.length}/${nr.rounds}`, elapsed: describe(oldOk) },
    new: { success: `${newOk.length}/${nr.rounds}`, elapsed: describe(newOk) },
    pairs, diffs, medianDiff: diffs.length ? quantile([...diffs].sort((a, b) => a - b), 0.5) : null, ci, crossesZero,
    winsNew, winsOld, signTestP: diffs.length ? binomTwoSided(Math.min(winsNew, winsOld), winsNew + winsOld) : null,
  };
  const t = out.noRegress.tasks[task];
  say(`  ${task.padEnd(14)} 旧 ${oldOk.length}/${nr.rounds} 中位 ${Math.round(describe(oldOk).median)}ms | 新 ${newOk.length}/${nr.rounds} 中位 ${Math.round(describe(newOk).median)}ms`);
  say(`     配对 ${diffs.length} 轮 中位差 ${t.medianDiff > 0 ? "+" : ""}${Math.round(t.medianDiff)}ms  bootstrap 95% CI [${Math.round(ci.lo)}, ${Math.round(ci.hi)}] ${crossesZero ? "→ 跨 0（无回归证据）" : "→ 不跨 0"}  新胜 ${winsNew}/旧胜 ${winsOld}  符号检验 p=${t.signTestP.toFixed(3)}`);
  say(`     差值明细 [${diffs.map((d) => (d > 0 ? "+" : "") + d).join(", ")}]`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`${RAW}/fix-analysis-${stamp}.json`, JSON.stringify(out, null, 2));
writeFileSync(`${RAW}/fix-analysis-${stamp}.txt`, lines.join("\n") + "\n");
say(`\nRAW: ${RAW}/fix-analysis-${stamp}.json`);
