// P2-6 验收（后端层）：主后端失败时的可关闭降级路径。
//
// 为什么需要：今天真实遇到过约 5 分钟的 403 RBAC——环境本身会变。后端地址保持可配置，
// 并给主后端失败一条可关闭的降级路径（默认关闭：不配 TYPESAFE_FALLBACK_BASE_URL 就只有一个端点）。
//
// 用法: node bench/test-backend-fallback.mjs（无需浏览器、无需网络）
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 在 import 前设好：端点常量在模块加载时构建
process.env.TYPESAFE_BASE_URL = "https://primary.example/v1";
process.env.TYPESAFE_FALLBACK_BASE_URL = "https://fallback.example/v1";
const JE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "decider-loop.mjs");
const { askJev } = await import(JE);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const questions = { operation: { criteria: { a: "A", b: "B" } } };
const realFetch = globalThis.fetch;

console.log("\n[1] 主后端 503 → 自动降级到 fallback");
{
  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(url);
    if (url.startsWith("https://primary.example")) return { ok: false, status: 503, async text() { return "down"; } };
    return { ok: true, async json() { return { model: "fb-model", answers: { operation: { choice: "a" } }, usage: { input_tokens: 1 } }; } };
  };
  const receipt = {};
  const answers = await askJev("state", questions, { apiKey: "k", receipt });
  check("两个端点都试了，且顺序是 主→备", tried.length === 2 && tried[0].startsWith("https://primary.example") && tried[1].startsWith("https://fallback.example"), JSON.stringify(tried));
  check("返回的是 fallback 的答案", answers.operation.choice === "a", JSON.stringify(answers));
  check("receipt 记录实际服务的端点", receipt.endpoint === "https://fallback.example/v1", String(receipt.endpoint));
  check("receipt 记录 fallback 的模型", receipt.model === "fb-model", String(receipt.model));
}

console.log("\n[2] fallback:false → 只试主后端，失败就抛");
{
  const tried = [];
  globalThis.fetch = async (url) => { tried.push(url); return { ok: false, status: 503, async text() { return "down"; } }; };
  let threw = false;
  try { await askJev("state", questions, { apiKey: "k", fallback: false }); } catch { threw = true; }
  check("只试了主后端", tried.length === 1 && tried[0].startsWith("https://primary.example"), JSON.stringify(tried));
  check("最终抛出错误（不静默）", threw === true, "");
}

console.log("\n[3] options 覆盖端点");
{
  const tried = [];
  globalThis.fetch = async (url) => { tried.push(url); return { ok: true, async json() { return { model: "x", answers: { operation: { choice: "b" } }, usage: {} }; } }; };
  await askJev("state", questions, { apiKey: "k", baseUrl: "https://override.example/v2", fallbackBaseUrl: "" });
  check("options.baseUrl 覆盖生效（且 fallback 为空时不追加）", tried.length === 1 && tried[0] === "https://override.example/v2/systemone", JSON.stringify(tried));
}

globalThis.fetch = realFetch;
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
