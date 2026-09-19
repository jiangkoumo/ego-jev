// 揭示验证的量测助手（非浏览器依赖的逻辑可单测；页面部分需在 ego 里调用）
// 用途：① 量「目标在第几屏」——maxReveals 触顶时判断默认值该不该调
//      ② 从引擎日志解析揭示次数

/** 从引擎日志行里解析揭示次数：形如 `…（第 2/4 次）` */
export function parseRevealCounts(logLines) {
  const re = /第 (\d+)\/(\d+) 次/;
  const hits = (logLines || []).filter((l) => re.test(String(l)));
  return {
    count: hits.length,
    maxAttempt: hits.length ? Math.max(...hits.map((l) => Number(String(l).match(re)[1]))) : 0,
    cap: hits.length ? Number(String(hits[0]).match(re)[2]) : null,
    lines: hits.map((l) => String(l).trim()),
  };
}

/**
 * 页面内：目标在第几屏（从顶部往下按视口逐屏找）。
 * probe 返回 truthy 表示找到了目标；返回 -1 表示翻到页底也没找到。
 * 注意：只读，不点击。
 */
export function screenIndexOfTargetInPage(payload) {
  const step = Math.round(innerHeight * 0.85);
  const max = payload.maxScreens || 40;
  const key = payload.key;
  const text = (document.body ? document.body.innerText : "").toLowerCase();
  const hit = () => {
    if (key === "text") return text.includes(String(payload.needle).toLowerCase());
    if (key === "selector") return Boolean(document.querySelector(payload.needle));
    return false;
  };
  window.scrollTo({ top: 0, behavior: "instant" });
  let screen = 0;
  for (; screen < max; screen++) {
    if (hit()) return { found: true, screen: screen + 1, scrollY: Math.round(scrollY), viewportH: innerHeight };
    const before = scrollY;
    window.scrollBy({ top: step, behavior: "instant" });
    if (scrollY === before) break; // 到页底
  }
  if (hit()) return { found: true, screen: screen + 1, scrollY: Math.round(scrollY), viewportH: innerHeight };
  return { found: false, screen: -1, screens: screen, scrollY: Math.round(scrollY), viewportH: innerHeight };
}

/** 统计助手：中位 / IQR / 极值 */
export function describe(xs) {
  const s = [...(xs || [])].filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => {
    const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  return { n: s.length, min: s[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: s[s.length - 1] };
}
