// 预登记协议 §5 的统计：描述统计 + 配对差 + bootstrap 95% CI + 符号检验
// 判定规则（预先指定）：CI 跨 0 → "无差异"；不跨 0 → 报方向与幅度。
// 用法: node bench/analyze-verify.mjs [verify-*.jsonl]
const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
const RAW = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench/raw";
const SEED = 20260919;      // 预登记里写死的种子
const BOOT = 10000;         // 预登记里写死的重采样次数

const file = process.argv[2] || readdirSync(RAW).filter((f) => /^verify-.*\.jsonl$/.test(f)).sort().pop();
const rows = readFileSync(`${RAW}/${file}`, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const TASKS = ["hn-nav", "hn-page2", "wiki-search", "httpbin-form", "select-native"];
const STACKS = ["A", "B"];

// ── 确定性 PRNG（bootstrap 可复现） ──
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const quantile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};
const describe = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length, min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5),
    q3: quantile(s, 0.75), max: s[s.length - 1], iqr: quantile(s, 0.75) - quantile(s, 0.25),
  };
};
const bootstrapCI = (diffs, rand) => {
  const out = [];
  for (let i = 0; i < BOOT; i++) {
    const sample = [];
    for (let j = 0; j < diffs.length; j++) sample.push(diffs[Math.floor(rand() * diffs.length)]);
    out.push(quantile([...sample].sort((a, b) => a - b), 0.5));
  }
  out.sort((a, b) => a - b);
  return { lo: quantile(out, 0.025), hi: quantile(out, 0.975) };
};
// 双侧精确符号检验（p=0.5）
const binomTwoSided = (k, n) => {
  if (n === 0) return 1;
  const logC = (n, k) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
    return s;
  };
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    const p = Math.exp(logC(n, i) - n * Math.log(2));
    if (p <= Math.exp(logC(n, k) - n * Math.log(2)) + 1e-12) tail += p;
  }
  return Math.min(1, tail);
};

const out = { sourceFile: file, rows: rows.length, seed: SEED, bootstrapResamples: BOOT, generatedAt: new Date().toISOString(), tasks: {} };
const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };

say(`数据源: ${file}  （${rows.length} 轮）`);
say("");
say("=== 1. 描述统计（成功样本）与成功率（全部有效轮）===");
for (const task of TASKS) {
  const rec = { stacks: {}, paired: null, verdict: null };
  say(`\n-- ${task}`);
  for (const stack of STACKS) {
    const all = rows.filter((r) => r.task === task && r.stack === stack);
    const ok = all.filter((r) => r.success);
    const d = describe(ok.map((r) => r.elapsedMs));
    rec.stacks[stack] = {
      total: all.length, success: ok.length, successRate: `${ok.length}/${all.length}`,
      elapsed: d,
      medianSteps: ok.length ? describe(ok.map((r) => r.steps)).median : null,
      medianJevCalls: ok.length ? describe(ok.map((r) => r.jevCalls)).median : null,
      reasons: all.reduce((acc, r) => { if (!r.success) acc[r.reason] = (acc[r.reason] || 0) + 1; return acc; }, {}),
      retriedRounds: all.filter((r) => r.attempts > 1).length,
    };
    const s = rec.stacks[stack];
    say(`   ${stack}: 成功率 ${s.successRate}  中位 ${d ? Math.round(d.median) : "-"}ms  IQR [${d ? Math.round(d.q1) : "-"}..${d ? Math.round(d.q3) : "-"}]  极值 [${d ? d.min : "-"}..${d ? d.max : "-"}]  步中位 ${s.medianSteps}  Jev中位 ${s.medianJevCalls}  重试轮 ${s.retriedRounds}  失败原因 ${JSON.stringify(s.reasons)}`);
  }

  // 配对：同一轮次两栈都成功
  const byRound = {};
  for (const r of rows.filter((r) => r.task === task)) (byRound[r.round] ||= {})[r.stack] = r;
  const diffs = [];
  const pairs = [];
  for (const round of Object.keys(byRound).map(Number).sort((a, b) => a - b)) {
    const { A, B } = byRound[round];
    if (A?.success && B?.success) { diffs.push(A.elapsedMs - B.elapsedMs); pairs.push({ round, A: A.elapsedMs, B: B.elapsedMs, d: A.elapsedMs - B.elapsedMs }); }
  }
  const rand = mulberry32(SEED);
  const winsA = diffs.filter((d) => d < 0).length;
  const winsB = diffs.filter((d) => d > 0).length;
  const ci = diffs.length ? bootstrapCI(diffs, rand) : null;
  const p = diffs.length ? binomTwoSided(Math.min(winsA, winsB), winsA + winsB) : null;
  const medianD = diffs.length ? quantile([...diffs].sort((a, b) => a - b), 0.5) : null;
  const meanD = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  const crossesZero = ci ? ci.lo <= 0 && ci.hi >= 0 : null;

  rec.paired = {
    usableRounds: diffs.length, pairs, diffs,
    medianDiff: medianD, meanDiff: meanD, ci, winsA, winsB, signTestP: p, crossesZero,
  };
  if (diffs.length >= 5) {
    rec.verdict = crossesZero ? "无差异" : medianD < 0 ? "A 更快" : "B 更快";
    say(`   配对 (${diffs.length} 轮): A−B 中位差 ${medianD > 0 ? "+" : ""}${Math.round(medianD)}ms  均值差 ${meanD > 0 ? "+" : ""}${Math.round(meanD)}ms`);
    say(`   bootstrap 95% CI [${Math.round(ci.lo)}, ${Math.round(ci.hi)}]  ${crossesZero ? "→ 跨 0" : "→ 不跨 0"}   A 胜 ${winsA} / B 胜 ${winsB}  符号检验 p=${p.toFixed(3)}`);
    say(`   → 结论：${rec.verdict}`);
  } else {
    rec.verdict = "样本不足（配对轮 < 5）";
    say(`   配对可用轮次仅 ${diffs.length}（<5）→ 不出结论；成功率差异见上。`);
  }
  out.tasks[task] = rec;
}

// 噪声源：Jev 决策次数与单次延迟
say("\n=== 2. 噪声源分离（成功样本中位）===");
for (const task of TASKS) {
  const parts = [];
  for (const stack of STACKS) {
    const ok = rows.filter((r) => r.task === task && r.stack === stack && r.success);
    const jev = ok.map((r) => r.jevCalls);
    const lat = ok.flatMap((r) => (r.jevLatencyMs || []));
    parts.push(`${stack}: Jev次数中位=${jev.length ? describe(jev).median : "-"}${lat.length ? ` 单次Jev中位=${Math.round(describe(lat).median)}ms` : ""}`);
  }
  say(`   ${task.padEnd(15)} ${parts.join("   ")}`);
}

// 重试与失败明细（不得静默丢弃）
say("\n=== 3. 重试与失败明细（全部保留）===");
const retried = rows.filter((r) => r.attempts > 1);
say(`   重试过的轮次: ${retried.length} → ${retried.map((r) => `r${r.round}/${r.stack}/${r.task}(attempts=${r.attempts}${r.success ? "" : ",失败"})`).join(" ") || "无"}`);
for (const stack of STACKS) {
  const failed = rows.filter((r) => r.stack === stack && !r.success);
  say(`   ${stack} 失败轮 ${failed.length}: ${failed.map((r) => `${r.task}#${r.round}:${r.reason}`).join(" ") || "无"}`);
}

writeFileSync(`${RAW}/verify-analysis-${file.replace(/^verify-|\.jsonl$/g, "")}.json`, JSON.stringify(out, null, 2));
writeFileSync(`${RAW}/verify-analysis-${file.replace(/^verify-|\.jsonl$/g, "")}.txt`, lines.join("\n") + "\n");
say(`\nRAW: ${RAW}/verify-analysis-${file.replace(/^verify-|\.jsonl$/g, "")}.json`);
