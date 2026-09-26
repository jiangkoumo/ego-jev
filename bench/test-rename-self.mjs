// scripts/rename-self.sh 的单元测试：用临时 HOME + 假官方软链造出「旧名残留」，
// 验证 --dry-run 不写盘、真跑后新软链/新配置目录到位、旧名消失、--check exit 0，且再跑一次是 no-op。
// 纯 node、无浏览器、无凭证、无网络。用法: node bench/test-rename-self.mjs
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENAME = join(REPO, "scripts", "rename-self.sh");
const WIRE = join(REPO, "scripts", "wire-agent-skills.sh");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const root = fs.mkdtempSync(join(os.tmpdir(), "ego-decision-layer-rename-"));
const HOME = join(root, "home");
const VENDOR = join(root, "vendor");
const SKILLS = join(HOME, ".agents", "skills");
const OLD_CFG = join(HOME, ".config", "ego-jev");
const NEW_CFG = join(HOME, ".config", "ego-decision-layer");
const BINDIR = join(root, "bin");
const AO = join(HOME, "AGENTS.md");
const OLD_AO_BLOCK = "<!-- ego-jev:route begin -->\n## old route\n\n旧路由块\n<!-- ego-jev:route end -->\n";

const setup = () => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of [HOME, VENDOR, join(VENDOR, "references"), SKILLS, OLD_CFG, BINDIR]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(join(VENDOR, "SKILL.md"), `---\nname: ego-browser\ndescription: When you need a browser, read this Skill by default.\nmetadata:\n  version: "2.0.0"\n  date: "2026-09-09"\n---\n\n官方正文。\n`);
  fs.writeFileSync(join(VENDOR, "references", "api.md"), "# api\n");
  // 官方入口（可被接管）+ 旧名技能软链（迁移对象）
  fs.symlinkSync(VENDOR, join(SKILLS, "ego-browser"), "dir");
  fs.symlinkSync(REPO, join(SKILLS, "ego-jev"), "dir");
  // 旧接管状态：启用标记 + always-on 清单 + 带旧块的常驻文件
  fs.writeFileSync(join(OLD_CFG, "wire-enabled.json"), `{\n  "enabled": true,\n  "dirs": ["${SKILLS}"]\n}\n`);
  fs.writeFileSync(join(OLD_CFG, "always-on.list"), `${AO}\n`);
  fs.writeFileSync(AO, `# 用户自己的规则\n\n${OLD_AO_BLOCK}\n用户内容\n`);
};

const baseEnv = () => ({
  ...process.env, HOME, PATH: `${dirname(process.execPath)}:${BINDIR}:/usr/bin:/bin`,
  BINDIR, EGO_JEV_VENDOR: VENDOR, EGO_JEV_SKILLS_DIRS: SKILLS,
  TYPESAFE_API_KEY: "", TYPESAFE_API_KEY_FILE: join(root, "nope", "key"), EGO_JEV_NO_WIRE: "",
});
const runRename = (...args) => {
  const r = spawnSync("bash", [RENAME, ...args], { env: baseEnv(), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const runWire = (...args) => {
  const r = spawnSync("bash", [WIRE, ...args], { env: baseEnv(), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
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
const isSymlinkTo = (p, target) => { try { return fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === target; } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// ── [1] --dry-run 不写任何文件 ───────────────────────────────────────────────
console.log("\n[1] --dry-run 只打印");
setup();
{
  const before = snapshotTree(root);
  const r = runRename("--dry-run");
  check("--dry-run 退出 0", r.code === 0, r.out);
  check("--dry-run 打印了计划（含 restore / mv / --always-on）", /--restore/.test(r.out) && /mv /.test(r.out) && /--always-on/.test(r.out), r.out.slice(0, 200));
  check("--dry-run 没有写任何文件（含 mtime）", snapshotTree(root) === before);
  check("旧状态原样（旧技能软链还在、旧配置目录还在）", isSymlinkTo(join(SKILLS, "ego-jev"), REPO) && exists(OLD_CFG) && !exists(NEW_CFG));
}

// ── [2] 真跑一次：旧→新 ─────────────────────────────────────────────────────
console.log("\n[2] 真跑一次迁移");
{
  const r = runRename();
  check("rename-self 退出 0", r.code === 0, r.out.slice(-400));
  check("旧技能软链已删、新技能软链指向同一仓库", !exists(join(SKILLS, "ego-jev")) && isSymlinkTo(join(SKILLS, "ego-decision-layer"), REPO));
  check("配置目录已迁移（旧没了、新在）", !exists(OLD_CFG) && exists(NEW_CFG));
  check("新配置目录里有启用标记", exists(join(NEW_CFG, "wire-enabled.json")));
  check("PATH 入口：新 CLI + 历史垫片都在", isSymlinkTo(join(BINDIR, "ego-decision-layer"), join(REPO, "scripts", "ego-decision-layer")) && isSymlinkTo(join(BINDIR, "ego-jev"), join(REPO, "scripts", "ego-jev")));
  check("官方入口被新名接管", exists(join(SKILLS, "ego-browser", ".ego-jev-overlay.json")));
}

// ── [3] always-on 用新标记重插，旧标记没了；--check exit 0 ────────────────────
console.log("\n[3] always-on 重插 + --check");
{
  const ao = fs.readFileSync(AO, "utf8");
  check("always-on 块用新标记", ao.includes("<!-- ego-decision-layer:route begin -->") && ao.includes("<!-- ego-decision-layer:route end -->"));
  check("旧标记块已消失", !ao.includes("<!-- ego-jev:route begin -->"));
  check("块外用户内容保留", ao.includes("# 用户自己的规则") && ao.includes("用户内容"));
  check("always-on 清单仍是同一批文件", fs.readFileSync(join(NEW_CFG, "always-on.list"), "utf8").includes(AO));
  const c = runWire("--check");
  check("--check exit 0", c.code === 0, c.out.slice(-300));
  check("--check 汇总行用新名", /ego-decision-layer/.test(c.out) && /路由: 已接管 \d+/.test(c.out), c.out.slice(-200));
  const s = runWire("--status-json");
  check("--route-status（新 CLI 同款 JSON）alwaysOn 指回文件", s.out.includes(AO), s.out.slice(0, 160));
}

// ── [4] 幂等：再跑一次是 no-op ───────────────────────────────────────────────
console.log("\n[4] 幂等");
{
  const before = snapshotTree(root);
  const r = runRename();
  check("第二次 rename-self 退出 0", r.code === 0, r.out.slice(-200));
  const after = snapshotTree(root);
  if (after !== before) {
    const b = new Set(before.split("\n"));
    const a = new Set(after.split("\n"));
    const added = [...a].filter((x) => !b.has(x)).slice(0, 4);
    const removed = [...b].filter((x) => !a.has(x)).slice(0, 4);
    console.log("    新增: " + added.join(" | "));
    console.log("    变化: " + removed.join(" | "));
  }
  check("第二次没有任何写入（含 mtime）", after === before);
}

// ── [5] 历史入口垫片仍可用 ───────────────────────────────────────────────────
console.log("\n[5] 历史垫片");
{
  const r = spawnSync("bash", [join(REPO, "scripts", "ego-jev"), "--route-status"], { env: baseEnv(), encoding: "utf8" });
  check("垫片退出 0", (r.status ?? 1) === 0, String(r.status));
  check("垫片打印改名提示", /已改名为 ego-decision-layer/.test(r.stderr || ""), (r.stderr || "").slice(0, 120));
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  check("垫片转发到新 CLI（stdout 是路由 JSON）", Boolean(parsed) && Array.isArray(parsed.dirs), (r.stdout || "").slice(0, 120));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
