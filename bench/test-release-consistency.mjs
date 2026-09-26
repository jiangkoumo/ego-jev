// 发布一致性：版本号只有一个来源（SKILL.md 的 metadata.version），其余元数据必须与它一致；
// 技能软链必须可解析；README 必须引用已生成的素材；仓库里不许混进外部仓库名。
// 纯 node，无需浏览器 / 网络 / 凭证。用法: node bench/test-release-consistency.mjs
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const { dirname, join, relative } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKILL = join(REPO, "SKILL.md");
const README = join(REPO, "README.md");
const CHANGELOG = join(REPO, "CHANGELOG.md");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ── [1] SKILL.md frontmatter 的 metadata.version ────────────────────────────
console.log("\n[1] SKILL.md frontmatter 版本");
const skillText = fs.readFileSync(SKILL, "utf8");
const fm = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
const version = fm ? (fm[1].match(/^\s*version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\s*$/m) || [])[1] : null;
check("frontmatter 可解析且 metadata.version 存在", Boolean(version), JSON.stringify(version));
check("版本是 semver", /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version || ""), String(version));

// ── [2] plugin.json / marketplace.json 与它完全一致 ─────────────────────────
console.log("\n[2] 插件元数据版本一致");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const plugin = readJson(join(REPO, ".claude-plugin", "plugin.json"));
const market = readJson(join(REPO, ".claude-plugin", "marketplace.json"));
check(".claude-plugin/plugin.json version 一致", plugin.version === version, JSON.stringify(plugin.version));
check(".claude-plugin/marketplace.json version 一致", market.version === version, JSON.stringify(market.version));
check("plugin.json 的 name 合法（kebab-case）", /^[a-z0-9]+(-[a-z0-9]+)*$/.test(plugin.name || ""), String(plugin.name));
check("marketplace.json 的 plugins 条目带 name+source", Array.isArray(market.plugins) && market.plugins.length > 0 && market.plugins.every((p) => p.name && p.source), JSON.stringify(market.plugins));

// ── [3] CHANGELOG 顶部条目版本一致 ──────────────────────────────────────────
console.log("\n[3] CHANGELOG 顶部条目");
const changelog = fs.readFileSync(CHANGELOG, "utf8");
const top = (changelog.match(/^##\s+([0-9]+\.[0-9]+\.[0-9]+)\s+—/m) || [])[1];
check("CHANGELOG 第一个版本小节存在", Boolean(top), JSON.stringify(top));
check("CHANGELOG 顶部版本一致", top === version, `${top} vs ${version}`);

// ── [4] skills/ego-jev/SKILL.md 软链可解析且指向仓库根 ──────────────────────
console.log("\n[4] 插件技能软链");
const linkPath = join(REPO, "skills", "ego-jev", "SKILL.md");
let isLink = false;
try { isLink = fs.lstatSync(linkPath).isSymbolicLink(); } catch { isLink = false; }
check("skills/ego-jev/SKILL.md 是软链", isLink, linkPath);
let resolved = null;
try { resolved = fs.realpathSync(linkPath); } catch { resolved = null; }
check("软链指向仓库根的 SKILL.md", resolved === fs.realpathSync(SKILL), String(resolved));
// scripts / overlay 也应是软链（插件加载器下技能要能拿到引擎）
for (const sub of ["scripts", "overlay"]) {
  const p = join(REPO, "skills", "ego-jev", sub);
  let ok = false;
  try { ok = fs.lstatSync(p).isSymbolicLink() && fs.existsSync(p); } catch { ok = false; }
  check(`skills/ego-jev/${sub} 是可解析的软链`, ok, p);
}

// ── [5] README 引用已生成的素材 ─────────────────────────────────────────────
console.log("\n[5] README 素材引用");
const readme = fs.readFileSync(README, "utf8");
for (const asset of ["docs/banner.svg", "docs/demo.gif"]) {
  if (fs.existsSync(join(REPO, asset))) check(`README 引用 ${asset}`, readme.includes(asset), asset);
  else console.log(`  skip ${asset} 尚未生成`);
}

// ── [6] 仓库里不许混进外部仓库名 ────────────────────────────────────────────
// 沿用 no-bh 的检查手法：拆开写模式、只查代码行（纯注释行允许解释历史）。
console.log("\n[6] 外部仓库名扫描");
{
  const EXT_REPO = [new RegExp("browser" + "[-_]harness", "i")];
  const ALLOWED_ORGS = new Set(["citrolabs", "browser-use", "jiangkoumo"]);
  const GH = /github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)/gi;
  const isCommentOnly = (line) => /^\s*(#|\/\/|\*|\/\*)/.test(line);
  const SKIP = new Set(["node_modules", ".git", "raw", "__pycache__", ".contrib", ".agent-tape", "demo-frames"]);
  const CODE = new Set([".sh", ".mjs", ".js", ".py"]);
  const DOC = new Set([".md"]);
  // 本文件与同目录的 no-bh 不变量测试都必须在源码里写下被禁的名字，跳过它们
  const SKIP_FILES = new Set([SELF, join(REPO, "bench", "test-no-bh-dependency.mjs")]);

  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); continue; }
      if (SKIP_FILES.has(p)) continue;
      const dot = e.name.lastIndexOf(".");
      const ext = dot < 0 ? "" : e.name.slice(dot);
      if (!CODE.has(ext) && !DOC.has(ext)) continue;
      const isCode = CODE.has(ext);
      fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (isCode) {
          if (isCommentOnly(line)) return; // 代码只看真调用行（纯注释允许解释历史）
          // 代码行：连裸的外部仓库名（browser-harness 家族）都不许出现
          if (EXT_REPO.some((re) => re.test(line))) hits.push(`${relative(REPO, p)}:${i + 1} (external repo)`);
        } else {
          // 文档：只查 github.com/<org>/<repo> URL 形式；裸名属于历史叙述（既有报告在讲 B 臂）
          for (const m of line.matchAll(GH)) {
            if (!ALLOWED_ORGS.has(m[1].toLowerCase())) hits.push(`${relative(REPO, p)}:${i + 1} (github.com/${m[1]}/${m[2]})`);
          }
        }
      });
    }
  };
  walk(REPO);
  check("代码行没有外部仓库名、文档里的 github URL 仅限已登记上游", hits.length === 0, hits.slice(0, 8).join(", "));
}

// ── [7] 与最新 tag 的一致性：打 tag 前必然不一致，只作为警告行 ──────────────
console.log("\n[7] 最新 tag（警告，不参与判定）");
{
  const r = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: REPO, encoding: "utf8" });
  const tag = (r.stdout || "").trim();
  const tagVersion = tag.replace(/^v/, "");
  if (tag && tagVersion === version) console.log(`  ok   版本与最新 tag 一致（${tag}）`);
  else console.log(`  警告 版本 ${version} 尚无对应 tag（最新 tag：${tag || "无"}）——打 tag 后本行会变成 ok`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
