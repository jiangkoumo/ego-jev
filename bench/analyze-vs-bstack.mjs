// 对照基准的全量合并分析：3 个完整批次 × 2 栈 × 3 任务 × 3 轮
// 关键点：wiki 的成功判据在批次之间被改宽过，这里用各批次记录的 finalUrl
// 在「旧窄判据」和「新宽判据」下分别重算成功与否，避免用引擎变量掩盖判据变更。
// 用法: node bench/analyze-vs-bstack.mjs
const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
const RAW = "/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench/raw";

const BATCHES = [
  { file: "vs-bstack-2026-09-19T14-51-12.jsonl", engine: "rev1", note: "判据=旧窄" },
  { file: "vs-bstack-2026-09-19T14-54-32.jsonl", engine: "rev1", note: "判据=新宽" },
  { file: "vs-bstack-2026-09-19T14-57-26.jsonl", engine: "rev2", note: "判据=新宽（引擎已改为 domcontentloaded 等待）" },
];

// 旧窄判据（批次 1 实际使用的那个）
const NARROW = (u) => /\/wiki\/JEV|\/w\/index\.php\?search=|Special:Search/i.test(u);
// 新宽判据（批次 2/3 使用的那个；把 A 走「回车」落到重定向目标也算成功）
const WIDE = (u) => /\/(wiki\/(JEV|Japanese_encephalitis)|w\/index\.php\?search=|wiki\/Special:Search)/i.test(u);

const rows = [];
for (const batch of BATCHES) {
  const text = readFileSync(`${RAW}/${batch.file}`, "utf8");
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const r = JSON.parse(line);
    rows.push({ ...r, batch: batch.file, engine: batch.engine, batchNote: batch.note });
  }
}

const TASKS = ["hn-nav", "wiki-search", "httpbin-form"];
const STACKS = ["A", "B"];
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

const successUnder = (r, predicate) => {
  if (r.task !== "wiki-search") return Boolean(r.success);
  return predicate(String(r.finalUrl || ""));
};

const summarize = (rs, predicate) => {
  const ok = rs.filter((r) => successUnder(r, predicate));
  const ms = ok.map((r) => r.elapsedMs);
  return {
    n: rs.length,
    ok: ok.length,
    medianMs: median(ms),
    minMs: ms.length ? Math.min(...ms) : null,
    maxMs: ms.length ? Math.max(...ms) : null,
    medianSteps: median(ok.map((r) => r.steps)),
    medianJevCalls: median(ok.map((r) => r.jevCalls)),
    samplesMs: rs.map((r) => r.elapsedMs),
    samplesSteps: rs.map((r) => r.steps),
  };
};

const out = { generatedFrom: BATCHES.map((b) => b.file), predicates: { narrow: String(NARROW), wide: String(WIDE) }, perBatch: {}, merged: {} };

console.log("=== 逐批次（wiki 同时给出两种判据下的成功数）===");
for (const batch of BATCHES) {
  const b = { engine: batch.engine, note: batch.note, tasks: {} };
  console.log(`\n-- ${batch.file}  引擎=${batch.engine}  ${batch.note}`);
  for (const task of TASKS) {
    for (const stack of STACKS) {
      const rs = rows.filter((r) => r.batch === batch.file && r.task === task && r.stack === stack);
      const narrow = summarize(rs, NARROW);
      const wide = summarize(rs, WIDE);
      b.tasks[`${stack}|${task}`] = { narrow, wide };
      const tag = task === "wiki-search" ? `旧判据 ${narrow.ok}/${narrow.n}  新判据 ${wide.ok}/${wide.n}` : `${wide.ok}/${wide.n}`;
      console.log(`   ${stack} ${task.padEnd(14)} 成功 ${tag}  中位(按新判据)=${wide.medianMs}ms  [${rs.map((r) => r.elapsedMs).join(", ")}]`);
    }
  }
  out.perBatch[batch.file] = b;
}

console.log("\n=== 三批合并（每格 n=9）===");
for (const task of TASKS) {
  for (const stack of STACKS) {
    const rs = rows.filter((r) => r.task === task && r.stack === stack);
    const narrow = summarize(rs, NARROW);
    const wide = summarize(rs, WIDE);
    out.merged[`${stack}|${task}`] = { narrow, wide };
    const tag = task === "wiki-search" ? `旧判据 ${narrow.ok}/${narrow.n}  新判据 ${wide.ok}/${wide.n}` : `${wide.ok}/${wide.n}`;
    console.log(`  ${stack} ${task.padEnd(14)} 成功 ${tag}  中位(新判据)=${wide.medianMs}ms  步中位=${wide.medianSteps}  Jev中位=${wide.medianJevCalls}  范围=[${wide.minMs}..${wide.maxMs}]`);
  }
}

console.log("\n=== A 相对 B 的差异（按新判据中位）===");
for (const task of TASKS) {
  const a = out.merged[`A|${task}`].wide.medianMs;
  const b = out.merged[`B|${task}`].wide.medianMs;
  const pct = (((a - b) / b) * 100).toFixed(1);
  console.log(`  ${task.padEnd(14)} A=${a}ms B=${b}ms → A ${pct > 0 ? "慢" : "快"} ${Math.abs(pct)}%`);
}

// 逐批次 A/B 胜负（httpbin 用来说明结论对批次敏感）
console.log("\n=== 逐批次 A/B（每个任务的胜负方向）===");
for (const task of TASKS) {
  const parts = [];
  for (const batch of BATCHES) {
    const a = out.perBatch[batch.file].tasks[`A|${task}`].wide.medianMs;
    const b = out.perBatch[batch.file].tasks[`B|${task}`].wide.medianMs;
    parts.push(`${batch.file.match(/T(\d\d-\d\d-\d\d)/)[1]}: A=${a} B=${b} ${a < b ? "A胜" : "B胜"}`);
  }
  console.log(`  ${task.padEnd(14)} ` + parts.join(" | "));
}

writeFileSync(`${RAW}/vs-bstack-merged.json`, JSON.stringify(out, null, 2));
console.log("\nRAW: " + `${RAW}/vs-bstack-merged.json`);
