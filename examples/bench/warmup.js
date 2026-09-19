// 把对照组页面导航到起点（不计时）
const BENCH_DIR = "__BENCH_DIR__";
const { readFile } = await import("node:fs/promises");
const task = JSON.parse(await readFile(`${BENCH_DIR}/task.json`, "utf8"));
const space = await taskSpace("bench-classic");
const page = space.page("p1");
await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 25000 });
console.log("warm", await page.url());
