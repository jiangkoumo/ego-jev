// `--handoff-prompt` 的回归测试：子代理上下文里既没有技能清单、也没有 AGENTS.md 内容，
// 派活时必须显式点名。这个选项就是把「点名」做成可粘贴的指派块。
// 断言：真实路径（技能目录 / CLI / SKILL.md）、路由判据（多步线性 vs 单步分流）、命令模板、
// --json 结构、不含外部仓库名、两次运行逐字节一致（确定性）。
// 纯 node，无浏览器、无网络、无凭证（刻意把 HOME 指到临时目录并清掉凭证变量）。
// 用法: node bench/test-handoff-prompt.mjs
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const REPO = fs.realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const CLI = join(REPO, "scripts", "ego-decision-layer");
const SKILL_MD = join(REPO, "SKILL.md");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// 外部仓库名：拆开写，避免本文件自己命中（与本目录既有的 no-bh / release-consistency 同款手法）
const EXT_REPO = [
  "browser" + "-use",
  "jev" + "-ultrafast",
  "citro" + "labs",
  "ego" + "-lite",
  "github" + "." + "com",
];

const HOME = fs.mkdtempSync(join(os.tmpdir(), "ego-decision-layer-handoff-"));
const env = {
  ...process.env, HOME,
  TYPESAFE_API_KEY: "",                                            // 清掉环境变量凭证
  TYPESAFE_API_KEY_FILE: join(HOME, "definitely-missing", "key"),  // 且没有凭证文件
  EGO_JEV_NO_WIRE: "1",                                            // 只读选项：不做首跑接管
};
const run = (...args) => {
  const r = spawnSync("bash", [CLI, ...args], { env, encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout ?? ""), err: (r.stderr ?? "") };
};

// ── [1] 默认纯文本：可粘贴，含真实路径与判据 ────────────────────────────────
console.log("\n[1] --handoff-prompt（纯文本）");
const plain = run("--handoff-prompt");
{
  check("退出码 0（无凭证也能用）", plain.code === 0, `exit=${plain.code} stderr=${plain.err.slice(0, 200)}`);
  check("含技能目录真实路径", plain.out.includes(REPO), REPO);
  check("含 CLI 真实路径", plain.out.includes(CLI), CLI);
  check("含 SKILL.md 真实路径", plain.out.includes(SKILL_MD), SKILL_MD);
  check("三条路径都是绝对路径（没有硬编码 ~）", !plain.out.includes("~") && [REPO, CLI, SKILL_MD].every((p) => p.startsWith("/")), "含 ~");
  check("有「先读 SKILL.md 再动手」", /先读 SKILL\.md 再动手/.test(plain.out));
  check("有「多步线性」判据", plain.out.includes("多步线性"));
  check("判据列出全部触发词（连续点击/翻页/搜索表单提交/多字段填写/导航跳转）",
    ["连续点击", "翻页", "搜索表单提交", "多字段填写", "导航跳转"].every((w) => plain.out.includes(w)));
  check("单步分流（单步动作 + ego-browser 原生 API）", plain.out.includes("单步动作") && plain.out.includes("ego-browser"));
  check("命令模板含 --url/--until/--steps（外加 --text）",
    ["--url", "--until", "--steps", "--text"].every((w) => plain.out.includes(w)));
  check("结尾指向 --route-status 核对", plain.out.trimEnd().endsWith(`--route-status 核对路由状态（只读 JSON，不起浏览器、不需要凭证）。`), plain.out.trimEnd().slice(-40));
}

// ── [2] --json：结构与字段 ──────────────────────────────────────────────────
console.log("\n[2] --handoff-prompt --json");
const jsonRun = run("--handoff-prompt", "--json");
let obj = null;
try { obj = JSON.parse(jsonRun.out); } catch { obj = null; }
{
  check("退出码 0", jsonRun.code === 0, `exit=${jsonRun.code}`);
  check("是合法 JSON", obj !== null, jsonRun.out.slice(0, 120));
  check("字段恰好是 prompt/skillDir/cliPath/skillMdPath",
    obj && Object.keys(obj).sort().join(",") === "cliPath,prompt,skillDir,skillMdPath", obj && Object.keys(obj).join(","));
  check("skillDir 正确", obj && obj.skillDir === REPO, obj && obj.skillDir);
  check("cliPath 正确", obj && obj.cliPath === CLI, obj && obj.cliPath);
  check("skillMdPath 正确", obj && obj.skillMdPath === SKILL_MD, obj && obj.skillMdPath);
  check("prompt === 纯文本输出（去掉尾部换行）", obj && obj.prompt === plain.out.replace(/\n$/, ""), "两者不一致");
  check("三个路径都真实存在", [obj?.cliPath, obj?.skillDir, obj?.skillMdPath].every((p) => p && fs.existsSync(p)), JSON.stringify(obj));
}

// ── [3] 不含任何外部仓库名 ──────────────────────────────────────────────────
console.log("\n[3] 外部仓库名扫描");
{
  const hit = EXT_REPO.filter((n) => plain.out.includes(n) || jsonRun.out.includes(n));
  check("输出与 JSON 里没有外部仓库名", hit.length === 0, hit.join(", "));
}

// ── [4] 确定性：两次运行逐字节一致 ─────────────────────────────────────────
console.log("\n[4] 确定性");
{
  const a = run("--handoff-prompt"), b = run("--handoff-prompt");
  check("纯文本两次逐字节相同", a.out === b.out, "输出不同");
  const c = run("--handoff-prompt", "--json"), d = run("--handoff-prompt", "--json");
  check("--json 两次逐字节相同", c.out === d.out, "输出不同");
}

// ── [5] 参数校验：--json 必须与 --handoff-prompt 同用 ───────────────────────
console.log("\n[5] 参数校验");
{
  const alone = run("--json");
  check("单独 --json → exit 2", alone.code === 2, `exit=${alone.code}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
