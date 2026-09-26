// bench/test-route-trace.mjs — 路由可审计：--route-status 的 JSON、--always-on 的幂等与还原、
// --check 的只读性、generatedHash 的确定性。
// 纯 node，无浏览器、无凭证、无网络；用临时 HOME 造官方软链（与 test-wire-skill.mjs 同款手法）。
// 用法: node bench/test-route-trace.mjs
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { createHash } = await import("node:crypto");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIRE = join(REPO, "scripts", "wire-agent-skills.sh");
const CLI = join(REPO, "scripts", "ego-decision-layer");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const root = fs.mkdtempSync(join(os.tmpdir(), "ego-decision-layer-route-"));
const HOME = join(root, "home");
const VENDOR = join(root, "vendor");
const SKILLS = join(HOME, ".agents", "skills");
const CFG = join(root, "cfg");
const ENTRY = join(SKILLS, "ego-browser");
const VENDOR_LINK = join(HOME, ".local", "share", "ego", "ego-skills");

const vendorSkill = (desc, version) => `---
name: ego-browser
description: ${desc}
metadata:
  version: "${version}"
  date: "2026-09-09"
---

# ego-browser

官方正文。
`;
const setup = () => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of [VENDOR, SKILLS, CFG, join(VENDOR, "references"), dirname(VENDOR_LINK), join(SKILLS, "ego-decision-layer")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill("When you need a browser, read this Skill by default.", "2.0.0"));
  fs.writeFileSync(join(VENDOR, "references", "api.md"), "# api\n");
  fs.writeFileSync(join(SKILLS, "ego-decision-layer", "SKILL.md"), "---\nname: ego-decision-layer\n---\n");
  fs.symlinkSync(VENDOR, VENDOR_LINK, "dir");
  fs.symlinkSync(VENDOR_LINK, ENTRY, "dir");
};

// 没有凭证：证明 --route-status 不需要它
const env = (extra = {}) => ({
  ...process.env, HOME, EGO_JEV_CONFIG_DIR: CFG, EGO_JEV_SKILLS_DIRS: SKILLS,
  PATH: "/usr/bin:/bin", TYPESAFE_API_KEY: "", TYPESAFE_API_KEY_FILE: join(root, "nope", "key"),
  ...extra,
});
const wire = (...args) => {
  const r = spawnSync("bash", [WIRE, ...args], { env: env(), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const statusRaw = () => spawnSync("bash", [WIRE, "--status-json"], { env: env(), encoding: "utf8" });
const status = () => JSON.parse(statusRaw().stdout);
const fileHash = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const snapshotTree = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { out.push(`${p}|L|${st.mtimeMs}|${fs.readlinkSync(p)}`); continue; }
      if (st.isDirectory()) { out.push(`${p}|D|${st.mtimeMs}`); walk(p); continue; }
      out.push(`${p}|F|${st.mtimeMs}|${st.size}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
};

// ── [1] --status-json 的结构与 summary ──────────────────────────────────────
console.log("\n[1] --status-json 结构与 summary");
setup();
{
  const s = status();
  check("enabled=false（未接管）", s.enabled === false, JSON.stringify(s.enabled));
  check("dirs[] 字段齐全（dir/entry/hasEntry/wired/drift）", Array.isArray(s.dirs) && s.dirs.every((d) => typeof d.dir === "string" && typeof d.entry === "string" && typeof d.hasEntry === "boolean" && typeof d.wired === "boolean" && typeof d.drift === "boolean"), JSON.stringify(s.dirs));
  check("未接管：entry=official", s.dirs.length === 1 && s.dirs[0].entry === "official", JSON.stringify(s.dirs));
  check("未接管：summary n=0 k=1", s.summary.n === 0 && s.summary.k === 1, JSON.stringify(s.summary));
  check("vendor 解析到官方目录", s.vendor === VENDOR_LINK, String(s.vendor));
  check("alwaysOn 为空数组", Array.isArray(s.alwaysOn) && s.alwaysOn.length === 0);
  check("generatedHash 是 sha256:...", /^sha256:[0-9a-f]{64}$/.test(s.generatedHash), s.generatedHash);
}

// ── [2] 接管后 summary 变化 + 漂移检测 ──────────────────────────────────────
console.log("\n[2] 接管 / 漂移");
{
  wire();
  let s = status();
  check("接管后 n=1 k=0", s.summary.n === 1 && s.summary.k === 0, JSON.stringify(s.summary));
  check("接管后 entry=wired wired=true", s.dirs[0].entry === "wired" && s.dirs[0].wired === true, JSON.stringify(s.dirs[0]));
  check("enabled=true", s.enabled === true);
  // 官方升级改描述 → 生成物过期 = 漂移
  fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill("When you need a browser. VERSION-TWO.", "2.1.0"));
  s = status();
  check("官方升级 → drift=true k=1", s.dirs[0].drift === true && s.summary.k === 1, JSON.stringify(s.summary));
}

// ── [3] generatedHash 确定性 ────────────────────────────────────────────────
console.log("\n[3] generatedHash 确定性");
{
  const a = statusRaw().stdout;
  const b = statusRaw().stdout;
  check("两次 --status-json 逐字节相同", a === b, "输出不同");
  check("generatedHash 两次相同", JSON.parse(a).generatedHash === JSON.parse(b).generatedHash);
  check("--status-json 退出码 0", statusRaw().status === 0);
}

// ── [4] --check 只读（含 mtime），且幂等 ────────────────────────────────────
console.log("\n[4] --check 只读");
{
  setup();
  wire();
  const before = snapshotTree(root);
  const c = wire("--check");
  check("--check exit 0", c.code === 0, c.out);
  const c2 = wire("--check");
  check("--check 两次输出一致", c.out === c2.out);
  check("--check 没有写任何文件（含 mtime）", snapshotTree(root) === before);
  check("--check 汇总三个数字", /已接管 \d+ \/ 无需接管 \d+ \/ 漂移 \d+/.test(c.out), c.out);
}

// ── [5] --always-on 幂等 + --restore 字节还原 ───────────────────────────────
console.log("\n[5] always-on 幂等与还原");
{
  setup();
  const f = join(root, "AGENTS.md");
  fs.writeFileSync(f, "# my project rules\n\nline two\n");
  const h0 = fileHash(f);
  wire("--always-on", f);
  const h1 = fileHash(f);
  const text1 = fs.readFileSync(f, "utf8");
  wire("--always-on", f);
  check("两次 --always-on 内容逐字节一致（幂等）", fileHash(f) === h1);
  check("块已插入（标记唯一一份）", (text1.match(/ego-decision-layer:route begin/g) || []).length === 1 && (text1.match(/ego-decision-layer:route end/g) || []).length === 1);
  check("块外内容未改（首行仍是原样）", fs.readFileSync(f, "utf8").split("\n")[0] === "# my project rules");
  const s = status();
  check("--status-json 报告 always-on 在位", s.alwaysOn.length === 1 && s.alwaysOn[0] === f, JSON.stringify(s.alwaysOn));
  wire("--restore");
  check("--restore 后字节哈希与初始一致", fileHash(f) === h0, `${fileHash(f)} vs ${h0}`);
  check("--restore 后 .bak 已清理", !fs.existsSync(f + ".bak"));
  const s2 = status();
  check("--restore 后 alwaysOn 为空", s2.alwaysOn.length === 0, JSON.stringify(s2.alwaysOn));
  check("--restore 后已接管数归零", s2.summary.n === 0 && s2.dirs.every((d) => !d.wired), JSON.stringify(s2.summary));
  check("--restore 后入口回到官方软链", fs.lstatSync(ENTRY).isSymbolicLink(), "不是软链");
}

// ── [6] CLI --route-status：JSON、无凭证、无浏览器 ─────────────────────────
console.log("\n[6] CLI --route-status");
{
  setup();
  const r = spawnSync("bash", [CLI, "--route-status"], { env: env(), encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  check("exit 0", (r.status ?? 1) === 0, String(r.status));
  check("输出是 JSON 且有 summary/dirs/alwaysOn", Boolean(parsed) && Boolean(parsed.summary) && Array.isArray(parsed.dirs) && Array.isArray(parsed.alwaysOn), (r.stdout || "").slice(0, 120));
  check("没有凭证也能跑（stderr 不提凭证）", !/凭证|api_key/i.test(r.stderr || ""), (r.stderr || "").slice(0, 120));
}

// ── [7] opt-out 粘性：--restore 之后自动路径不接管；显式 wire 才解除 ────────
console.log("\n[7] opt-out 粘性");
{
  setup();
  wire();
  wire("--restore");
  const s = status();
  check("--status-json optedOut=true", s.optedOut === true, JSON.stringify(s.optedOut));
  check("opt-out 下 summary 无漂移", s.summary.n === 0 && s.summary.k === 0, JSON.stringify(s.summary));
  check("opt-out 下 enabled=false", s.enabled === false);
  const c = wire("--check");
  check("--check exit 0 且含「不接管」", c.code === 0 && c.out.includes("不接管"), c.out);
  const e = wire("--ensure");
  check("--ensure 不接管（入口仍是官方软链）", e.code === 0 && fs.lstatSync(ENTRY).isSymbolicLink() && !fs.existsSync(join(ENTRY, ".ego-jev-overlay.json")), e.out);
  const w = wire();
  check("显式 wire 解除 opt-out 并恢复接管", w.code === 0 && status().optedOut === false && fs.existsSync(join(ENTRY, ".ego-jev-overlay.json")), w.out);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
