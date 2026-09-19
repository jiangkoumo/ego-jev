// ego-jev.mjs — a Jev (TypeSafe System One) driver for the ego lite browser
// 全局通用 Jev + ego-browser 极速驱动引擎
//
// 重要：`ego-browser nodejs` 内嵌运行时只继承最小化登录环境（HOME/PATH/...），
// 父进程的 export 变量（含 TYPESAFE_API_KEY）不会传入。
// 因此凭证必须来自文件：~/.config/typesafe/api_key（或 TYPESAFE_API_KEY_FILE）。
//
// 架构（借鉴 browser-use/jev-ultrafast 的 dynamic operation + target）：
//   - 每次观测产出「索引化元素表」，每个元素一个 ref，并携带当前值/勾选态/下拉选项
//   - 一次 TypeSafe 请求同时问 operation 与各操作的 target（推测性问题，互不可见）
//   - 每个 target 头只列出与它兼容的元素，操作与目标不匹配天然被排除
//   - executor 只消费与选中 operation 对应的那个 target 头
//   - DONE / BLOCKED 是 operation 之一，不再用额外的 noul 阈值判断
//   - 原生下拉的选项索引由代码提供（ref=6#2），模型只做选择
//   - 代码负责观测、执行、陈旧校验、退出条件与收尾；模型只做判断

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BASE_URL = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1";
const CREDENTIAL_FILES = [
  process.env.TYPESAFE_API_KEY_FILE,
  join(homedir(), ".config", "typesafe", "api_key"),
].filter(Boolean);
const TEXT_MODEL_FILE =
  process.env.TYPESAFE_TEXT_MODEL_FILE || join(homedir(), ".config", "typesafe", "text_model.json");

/** 解析凭证：参数 > 环境变量 > 凭证文件 */
export function loadApiKey(options = {}) {
  if (options.apiKey) return options.apiKey;
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  for (const file of CREDENTIAL_FILES) {
    try {
      if (!existsSync(file)) continue;
      const line = readFileSync(file, "utf8").trim().split(/\r?\n/)[0].trim();
      if (!line) continue;
      const value = line.replace(/^TYPESAFE_API_KEY\s*=\s*/, "").replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      /* 凭证文件不可读时继续尝试下一个来源 */
    }
  }
  return undefined;
}

/** 极简零依赖调用 Jev System One 决策接口 */
export async function askJev(state, questions, options = {}) {
  const key = loadApiKey(options);
  if (!key) {
    throw new Error(
      "未检测到 Jev API 凭证。请写入 " +
        join(homedir(), ".config", "typesafe", "api_key") +
        "（内容为 API Key 一行），或通过 options.apiKey 传入。"
    );
  }
  const endpoint = `${(options.baseUrl || BASE_URL).replace(/\/+$/, "")}/systemone`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model || "jev-latest",
      state: typeof state === "string" ? state : JSON.stringify(state),
      questions,
    }),
  });
  if (!res.ok) {
    throw new Error(`Jev API Error (${res.status}): ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  return data.answers;
}

// ── 文本生成助手（可选，OpenAI 兼容端点）─────────────────────────────────────
// 与 jev-ultrafast 一致：Jev 只做选择，需要生成文本时才调用小 LLM，且只接受恰好一个
// 合法 text 字段的 JSON；代码不去抽取引号字面量。未配置时该能力关闭（type_text 不提供）。

/** 读取文本模型配置；未配置返回 null */
export function loadTextModelConfig() {
  try {
    if (!existsSync(TEXT_MODEL_FILE)) return null;
    const cfg = JSON.parse(readFileSync(TEXT_MODEL_FILE, "utf8"));
    if (!cfg?.baseUrl || !cfg?.model) return null;
    if (!cfg.apiKey && !cfg.apiKeyJson) return null;
    return cfg;
  } catch {
    return null;
  }
}

const expandHome = (p) => String(p || "").replace(/^~(?=\/|$)/, homedir());

/**
 * 解析文本模型密钥，优先直接给值；也支持从已有配置文件按路径取（避免复制密钥）。
 * apiKeyJson: { "file": "~/.pi/agent/auth.json", "path": "opencode-go.key" }
 */
export function resolveTextApiKey(cfg) {
  if (cfg?.apiKey) return cfg.apiKey;
  const ref = cfg?.apiKeyJson;
  if (!ref?.file || !ref?.path) return null;
  try {
    let node = JSON.parse(readFileSync(resolve(expandHome(ref.file)), "utf8"));
    for (const segment of String(ref.path).split(".")) {
      if (node == null) return null;
      node = node[segment];
    }
    return typeof node === "string" && node ? node : null;
  } catch {
    return null;
  }
}

/**
 * 让文本模型生成一个填入值。
 * 严格校验：响应必须是 JSON，且恰好包含一个非空字符串 text 字段。
 * 任何不满足的情况都返回 null（调用方据此报错，而不是猜一个值）。
 */
export async function generateText(input, options = {}) {
  const cfg = options.textModel || loadTextModelConfig();
  if (!cfg || typeof cfg !== "object") return null;
  const apiKey = resolveTextApiKey(cfg);
  if (!apiKey) return null;

  const { goal, field, elementTable, recentActions } = input;
  const body = {
    model: cfg.model,
    messages: [
      {
        role: "system",
        content:
          "You output JSON only. Return exactly one field: {\"text\": \"...\"}. " +
          "No explanation, no markdown, no extra fields.",
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          `Field to fill: ${field}`,
          "Page elements (ref | role | name | value):",
          elementTable,
          recentActions?.length ? `Recent actions:\n${recentActions.join("\n")}` : "",
          "Return the single text value to type into that field.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    temperature: 0,
  };
  if (cfg.reasoning === false) body.reasoning = { enabled: false };
  if (cfg.jsonMode !== false) body.response_format = { type: "json_object" };

  let payload;
  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": cfg.userAgent || "ego-jev/1.0",
      ...(cfg.headers || {}),
    };
    // 部分网关（如 opencode-go）要求稳定的会话 id，用于路由与提示缓存
    if (cfg.sessionHeader) headers[cfg.sessionHeader] = cfg.sessionId || "ego-jev";

    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.textTimeoutMs ?? cfg.timeoutMs ?? 15_000),
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?|```$/g, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "text") return null;
  const text = parsed.text;
  if (typeof text !== "string" || !text.trim()) return null;
  return text.trim();
}

// ── 元素表 ───────────────────────────────────────────────────────────────────
// 可直接输入文本的角色（复选框/单选/按钮不在此列，避免被误判为可编辑）
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "textarea", "spinbutton"]);
const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch"]);
const MAX_OPTIONS_PER_SELECT = 30;

/** 只保留路径，压缩 token 且保留语义（/newcomments 比完整 URL 更有区分度） */
const shortPath = (url) => {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return (parsed.pathname + parsed.search).slice(0, 48);
  } catch {
    return String(url).slice(0, 48);
  }
};

const indentOf = (line) => line.match(/^\s*/)[0].length;

/**
 * 判断元素类型。
 * ego 快照里原生 <select> 也报 combobox，靠 loc=css:select[...] 区分：
 * 原生下拉归为 selectable，ARIA 输入型 combobox 归为 editable。
 */
function classifyRole(role, loc) {
  if (EDITABLE_ROLES.has(role)) return "editable";
  if (CHECKABLE_ROLES.has(role)) return "checkable";
  if (role === "combobox") return /(?:^|:)select\b/i.test(loc || "") ? "selectable" : "editable";
  return "clickable";
}

/** 从 ego-browser snapshot 文本解析「索引化元素表」：ref / 角色 / 名称 / 当前值 / 链接 */
export function parseActionTargets(snapshotText, { limit = 40 } = {}) {
  const targets = [];
  if (!snapshotText) return targets;
  const lines = String(snapshotText).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 属性用「第一个 [ 到最后一个 ]」界定：loc 里的 CSS 选择器常含 ]（如 input[name="a"]），
    // 用首个 ] 收尾会把 loc 截断并使 url 整个丢失
    const open = line.indexOf("[");
    const close = line.lastIndexOf("]");
    if (open < 0 || close <= open) continue;
    const attrs = line.slice(open + 1, close);
    const refMatch = attrs.match(/(?:^|,\s*)ref=(\d+)/);
    if (!refMatch) continue;

    // 形如：  textbox "Query Field" [ref=2, loc=css:input[name="q"], url=...]
    const head = line.slice(0, open).trim();
    const role = head.split(/\s+/)[0] || "element";
    const sameLineName = head.replace(/^\S+\s*/, "").match(/^"((?:[^"\\]|\\.)*)"/);
    const loc = (attrs.match(/(?:^|,\s*)loc=([\s\S]*?)(?=,\s*[a-zA-Z_]+=|$)/) || [])[1] || "";
    const url = (attrs.match(/(?:^|,\s*)url=([\s\S]*?)(?=,\s*[a-zA-Z_]+=|$)/) || [])[1] || "";

    // 收集子节点里的 text 行
    const base = indentOf(line);
    const childTexts = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (indentOf(lines[j]) <= base) break;
      for (const raw of lines[j].match(/text\s+"((?:[^"\\]|\\.)*)"/g) || []) {
        childTexts.push(raw.slice(6, -1));
      }
      if (childTexts.join(" ").length > 80) break;
    }

    // 同行有名称时，子文本是「当前值」（输入框内容、已选项）；
    // 同行无名称时，子文本才是「名称」（按钮文字等）。
    const name = sameLineName ? sameLineName[1] : childTexts.join(" ").trim();
    const value = sameLineName ? childTexts.join(" ").trim() : "";

    targets.push({
      ref: `ref=${refMatch[1]}`,
      role,
      kind: classifyRole(role, loc),
      name: name.slice(0, 60),
      value: value.slice(0, 60),
      loc,
      url,
    });
  }

  // 去重 + 有名称的元素优先（Jev 的选择准确率显著依赖名称）
  const seen = new Set();
  const unique = [];
  for (const t of targets) {
    if (seen.has(t.ref)) continue;
    seen.add(t.ref);
    unique.push(t);
  }
  unique.sort((a, b) => (b.name ? 1 : 0) - (a.name ? 1 : 0));
  return unique.slice(0, limit);
}

/**
 * 补齐快照不暴露的实时状态：下拉的完整选项表、复选框/单选的勾选态、输入框真实值。
 * 只对带 loc=css:... 的元素做，且合并成「一次」页面调用（对齐 jev-ultrafast
 * “one browser call reads common HTML/ARIA controls”）。
 */
export async function enrichTargets(page, targets, options = {}) {
  const wanted = targets
    .filter((t) => /^css:/.test(t.loc || ""))
    .slice(0, options.maxEnrich ?? 60)
    .map((t) => ({ ref: t.ref, selector: t.loc.slice(4) }))
    .filter((t) => t.selector);
  if (!wanted.length) return targets;

  let state = {};
  try {
    bump(options.metrics, "page.evaluate");
    state = await page.evaluate((list) => {
      const out = {};
      for (const item of list) {
        let el = null;
        try {
          el = document.querySelector(item.selector);
        } catch {
          el = null;
        }
        if (!el) continue;
        const entry = {};
        if (el.tagName === "SELECT") {
          entry.options = [...el.options].map((o) => (o.textContent || "").trim().slice(0, 40));
          entry.selectedIndex = el.selectedIndex;
        }
        if (typeof el.checked === "boolean") entry.checked = el.checked;
        if (typeof el.value === "string") entry.liveValue = el.value.slice(0, 60);
        out[item.ref] = entry;
      }
      return out;
    }, wanted);
  } catch {
    return targets; // 补齐失败就按快照原样继续，不影响主流程
  }

  let merged = targets.map((t) => (state[t.ref] ? { ...t, ...state[t.ref] } : t));

  // 兜底：部分站点的勾选控件在快照里既无 loc 也无名称（如 httpbin 的 <label><input></label>），
  // 只能按「文档顺序」对齐补齐勾选态与标签文本。仅当数量完全一致时才敢用，
  // 且只填未知项，不覆盖上面按 loc 拿到的精确值。
  const checkables = merged.filter((t) => t.kind === "checkable");
  if (checkables.length && checkables.some((t) => typeof t.checked !== "boolean" || !t.name)) {
    try {
      bump(options.metrics, "page.evaluate");
      const dom = await page.evaluate(() => {
        const list = [
          ...document.querySelectorAll(
            'input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch]'
          ),
        ];
        return list.map((el) => ({
          checked:
            typeof el.checked === "boolean" ? el.checked : el.getAttribute("aria-checked") === "true",
          label: (
            el.closest("label")?.textContent ||
            el.getAttribute("aria-label") ||
            el.getAttribute("name") ||
            el.value ||
            ""
          )
            .trim()
            .slice(0, 40),
        }));
      });
      if (Array.isArray(dom) && dom.length === checkables.length) {
        const byRef = new Map(checkables.map((t, index) => [t.ref, dom[index]]));
        merged = merged.map((t) => {
          const hit = byRef.get(t.ref);
          if (!hit) return t;
          return {
            ...t,
            checked: typeof t.checked === "boolean" ? t.checked : hit.checked,
            name: t.name || hit.label,
          };
        });
      }
    } catch {
      /* 兜底失败不改动已有结果 */
    }
  }

  return merged;
}

/** 兼容旧接口：返回可直接传给 page.click() 的 ref 列表 */
export function extractCandidateRefs(snapshotText, options = {}) {
  const refs = parseActionTargets(snapshotText, options).map((t) => t.ref);
  refs.push("none");
  return refs;
}

/** 勾选态文案：不知道就说不知道，绝不能默认成“未勾选” */
const checkedLabel = (checked) =>
  typeof checked === "boolean" ? (checked ? "已勾选" : "未勾选") : "勾选态未知";

/** 渲染成紧凑的「元素表」文本，供 Jev 决策（替代整页快照） */
export function buildActionMenu(targets) {
  return targets
    .map((t) => {
      const label = t.name ? `"${t.name}"` : "";
      const path = shortPath(t.url);
      if (t.kind === "checkable") return [t.ref, t.role, label, checkedLabel(t.checked)].filter(Boolean).join(" | ");
      if (t.kind === "selectable") {
        const opts = (t.options || []).slice(0, MAX_OPTIONS_PER_SELECT);
        const shown = opts.length ? `选项=[${opts.join("|")}]${t.options.length > opts.length ? ` …共${t.options.length}项` : ""}` : "";
        return [t.ref, t.role, label, `当前值=${t.value ? `"${t.value}"` : "空"}`, shown].filter(Boolean).join(" | ");
      }
      if (t.kind === "editable") {
        return [t.ref, t.role, label, `当前值=${t.value ? `"${t.value}"` : "空"}`].filter(Boolean).join(" | ");
      }
      return [t.ref, t.role, label, path].filter(Boolean).join(" | ");
    })
    .join("\n");
}

/** 描述一个候选元素，供对应操作的目标头使用 */
function describeTarget(target, { withValue = false } = {}) {
  const parts = [target.role];
  if (target.name) parts.push(`"${target.name}"`);
  if (withValue) {
    parts.push(`当前值=${target.value ? `"${target.value}"` : "空"}`);
    if (target.kind === "checkable") parts.push(checkedLabel(target.checked));
  }
  const path = shortPath(target.url);
  if (path) parts.push(path);
  return parts.join(" ");
}

/**
 * 组合 Jev 问题：一次请求并行判断，互不可见。
 * 每个操作有独立的 target 头，只列出与该操作兼容的元素；每个 target 问题的前提
 * 显式写出它假设的 operation（因为并行问题读不到彼此的答案）。
 *
 * 下拉选项用「代码侧索引」表示：ref=6#2 = 第 6 号元素下拉框的第 2 个选项。
 */
export function buildQuestions(targets, { texts = [], hasTextSource = false } = {}) {
  const clickTargets = targets.filter((t) => t.kind === "clickable" || t.kind === "checkable");
  const editableTargets = targets.filter((t) => t.kind === "editable");
  const selectTargets = targets.filter((t) => t.kind === "selectable" && (t.options || []).length > 0);
  const canType = editableTargets.length > 0 && hasTextSource;
  const canSelect = selectTargets.length > 0;

  const operationCriteria = {
    done: "当前页面已经完全达成用户目标，无需任何后续操作",
    blocked:
      "页面明确要求验证码、人工验证、登录或凭据，或可用的元素都只能推开目标；" +
      "以及“已完成的步骤”显示反复尝试都没有任何进展时，也应选它，而不是继续重复点击或滚动",
    wait: "页面仍在加载或弹窗动画中，需要短暂等待后重新观察",
    scroll_down: "目标可能在当前视口下方，需要向下滚动后继续寻找",
    scroll_up: "目标可能在当前视口上方，需要向上滚动后继续寻找",
  };
  if (clickTargets.length) operationCriteria.click = "点击某个元素，用于打开链接、进入下一页、勾选选项或触发按钮";
  if (canType) {
    operationCriteria.type_text = "在输入框中填入文本，但不提交";
    operationCriteria.type_text_submit = "在输入框中填入文本并按回车提交";
  }
  if (canSelect) operationCriteria.select = "在原生下拉框中改选某个选项";

  const questions = {
    operation: {
      type: "choice",
      instructions:
        "为了达成用户目标，当前页面最合理的下一步操作是什么？只能在给出的操作中选择。",
      criteria: operationCriteria,
    },
  };

  // 每个操作一个独立 target 头：只放兼容元素，操作/目标不匹配天然被排除
  if (clickTargets.length) {
    const criteria = { none: "本次操作不是 click" };
    for (const t of clickTargets) criteria[t.ref] = describeTarget(t, { withValue: true });
    questions.click_target = {
      type: "choice",
      instructions:
        "假设本次操作是 click：选出唯一最值得点击的元素；若不是 click 操作选 none。" +
        "对已勾选的复选框/单选，点击会取消勾选，避免误点。",
      criteria,
    };
  }

  if (canSelect) {
    const criteria = { none: "本次操作不是 select" };
    for (const t of selectTargets) {
      t.options.slice(0, MAX_OPTIONS_PER_SELECT).forEach((label, index) => {
        const isCurrent = index === t.selectedIndex;
        // 保留当前项但明确标注：部分站点改选后需再点提交按钮才生效，
        // 直接剔除会把 Jev 逼到乱选其他选项（实测震荡 Dansk↔Deutsch）。
        criteria[`${t.ref}#${index}`] =
          `${t.role} "${t.name}" 改选为 "${label}"` +
          (isCurrent ? "（当前已选中：若目标就是该值，本次不需再 select）" : "");
      });
    }
    questions.select_target = {
      type: "choice",
      instructions:
        "假设本次操作是 select：选出唯一的「下拉框 + 目标选项」组合（格式 元素#选项序号）；" +
        "若目标选项已经是当前值，选 none 并留给 operation 判 done；若不是 select 操作选 none。",
      criteria,
    };
  }

  if (canType) {
    const criteria = { none: "本次操作不是 type_text / type_text_submit" };
    for (const t of editableTargets) criteria[t.ref] = describeTarget(t, { withValue: true });
    questions.type_text_target = {
      type: "choice",
      instructions:
        "假设本次操作是 type_text 或 type_text_submit：选出唯一要填入的输入框（当前值已给出，" +
        "优先选需要修改或当前为空的字段）；若不是输入操作选 none。",
      criteria,
    };

    if (texts.length) {
      const textCriteria = { none: "本次操作不是输入操作" };
      texts.forEach((text, index) => {
        textCriteria[`t${index}`] = `输入文本 ${JSON.stringify(text)}`;
      });
      questions.input_text = {
        type: "choice",
        instructions: "假设本次操作是输入操作：选出最符合用户目标的文本；否则选 none。",
        criteria: textCriteria,
      };
    }
  }

  return questions;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 协议/请求计数：传入 options.metrics 对象即启用（用于量化对照） */
const bump = (metrics, key) => {
  if (metrics) metrics[key] = (metrics[key] || 0) + 1;
};

/** 比较页面变化时忽略 #hash：点锚点链接不该被当成“有进展” */
const stableUrl = (url) => String(url || "").split("#")[0];

/**
 * 动作后等待页面稳定。
 * 不能只用固定延迟：表单控件触发的导航可能晚于短延迟才开始，会把「已跳转」误判成
 * 「页面未变化」，导致 Jev 重复执行同一动作。先短静默，再用可观察的 load 状态兜底。
 */
async function settle(page, options = {}) {
  await sleep(options.stepDelay ?? 300);
  try {
    await page.waitForLoadState("load", { timeout: options.navWaitMs ?? 1200 });
  } catch {
    /* 超时说明没有新导航，不是错误 */
  }
}

/** 单步 Jev 决策 + 执行 */
export async function runJevStep(page, goal, options = {}) {
  const started = Date.now();
  const texts = (Array.isArray(options.text) ? options.text : options.text ? [options.text] : [])
    .map((t) => String(t))
    .filter(Boolean);
  // 显式传入 textModel: null 表示“本次禁用它”，而不是回退到配置文件
  const textModel = "textModel" in options ? options.textModel : loadTextModelConfig();

  const snapshot = await page.snapshot();
  bump(options.metrics, "page.snapshot");
  const parsed = parseActionTargets(snapshot, { limit: options.maxTargets ?? 40 });
  const targets = options.enrich === false ? parsed : await enrichTargets(page, parsed, options);
  if (!targets.length) {
    // 常见于导航刚提交、页面还在加载：交给调用方决定重试还是放弃
    return {
      stepDurationMs: Date.now() - started,
      action: "wait",
      target: null,
      isDone: false,
      changed: false,
      reason: "no_targets",
    };
  }

  const urlBefore = await page.url();
  bump(options.metrics, "page.url");
  const elementTable = buildActionMenu(targets);
  bump(options.metrics, "jev.request");
  const state = [`用户最终目标: ${goal}`, `当前页面: ${await page.title()} — ${urlBefore}`];
  bump(options.metrics, "page.title");
  // Jev 无跨请求记忆：已完成的步骤必须由代码回填，否则复合目标（A 然后 B）会反复重试第一步
  if (options.progress?.length) {
    state.push("已完成的步骤 (按时间顺序，已完成的部分不要重复执行):");
    state.push(...options.progress.map((line, index) => `  ${index + 1}. ${line}`));
  }
  state.push("当前视口内可交互元素 (ref | role | 名称 | 当前值 | 链接路径):");
  state.push(elementTable);
  if (texts.length) {
    state.push(`本次可填入的候选文本: ${texts.map((t) => JSON.stringify(t)).join(", ")}`);
  }

  const hasTextSource = texts.length > 0 || Boolean(textModel);
  const questions = buildQuestions(targets, { texts, hasTextSource });
  const answers = await askJev(state.join("\n"), questions, options);
  const action = answers.operation?.choice;

  // executor 只消费与选中 operation 对应的那个 target 头
  const targetHead =
    action === "click" ? "click_target" :
    action?.startsWith("type_text") ? "type_text_target" :
    action === "select" ? "select_target" : null;
  const chosenRaw = targetHead ? answers[targetHead]?.choice : null;
  const chosen = chosenRaw && chosenRaw !== "none" ? chosenRaw : null;

  // 陈旧校验：只接受与本次元素表一致的 ref（select 的 ref#index 同样校验）
  const refOf = (value) => (value || "").split("#")[0];
  const validTarget = chosen && targets.some((t) => t.ref === refOf(chosen)) ? chosen : null;
  const staleTarget = chosen && !validTarget ? chosen : null;

  // 文本来源：调用方候选优先，否则向文本模型索取（严格校验，失败即报错不猜值）
  // options.textModel 可以是配置对象，也可以是自定义生成函数（便于接入任意模型或测试）
  let text;
  let textError = null;
  const isTypeOp = action === "type_text" || action === "type_text_submit";
  if (isTypeOp && validTarget) {
    const choice = answers.input_text?.choice;
    if (choice && choice !== "none") {
      text = texts[Number(choice.slice(1))];
    } else if (textModel) {
      const field = targets.find((t) => t.ref === refOf(validTarget));
      const input = {
        goal,
        field: describeTarget(field || {}, { withValue: true }),
        elementTable,
        recentActions: options.progress,
      };
      try {
        text =
          typeof textModel === "function"
            ? await textModel(input)
            : await generateText(input, { ...options, textModel });
      } catch {
        text = null;
      }
      if (typeof text !== "string" || !text.trim()) {
        textError = "text_model_failed";
        text = undefined; // 关键：必须清空，否则非空白的空白串会被真的填进去
      } else {
        text = text.trim();
      }
    } else {
      textError = "no_text_source";
    }
    // 选了输入操作却没有可用文本：宁可报错，也不能静默什么都不做
    if (!textError && !text) textError = "no_text_selected";
  }

  let executed = null;
  let error = null;
  try {
    if (action === "click" && validTarget) {
      await page.click(validTarget, { label: `Jev 点击 ${validTarget}` });
      bump(options.metrics, "page.click");
      executed = validTarget;
    } else if (isTypeOp && validTarget && text) {
      await page.fill(validTarget, text);
      bump(options.metrics, "page.fill");
      if (action === "type_text_submit") {
        await page.press(validTarget, "Enter");
        bump(options.metrics, "page.press");
      }
      executed = validTarget;
    } else if (action === "select" && validTarget) {
      const index = Number(chosen.split("#")[1]);
      await page.selectOption(refOf(validTarget), { index });
      bump(options.metrics, "page.selectOption");
      executed = validTarget;
    } else if (action === "scroll_down" || action === "scroll_up") {
      const delta = action === "scroll_down" ? 600 : -600;
      await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "instant" }), delta);
      bump(options.metrics, "page.evaluate");
      executed = action;
    } else if (action === "wait") {
      executed = "wait";
    }
  } catch (err) {
    error = String(err?.message || err).slice(0, 200);
  }

  if (executed && executed !== "wait") await settle(page, options);
  const urlAfter = executed && executed !== "wait" ? await page.url() : urlBefore;
  if (executed && executed !== "wait") bump(options.metrics, "page.url");

  // 选了需要目标的动作却没解析出可执行目标：报错，不静默空转
  const needsTarget =
    action === "click" || action === "select" || action === "type_text" || action === "type_text_submit";
  const targetMissing = Boolean(needsTarget && !executed && !error && !textError);

  const chosenTarget = targets.find((t) => t.ref === refOf(validTarget));
  const targetLabel = chosenTarget ? describeTarget(chosenTarget, { withValue: true }) : validTarget || "";
  const optionLabel =
    action === "select" && chosenTarget?.options?.[Number(chosen.split("#")[1])] !== undefined
      ? chosenTarget.options[Number(chosen.split("#")[1])]
      : null;

  return {
    stepDurationMs: Date.now() - started,
    action,
    target: validTarget,
    targetLabel,
    option: optionLabel,
    text,
    textError,
    isDone: action === "done",
    blocked: action === "blocked",
    staleTarget,
    targetMissing,
    error,
    changed: stableUrl(urlAfter) !== stableUrl(urlBefore),
    urlBefore,
    urlAfter,
    operationProbabilities: answers.operation?.probabilities,
    operationConfidence: answers.operation?.confidence,
  };
}

/**
 * 全自主极速循环：单进程内连续决策 + 执行，直到目标完成或触发退出条件。
 *
 * options:
 *   maxSteps       最大步数（默认 12）
 *   text           可填文本，字符串或数组（给了候选时 Jev 从候选里选，不生成）
 *   textModel      文本生成来源：配置对象（默认读 ~/.config/typesafe/text_model.json）
 *                  或自定义 async (input) => string 函数；两者都缺失时不提供输入操作
 *   check          async (page, step) => boolean，命中即判定成功（推荐用于确定目标）
 *   stepDelay      每步动作后的静默等待（默认 300ms）
 *   navWaitMs      静默后等待新一轮 load 的上限（默认 1200ms），用于捕捉延迟导航
 *   onStep         日志回调，默认 console.log
 */
export async function runJevAutonomousLoop(page, goal, options = {}) {
  const maxSteps = options.maxSteps ?? 12;
  const log = options.onStep ?? ((message) => console.log(message));
  const maxNoTargets = options.maxNoTargets ?? 3;
  const maxNoProgress = options.maxNoProgress ?? 5;
  const history = [];
  let noTargetStreak = 0;
  let noProgressStreak = 0;
  let targetMissingStreak = 0;
  let sameActionStreak = 0;
  let lastAction = null;
  const progress = [];

  for (let step = 1; step <= maxSteps; step++) {
    if (options.check) {
      try {
        if (await options.check(page, step)) {
          log(`✅ [Ego-Jev] check() 在第 ${step} 步确认目标已达成`);
          return { success: true, steps: step - 1, reason: "check_passed", history };
        }
      } catch {
        /* check 抛错不阻塞主循环 */
      }
    }

    const result = await runJevStep(page, goal, { ...options, progress });
    log(
      `  └─ [Step ${step}] ${result.stepDurationMs}ms | ${result.action}` +
        (result.target ? ` → ${result.target}` : "") +
        (result.option ? ` = "${result.option}"` : "") +
        (result.text ? ` "${result.text}"` : "") +
        (result.staleTarget ? ` | ⚠️ ${result.staleTarget} 已过期，未执行` : "") +
        (result.targetMissing ? " | ⚠️ 选了需要目标的动作但未解析出可执行目标" : "") +
        (result.textError ? ` | ⚠️ ${result.textError}` : "") +
        (result.error ? ` | ⚠️ ${result.error}` : "")
    );

    if (result.reason !== "no_targets") {
      const verb =
        result.action === "click" ? "点击" :
        result.action === "type_text" ? "填入" :
        result.action === "type_text_submit" ? "填入并提交" :
        result.action === "select" ? "下拉改选" :
        result.action === "scroll_down" ? "向下滚动" :
        result.action === "scroll_up" ? "向上滚动" :
        result.action === "wait" ? "等待" : result.action;
      progress.push(
        `${verb}${result.targetLabel ? ` ${result.targetLabel}` : ""}` +
          (result.option ? `，选项 ${JSON.stringify(result.option)}` : "") +
          (result.text ? `，文本 ${JSON.stringify(result.text)}` : "") +
          (result.action === "scroll_down" || result.action === "scroll_up" || result.action === "wait"
            ? ""
            : result.changed
              ? ` → 页面已变化，当前在 ${shortPath(result.urlAfter)}`
              : " → 页面未变化")
      );
    }

    if (result.reason === "no_targets") {
      noTargetStreak += 1;
      if (noTargetStreak >= maxNoTargets) {
        return { success: false, steps: step, reason: "no_targets", history };
      }
      log(`  └─ [Step ${step}] 页面暂无可交互元素（可能仍在加载），等待后重试`);
      await sleep(options.noTargetsDelay ?? 700);
      continue;
    }
    noTargetStreak = 0;

    history.push(result);
    if (result.error) return { success: false, steps: step, reason: "action_failed", history };
    if (result.textError) return { success: false, steps: step, reason: result.textError, history };
    if (result.isDone) return { success: true, steps: step, reason: "jev_done", history };
    if (result.blocked) return { success: false, steps: step, reason: "blocked", history };

    // 选了动作却没有可执行目标：连续 2 次就停，不要静默空转到最大步数
    if (result.targetMissing) {
      targetMissingStreak += 1;
      if (targetMissingStreak >= (options.maxTargetMissing ?? 2)) {
        return { success: false, steps: step, reason: "target_missing", history };
      }
    } else {
      targetMissingStreak = 0;
    }

    // 同一个动作连续重复且页面无变化（含反复滚动/等待）：判为卡住
    sameActionStreak = result.action === lastAction && !result.changed ? sameActionStreak + 1 : 0;
    lastAction = result.action;
    if (sameActionStreak >= (options.maxSameAction ?? 3)) {
      return { success: false, steps: step, reason: "stuck", history };
    }

    // 死循环保护：连续多步点击/输入执行成功但页面毫无变化
    // （ref 每次快照都会重新编号，因此只能用“页面是否变化”判断重复）
    const isMutating = result.action === "click" || result.action?.startsWith("type_text") || result.action === "select";
    if (!isMutating || result.changed) {
      noProgressStreak = 0;
    } else {
      noProgressStreak += 1;
      if (noProgressStreak >= maxNoProgress) {
        return { success: false, steps: step, reason: "no_progress", history };
      }
    }
  }

  return { success: false, steps: maxSteps, reason: "max_steps_reached", history };
}
