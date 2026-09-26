// bench/verify.sh / bench/vs-bstack.sh 的浏览器栈预检：bh（browser-harness）被移除后，
// 这些脚本必须「明确报错」并给出 A 臂的替代跑法，而不是静默降级成整列 no_output。
// 用法: node bench/test-bench-guard.mjs   （无浏览器、无凭证、无网络）
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY = join(REPO, "bench", "verify.sh");
const VS_BSTACK = join(REPO, "bench", "vs-bstack.sh");
const RAW = join(REPO, "bench", "raw");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const root = fs.mkdtempSync(join(os.tmpdir(), "ego-jev-guard-"));
const binNoBrowser = join(root, "bin-nothing");   // 既没有 ego-browser 也没有 bh
const binWithEgo = join(root, "bin-ego");         // 只有伪 ego-browser（A 臂“可用”）
const outDir = join(root, "out");
for (const d of [binNoBrowser, binWithEgo, outDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(join(binWithEgo, "ego-browser"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'ego-browser 0.0.0-test'; fi\nexit 0\n", { mode: 0o755 });

// 保留真机 PATH（md5 / timeout 等工具要用），但把任何带 bh 的目录挤出去：这样“缺 bh”是构造出来的，不靠机器状态
const cleanPath = (process.env.PATH || "").split(":")
  .filter((d) => d && !fs.existsSync(join(d, "bh")))
  .join(":");
const cleanPathNoEgo = cleanPath.split(":")
  .filter((d) => d && !fs.existsSync(join(d, "ego-browser")))
  .join(":");

const run = (script, args, binDir, extra = {}) => {
  const r = spawnSync("bash", [script, ...args], {
    env: { ...process.env, PATH: `${binDir}:${binDir === binNoBrowser ? cleanPathNoEgo : cleanPath}`, BENCH_OUT_DIR: outDir, ...extra },
    encoding: "utf8",
    timeout: 120000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const countRaw = (prefix) => fs.readdirSync(RAW).filter((f) => f.startsWith(prefix)).length;

// ── [1] --check-env：环境预检（只读、不改任何东西）──────────────────────────
console.log("\n[1] --check-env");
{
  const r = run(VERIFY, ["--check-env"], binNoBrowser);
  check("没有 ego-browser 时 exit 1", r.code === 1, `code=${r.code} ${r.out}`);
  check("说明 A 臂不可用", r.out.includes("A 臂（ego-jev）: 不可用"), r.out);
  check("指出 B 臂缺 bh", r.out.includes("bh 不在 PATH"), r.out);
  check("说明 B 臂只是复现工具", r.out.includes("不依赖"), r.out);
}
{
  const r = run(VERIFY, ["--check-env"], binWithEgo);
  check("A 臂可用时 exit 0", r.code === 0, `code=${r.code} ${r.out}`);
  check("两个臂的状态都打印", r.out.includes("A 臂") && r.out.includes("B 臂"), r.out);
}

// ── [2] 默认跑需要 B 臂：缺 bh 必须硬失败，且不写任何基准文件 ────────────────
console.log("\n[2] 缺 bh 时不许静默降级");
{
  const before = countRaw("verify-");
  const r = run(VERIFY, ["1"], binWithEgo);
  check("默认跑 exit 2", r.code === 2, `code=${r.code} ${r.out}`);
  check("报错给出 --a-only 跑法", r.out.includes("--a-only"), r.out);
  check("报错给出 --check-env 跑法", r.out.includes("--check-env"), r.out);
  check("没在 bench/raw 里写文件", countRaw("verify-") === before, `${before} -> ${countRaw("verify-")}`);
}
{
  const before = countRaw("vs-bstack-");
  const r = run(VS_BSTACK, ["1"], binWithEgo);
  check("vs-bstack.sh exit 2", r.code === 2, `code=${r.code} ${r.out}`);
  check("vs-bstack.sh 报错提到 browser-harness", r.out.includes("browser-harness"), r.out);
  check("没在 bench/raw 里写文件", countRaw("vs-bstack-") === before, `${before} -> ${countRaw("vs-bstack-")}`);
}

// ── [3] --a-only：完全不碰 bh，A 臂照跑（输出只写 BENCH_OUT_DIR）────────────
console.log("\n[3] --a-only 只跑 A 臂");
{
  const before = countRaw("verify-");
  const r = run(VERIFY, ["1", "--a-only"], binWithEgo);
  check("不因缺 bh 而拒绝", !r.out.includes("B 臂不可用"), r.out.slice(0, 200));
  check("日志里记下 A_ONLY=1", r.out.includes("A_ONLY=1"), r.out.slice(0, 300));
  check("没有 B 栈的行", !r.out.includes('"stack":"B"'), r.out.slice(0, 300));
  check("A 栈的行在场（伪 ego-browser 无输出 → no_output）", r.out.includes('"stack":"A"'), r.out.slice(0, 300));
  check("没污染 bench/raw", countRaw("verify-") === before, `${before} -> ${countRaw("verify-")}`);
  const produced = fs.readdirSync(outDir).filter((f) => f.startsWith("verify-"));
  check("结果写进了 BENCH_OUT_DIR", produced.length >= 1, produced.join(","));
}

// ── [4] 参数校验 ────────────────────────────────────────────────────────────
console.log("\n[4] 参数校验");
{
  const r = run(VERIFY, ["--banana"], binWithEgo);
  check("未知参数 → exit 2", r.code === 2, `code=${r.code} ${r.out}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
