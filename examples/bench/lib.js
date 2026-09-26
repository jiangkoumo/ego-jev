// 共享工具。
//
// 重要：ego 内嵌运行时只继承最小化登录环境（HOME/PATH 等），**自定义环境变量不会传进去**，
// 且 process.cwd() 是 "/"。所以配置不能靠环境变量，必须由 run-pair.sh 替换进脚本正文。
const { existsSync } = await import("node:fs");
const { resolve } = await import("node:path");
const { readFileSync } = await import("node:fs");

export function resolveLib(benchDir) {
  const found = [`${benchDir}/../..`, `${benchDir}/../../..`]
    .flatMap((dir) => [resolve(dir, "scripts/decider-loop.mjs"), resolve(dir, "decider-loop.mjs")])
    .find(existsSync);
  if (!found) throw new Error(`找不到 decider-loop.mjs（benchDir=${benchDir}）`);
  return found;
}

export function gateway(config) {
  let apiKey = config.apiKey;
  if (!apiKey) {
    let node = JSON.parse(readFileSync(config.authFile, "utf8"));
    for (const seg of config.authPath.split(".")) node = node?.[seg];
    apiKey = typeof node === "string" ? node : undefined;
  }
  if (!apiKey) throw new Error(`缺少网关凭证：检查 ${config.authFile} 的 ${config.authPath}`);
  return {
    baseUrl: config.baseUrl,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "ego-decision-layer-bench/1.0",
      "x-opencode-session": "ego-decision-layer-bench",
      "x-opencode-client": "ego-decision-layer",
    },
  };
}
