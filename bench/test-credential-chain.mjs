// P2-6 验收（单元层）：凭证查找链的解析与优先级。
//
// 为什么需要：ego 运行时拿不到自定义环境变量，凭证只能来自文件；但用户往往已经在 shell rc 里
// export 过 key。这条链要把「我们自己的配置文件 / 既有 api_key / rc 里的同名 export」都认出来，
// 同时不能把 rc 里别人的赋值行误当凭证。
//
// 用法: node bench/test-credential-chain.mjs（无需浏览器、无需网络、不碰真实 HOME）
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const JE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "decider-loop.mjs");
const dir = mkdtempSync(join(tmpdir(), "ego-decision-layer-cred-"));
const w = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// 优先级最高的是 TYPESAFE_API_KEY_FILE，在 import 前设好（模块加载时构建查找链）
const explicit = w("explicit.env", "export TYPESAFE_API_KEY=from-explicit-file\n");
process.env.TYPESAFE_API_KEY_FILE = explicit;
delete process.env.TYPESAFE_API_KEY; // 避免真实环境变量干扰

const { loadApiKey, readCredential } = await import(JE);

console.log("\n[1] readCredential 解析各种形态");
check("export NAME=value", readCredential(w("a", "export TYPESAFE_API_KEY=abc123\n"), false) === "abc123", "");
check("NAME=value", readCredential(w("b", "TYPESAFE_API_KEY=def456\n"), false) === "def456", "");
check("带引号", readCredential(w("c", 'export TYPESAFE_API_KEY="ghi789"\n'), false) === "ghi789", "");
check("rc 里夹在别的赋值之间", readCredential(w("d", "export PATH=/x\nexport TYPESAFE_API_KEY=mid\nFOO=bar\n"), false) === "mid", "");
check("裸 key（allowBare）", readCredential(w("e", "barekey_xyz\n"), true) === "barekey_xyz", "");
check("裸 key 不被误当（allowBare=false）", readCredential(w("f", "barekey_xyz\n"), false) === undefined, "");
check("首行是别人的赋值 → 不当裸 key", readCredential(w("g", "FOO=bar\n"), true) === undefined, "");
check("文件不存在 → undefined", readCredential(join(dir, "nope"), true) === undefined, "");
check("文件为空 → undefined", readCredential(w("h", "\n\n"), true) === undefined, "");

console.log("\n[2] loadApiKey 优先级");
check("options.apiKey 最高", loadApiKey({ apiKey: "override" }) === "override", "");
check("TYPESAFE_API_KEY_FILE 生效", loadApiKey() === "from-explicit-file", String(loadApiKey()));

console.log("\n[3] 只认 TYPESAFE_API_KEY，不误取同名以外的 export");
check("只写别的变量 → undefined", readCredential(w("i", "export OPENAI_API_KEY=zzz\n"), true) === undefined, "");

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
