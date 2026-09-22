// bench 脚本共用的小工具：定位仓库内路径 + 取凭证 / 文本模型配置。
//
// 为什么需要它：`ego-browser nodejs < file` 的内嵌运行时里
//   * process.cwd() 恒为 "/"
//   * import.meta.url 是 "file:////[eval2]"（不是真实文件路径）
//   * 自定义环境变量不传入（只有 HOME/PATH/TMPDIR/USER/SHELL 等少数几个）
// 所以脚本无法自定位。各脚本先用 __REPO__ 占位符或已安装技能定位仓库根，再按**绝对路径**
// import 本文件；本文件因此总是以真实文件路径被加载，可以放心用 import.meta.url 自定位。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(BENCH);
export const JE = join(ROOT, "scripts", "ego-jev.mjs");
export const RAW = join(BENCH, "raw");

// 走「已安装技能」那条兜底路径时提示一声，避免误以为在测当前工作树
if (BENCH.includes("/.agents/skills/")) {
  console.log(`[bench] 仓库根取自已安装技能：${ROOT}（要测当前工作树请用 sed 注入 __REPO__，见脚本头部注释）`);
}

/**
 * Jev 凭证：用引擎自己的解析链（TYPESAFE_API_KEY → ~/.config/typesafe/api_key）。
 * 以前这里读的是本机的一个备份文件路径（别人克隆后必然失败）。
 */
export async function loadBenchApiKey() {
  const { loadApiKey } = await import(JE);
  const key = loadApiKey();
  if (!key) {
    throw new Error(
      "未找到 Jev 凭证：把 API Key 写到 ~/.config/typesafe/api_key（见 SKILL.md），或设 TYPESAFE_API_KEY。"
    );
  }
  return key;
}

/**
 * 文本模型配置（只有需要生成输入文本的基准才用）。
 * 优先级：EGO_JEV_ENV_FILE=<.env 路径>（含 TEXT_MODEL_BASE_URL / TEXT_MODEL / TEXT_MODEL_API_KEY）
 *        → 引擎自己的 ~/.config/typesafe/text_model.json。
 * 都没有就明确报错——原来写死了另一个仓库的绝对路径，既不通用也不该公开。
 */
export async function loadBenchTextModel() {
  const envFile = process.env.EGO_JEV_ENV_FILE;
  if (envFile) {
    if (!existsSync(envFile)) throw new Error(`EGO_JEV_ENV_FILE 指向的文件不存在：${envFile}`);
    const env = Object.fromEntries(
      (await readFile(envFile, "utf8"))
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i), l.slice(i + 1).trim()];
        })
    );
    if (!env.TEXT_MODEL_BASE_URL || !env.TEXT_MODEL || !env.TEXT_MODEL_API_KEY) {
      throw new Error(`EGO_JEV_ENV_FILE=${envFile} 缺少 TEXT_MODEL_BASE_URL / TEXT_MODEL / TEXT_MODEL_API_KEY`);
    }
    return { baseUrl: env.TEXT_MODEL_BASE_URL, model: env.TEXT_MODEL, apiKey: env.TEXT_MODEL_API_KEY };
  }
  const { loadTextModelConfig, resolveTextApiKey } = await import(JE);
  const cfg = loadTextModelConfig();
  if (!cfg) {
    throw new Error(
      "缺少文本模型配置：设 EGO_JEV_ENV_FILE=<.env 路径>（含 TEXT_MODEL_BASE_URL / TEXT_MODEL / TEXT_MODEL_API_KEY），" +
        "或配置 ~/.config/typesafe/text_model.json（见 SKILL.md）。"
    );
  }
  return { ...cfg, apiKey: resolveTextApiKey(cfg) };
}
