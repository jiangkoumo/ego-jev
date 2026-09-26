// 「不依赖 browser-harness」的不变量测试：仓库里的可执行脚本（sh / mjs / js / py）
// 不许出现 browser-harness 的调用面（端点变量、ensure 调用、python 包导入），
// A 臂编排脚本必须是 A-only，且它的环境预检契约要成立。
// 用法: node bench/test-no-bh-dependency.mjs   （无浏览器、无凭证、无网络）
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join, relative } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY = join(REPO, "bench", "verify.sh");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// 拆开写：这样本文件自身不会命中下面扫描的模式
const PATTERNS = [
  new RegExp("browser" + "[-_]harness", "i"),
  new RegExp("\\bb" + "h\\s+ensure"),
  new RegExp("BU_" + "CDP_WS"),
];

// 只扫「代码行」：纯注释行允许解释历史（如 verify.sh 头部的说明），
// 但任何真调用（或行尾注释里藏着的调用）都要被抓住。
const isCommentOnly = (line) => /^\s*(#|\/\/|\*|\/\*)/.test(line);

// ── [1] 静态扫描：可执行脚本里不许有 browser-harness 的调用面 ────────────────
console.log("\n[1] 静态扫描");
{
  const SKIP_DIRS = new Set(["node_modules", ".git", "raw", "__pycache__", ".contrib", ".agent-tape", "bench"]);
  const EXTS = new Set([".sh", ".mjs", ".js", ".py"]);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // bench/ 例外：它是历史对照工具的所在地，单独按“驱动脚本是否存在”查（见 [2]）
        if (!SKIP_DIRS.has(e.name) && !(dir === REPO && e.name === "bench")) walk(join(dir, e.name));
        continue;
      }
      const dot = e.name.lastIndexOf(".");
      if (dot < 0 || !EXTS.has(e.name.slice(dot))) continue;
      const p = join(dir, e.name);
      fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (isCommentOnly(line)) return;
        if (PATTERNS.some((re) => re.test(line))) hits.push(`${relative(REPO, p)}:${i + 1}`);
      });
    }
  };
  walk(REPO);
  check("产品/安装/脚本目录里没有 browser-harness 调用面", hits.length === 0, hits.join(", "));

  // bench/ 里也必须没有“驱动 B 臂”的可执行脚本（除了这个测试文件自己）
  const benchFiles = [];
  const walkBench = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "raw" && e.name !== "__pycache__") walkBench(p); continue; }
      const dot = e.name.lastIndexOf(".");
      if (dot < 0 || !EXTS.has(e.name.slice(dot))) continue;
      if (p === fileURLToPath(import.meta.url)) continue;
      const dirty = fs.readFileSync(p, "utf8").split("\n")
        .some((line) => !isCommentOnly(line) && PATTERNS.some((re) => re.test(line)));
      if (dirty) benchFiles.push(relative(REPO, p));
    }
  };
  walkBench(join(REPO, "bench"));
  check("bench/ 里没有 B 臂驱动或端点变量残留", benchFiles.length === 0, benchFiles.join(", "));

  const gone = ["run-b.py", "verify-run-b.py", "reveal-run-b.py", "vs-bstack.sh"];
  const still = gone.filter((f) => fs.existsSync(join(REPO, "bench", f)));
  check("B 臂驱动脚本已撤出仓库", still.length === 0, still.join(", "));
}

// ── [2] verify.sh 的环境预检契约 ────────────────────────────────────────────
console.log("\n[2] verify.sh --check-env");
{
  const root = fs.mkdtempSync(join(os.tmpdir(), "ego-decision-layer-nobh-"));
  const fakeBin = join(root, "bin-ego");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(join(fakeBin, "ego-browser"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'ego-browser 0.0.0-test' >&2; fi\nexit 0\n", { mode: 0o755 });
  const clean = (process.env.PATH || "").split(":").filter((d) => d && !fs.existsSync(join(d, "ego-browser"))).join(":");
  const run = (binDir, args) => {
    const r = spawnSync("bash", [VERIFY, ...args], {
      env: { ...process.env, PATH: `${binDir}:${clean}` },
      encoding: "utf8",
      timeout: 60000,
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const withEgo = run(fakeBin, ["--check-env"]);
  check("有 ego-browser 时 exit 0", withEgo.code === 0, `code=${withEgo.code} ${withEgo.out}`);
  check("打印可用与版本号（版本号走 stderr 也要读到）", withEgo.out.includes("可用") && withEgo.out.includes("0.0.0-test"), withEgo.out);

  const noEgo = run(join(root, "bin-empty"), ["--check-env"]);
  check("没有 ego-browser 时 exit 1", noEgo.code === 1, `code=${noEgo.code} ${noEgo.out}`);
  check("说清不可用原因", noEgo.out.includes("不可用") && noEgo.out.includes("ego-browser"), noEgo.out);

  fs.rmSync(root, { recursive: true, force: true });
}

// ── [3] 兼容与参数校验 ──────────────────────────────────────────────────────
console.log("\n[3] 参数");
{
  const r = spawnSync("bash", [VERIFY, "--banana"], { encoding: "utf8", timeout: 60000 });
  check("未知参数 → exit 2", (r.status ?? 1) === 2, `code=${r.status} ${r.stderr ?? ""}`);
  const help = fs.readFileSync(VERIFY, "utf8");
  check("--a-only 仍被接受（兼容旧命令）", /--a-only\)\s*:/.test(help), help.split("\n").find((l) => l.includes("--a-only")));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
