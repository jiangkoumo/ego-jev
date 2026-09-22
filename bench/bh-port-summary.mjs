// 把 BH-PORT-REPORT.md 里的每个数字从 bench/raw/ 的原始文件里重算一遍（可追溯、不手抄）。
// 用法: node bench/bh-port-summary.mjs
import { readdirSync, readFileSync } from "node:fs";
const RAW = new URL("./raw/", import.meta.url).pathname;
/** 1 轮 harness 校验（dryrun）与审阅后复核（postreview）不进主表 */
const latest = (prefix) => {
  const files = readdirSync(RAW)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.includes("dryrun") && !f.includes("postreview"))
    .sort();
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { file, data: JSON.parse(readFileSync(RAW + file, "utf8")) };
};
const latestAny = (prefix, tag) => {
  const files = readdirSync(RAW).filter((f) => f.startsWith(prefix) && f.endsWith(".json") && f.includes(tag)).sort();
  if (!files.length) return null;
  const file = files[files.length - 1];
  return { file, data: JSON.parse(readFileSync(RAW + file, "utf8")) };
};
/** 某前缀下全部非 dryrun 文件（用于汇总线上运行计数） */
const allFiles = (prefix) =>
  readdirSync(RAW)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.includes("dryrun"))
    .sort()
    .map((f) => ({ file: f, data: JSON.parse(readFileSync(RAW + f, "utf8")) }));
const pct = (a, b) => `${a}/${b}`;

console.log("=== P0-1a  X 配对（修正后的 harness：测锚点与跑任务在同一次加载上）===");
{
  const hit = latest("x-scroll-pair-");
  if (!hit) console.log("  (缺 x-scroll-pair-*.json)");
  else {
    console.log(`  raw: ${hit.file}`);
    for (const s of hit.data.summary) {
      console.log(
        `  ${s.task.padEnd(10)} old ${s.oldSuccess.padEnd(4)} new ${s.newSuccess.padEnd(4)}` +
          `  失败原因 old=${JSON.stringify(s.oldReasons)} new=${JSON.stringify(s.newReasons)}` +
          `  中位 ${s.oldMedianMs}→${s.newMedianMs}ms` +
          `  新引擎滚动步[${s.newScrollSteps.join(",")}] 最长同动作[${s.newMaxSameActionRun.join(",")}] 滚入[${s.newIntoView.join(",")}] 揭示[${s.newReveal.join(",")}]`
      );
    }
    const all = hit.data.records.filter((r) => r.reason !== "no_anchor");
    const by = (e) => all.filter((r) => r.engine === e);
    const dist = (rs) => {
      const d = {};
      for (const r of rs) if (!r.success) d[r.reason] = (d[r.reason] || 0) + 1;
      return d;
    };
    console.log(
      `  X 合计 old ${pct(by("old").filter((r) => r.success).length, by("old").length)} ${JSON.stringify(dist(by("old")))}` +
        ` | new ${pct(by("new").filter((r) => r.success).length, by("new").length)} ${JSON.stringify(dist(by("new")))}`
    );
    console.log(
      `  新引擎最长同动作峰值 ${Math.max(...by("new").map((r) => r.maxSameActionRun || 0))}；只读互锁拦截 ${all.reduce((a, r) => a + (r.readOnlyBlocked?.length || 0), 0)} 次；` +
        `A 机制(滚入)合计 ${by("new").reduce((a, r) => a + (r.intoViewTotal || 0), 0)} 次`
    );
  }
}

console.log("\n=== P0-1a' X final 引擎复核（x-far × 3 轮，审阅后）===");
{
  const hit = latestAny("x-scroll-pair-", "postreview");
  if (!hit) console.log("  (缺 x-scroll-pair-postreview-*.json)");
  else {
    const all = hit.data.records.filter((r) => r.reason !== "no_anchor");
    const by = (e) => all.filter((r) => r.engine === e);
    console.log(
      `  raw: ${hit.file}\n  old ${pct(by("old").filter((r) => r.success).length, by("old").length)} ${JSON.stringify(by("old").map((r) => r.reason))}` +
        `  →  new ${pct(by("new").filter((r) => r.success).length, by("new").length)}  滚动步[${by("new").map((r) => r.scrollSteps).join(",")}] 最长同动作[${by("new").map((r) => r.maxSameActionRun).join(",")}]`
    );
  }
}

console.log("\n=== P0-1b  X 冻结 harness（与 0/15 同一脚本，仅换引擎）===");
{
  const hit = latest("x-frozen-new-");
  if (!hit) console.log("  (缺 x-frozen-new-*.json)");
  else {
    const rs = hit.data.records.filter((r) => r.reason !== "no_anchor");
    const d = {};
    for (const r of rs) if (!r.success) d[r.reason] = (d[r.reason] || 0) + 1;
    console.log(`  raw: ${hit.file}\n  新引擎 ${pct(rs.filter((r) => r.success).length, rs.length)}  失败原因 ${JSON.stringify(d)}  揭示次数 [${rs.map((r) => r.revealCount).join(", ")}]`);
  }
}

console.log("\n=== P0-1c  X 单步诊断（目标在表内时 Jev 选什么）===");
{
  const hit = latest("x-one-step-");
  if (!hit) console.log("  (缺 x-one-step-*.json)");
  else {
    const rs = hit.data.iterations.filter((r) => r.action);
    console.log(`  raw: ${hit.file}`);
    console.log(
      `  ${rs.length} 次：目标在 state 内 ${pct(rs.filter((r) => r.targetInState).length, rs.length)}；` +
        `选 click ${pct(rs.filter((r) => r.action === "click").length, rs.length)}；` +
        `置信度 [${rs.map((r) => r.confidence).join(", ")}]；拦截 ${rs.reduce((a, r) => a + (r.readOnlyBlocked?.length || 0), 0)} 次`
    );
  }
}

console.log("\n=== 无回归：hn-nav / wiki-search / select-native（配对，新−旧）===");
{
  const hit = latest("scroll-noregress-");
  if (!hit) console.log("  (缺 scroll-noregress-*.json)");
  else {
    console.log(`  raw: ${hit.file}`);
    for (const s of hit.data.summary) {
      console.log(
        `  ${s.task.padEnd(14)} old ${s.oldSuccess.padEnd(4)} new ${s.newSuccess.padEnd(4)}` +
          `  中位 ${s.oldMedian}→${s.newMedian}ms  配对 ${s.pairedRounds} 轮 中位差 ${s.medianDiff}ms` +
          `  CI=[${Math.round(s.ci.low)}, ${Math.round(s.ci.high)}] 跨0=${s.crossesZero} 符号 ${s.signTest.pos}/${s.signTest.neg} p=${s.signTest.p.toFixed(3)}`
      );
    }
  }
}

console.log("\n=== 无回归：延迟导航 / 护栏 / emoji 边界 / 滚动机制单测 ===");
for (const [label, prefix, fmt] of [
  ["delayed-nav", "delayed-nav-", (d) => Object.entries(d.arms).map(([k, v]) => `${k}=${v.successRate}`).join(" ")],
  ["test-guardrails", "test-guardrails", () => "见 bench/raw/test-guardrails.txt（23/23）"],
  ["emoji-clip", "test-emoji-clip-", (d) => `${d.pass} 通过 / ${d.fail} 失败`],
  ["scroll-progress", "test-scroll-progress-", (d) => `${d.pass} 通过 / ${d.fail} 失败`],
]) {
  const hit = latest(prefix);
  console.log(`  ${label.padEnd(16)} ${hit ? `${fmt(hit.data)}   raw: ${hit.file}` : "(缺)"}`);
}

console.log("\n=== X 上新引擎运行的 Jev 400 / 异常计数（emoji 验收的线上侧）===");
{
  let runs = 0;
  let errors = 0;
  for (const prefix of ["x-scroll-pair-", "x-frozen-new-", "x-one-step-", "x-diagnose-"]) {
    for (const hit of allFiles(prefix)) {
      const rs = (hit.data.records || hit.data.iterations || []).filter((r) => r.reason !== "no_anchor");
      for (const r of rs) {
        if (prefix === "x-scroll-pair-" && r.engine !== "new") continue;
        if (!r.reason && !r.action) continue;
        runs += 1;
        if (r.reason === "harness_error" || r.reason === "action_failed" || r.error) errors += 1;
      }
    }
  }
  console.log(`  计入 ${runs} 次运行，其中 harness_error / action_failed / error = ${errors}（Jev 400 invalid Unicode text 会落在这两类里）`);
}
