// B 组（经典循环）的「一步」：独立进程 → 快照 → 大模型思考 → 动作。
// 这正是常规用法里「每走一步退出来交由大模型慢思考」的形态。
const BENCH_DIR = "__BENCH_DIR__";
const GATEWAY = { baseUrl: "__BASE_URL__", authFile: "__AUTH_FILE__", authPath: "__AUTH_PATH__", apiKey: "__API_KEY__" };
const MODEL_BIG = "__MODEL_BIG__";
const MODEL_TEXT = "__MODEL_TEXT__";

const { readFile, writeFile } = await import("node:fs/promises");
const { resolveLib, gateway } = await import(`${BENCH_DIR}/lib.js`);
const { parseActionTargets, buildActionMenu } = await import(resolveLib(BENCH_DIR));

const started = Date.now();
const task = JSON.parse(await readFile(`${BENCH_DIR}/task.json`, "utf8"));
const statePath = `${BENCH_DIR}/state-b.json`;
const state = JSON.parse(await readFile(statePath, "utf8"));
const gw = gateway(GATEWAY);
const ask = async (body) => {
  const t0 = Date.now();
  const res = await fetch(`${gw.baseUrl}/chat/completions`, {
    method: "POST", headers: gw.headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json();
  return { ms: Date.now() - t0, content: String(json.choices?.[0]?.message?.content ?? "") };
};
const jsonOf = (text) => {
  const raw = String(text).replace(/```json|```/g, "").trim();
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
};

const space = await taskSpace("bench-classic");
const page = space.page("p1");

if ((await page.url()).includes(task.verify)) {
  console.log("RESULT " + JSON.stringify({ done: true, internalMs: Date.now() - started, decisionMs: 0 }));
} else {
  const targets = parseActionTargets(await page.snapshot(), { limit: 40 });
  const menu = buildActionMenu(targets);
  const url = await page.url();
  const title = await page.title();
  const prompt = [
    `Goal: ${task.goal}`,
    `Page: ${title} — ${url}`,
    state.progress.length ? `Done so far:\n${state.progress.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}` : "",
    "Interactive elements (ref | role | name | value | href):",
    menu,
    'Reply with JSON only: {"action":"click","target":"ref=N"} or {"action":"type_submit","target":"ref=N"} or {"action":"done"}',
  ].filter(Boolean).join("\n");

  const decision = await ask({ model: MODEL_BIG, messages: [{ role: "user", content: prompt }] });
  let action = null, target = null;
  try { const parsed = jsonOf(decision.content); action = parsed.action; target = parsed.target; }
  catch { action = "parse_failed"; }

  let text = null, genMs = 0, changed = false;
  try {
    if (action === "type_submit" && targets.some((t) => t.ref === target)) {
      const gen = await ask({
        model: MODEL_TEXT,
        messages: [
          { role: "system", content: 'You output JSON only. Return exactly one field: {"text": "..."}.' },
          { role: "user", content: `Goal: ${task.goal}\nField: ${menu.split("\n").find((l) => l.startsWith(target)) || target}\nReturn the single text value to type.` },
        ],
        response_format: { type: "json_object" },
      });
      genMs = gen.ms;
      try { text = jsonOf(gen.content).text; } catch { text = null; }
      if (text) {
        await page.fill(target, text);
        await page.press(target, "Enter");
        await page.waitForTimeout(400);
        changed = (await page.url()) !== url;
      }
    } else if (action === "click" && targets.some((t) => t.ref === target)) {
      await page.click(target);
      await page.waitForTimeout(400);
      changed = (await page.url()) !== url;
    }
  } catch (err) { action = "error:" + String(err).slice(0, 80); }

  const label = targets.find((t) => t.ref === target);
  if (label && (action === "click" || action === "type_submit")) {
    state.progress.push(`${action === "click" ? "clicked" : "typed+submitted"} ${label.role}` +
      (label.name ? ` "${label.name}"` : "") + (text ? `, text "${text}"` : "") +
      (changed ? " -> page changed" : " -> no change"));
  }
  await writeFile(statePath, JSON.stringify(state));
  console.log("RESULT " + JSON.stringify({
    done: action === "done", action, target, text,
    decisionMs: decision.ms + genMs, internalMs: Date.now() - started, changed,
  }));
}
