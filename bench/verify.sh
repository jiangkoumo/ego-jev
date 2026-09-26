#!/usr/bin/env bash
# A 臂验证编排（预登记协议 bench/verify-protocol.md 的 A 臂部分）：
#   5 任务 × N 轮；harness 级失败（脚本无任何输出行）最多重试到 attempts=3；任务级失败保留不重试。
#
# 用法: bash bench/verify.sh [轮数] [--check-env] [--a-only]
#   [轮数]        默认 10
#   --check-env   只做环境预检就退出（0 = 可用）
#   --a-only      兼容旧命令：B 臂驱动已撤出仓库，现在只有 A 臂，等价于默认
#
# 环境变量:
#   BENCH_OUT_DIR  结果目录（默认 bench/raw）
#
# 注意：第 5 个任务 select-native 访问 http://127.0.0.1:8099/c.html，需要你自己先在 8099 起一个
#       静态服务（c.html / d.html 两个固定件不在仓库里）；没起就会记成 harness_error。
#
# 注：B 臂（browser-harness + jev-ultrafast）的驱动脚本已从仓库移除——它的引擎早已移植进
#     scripts/ego-jev.mjs，产品路径、CLI、路由层从不依赖 browser-harness。
#     历史脚本在 git 历史里（如 git show 599a49b:bench/run-b.py），
#     报告里的 B 栈数字由 bench/raw/ 的原始数据复算（bench/analyze-*.mjs）。
set -uo pipefail

ROUNDS=10
CHECK_ENV=0
for arg in "$@"; do
  case "$arg" in
    --a-only) : ;;                      # 兼容旧命令
    --check-env) CHECK_ENV=1 ;;
    ''|*[!0-9]*) echo "未知参数: ${arg}" >&2; exit 2 ;;
    *) ROUNDS="$arg" ;;
  esac
done

BENCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${BENCH}/.." && pwd)"

if [ "$CHECK_ENV" = "1" ]; then
  if command -v ego-browser >/dev/null 2>&1; then
    echo "A 臂（ego-jev）: 可用（$(ego-browser --version 2>&1 | head -1)）"
    exit 0
  fi
  echo "A 臂（ego-jev）: 不可用——找不到 ego-browser（先装 ego lite 并让它在 PATH 里）" >&2
  exit 1
fi

command -v ego-browser >/dev/null 2>&1 || { echo "error: 找不到 ego-browser（ego lite 是否已安装？）" >&2; exit 2; }

if command -v curl >/dev/null 2>&1 && ! curl -sf --max-time 2 http://127.0.0.1:8099/c.html >/dev/null 2>&1; then
  echo "注意: 127.0.0.1:8099 上的固定件服务不在——select-native 这一格会记成 harness_error（其余四格不受影响）" >&2
fi

# 路径里可能带 & | \，直接当 sed 替换串会出错（& 会展开成匹配到的占位符），先转义
REPO_SED="${ROOT//\\/\\\\}"
REPO_SED="${REPO_SED//&/\\&}"
REPO_SED="${REPO_SED//|/\\|}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
OUTDIR="${BENCH_OUT_DIR:-${BENCH}/raw}"
mkdir -p "$OUTDIR"
OUT="${OUTDIR}/verify-${STAMP}.jsonl"
LOG="${OUTDIR}/verify-${STAMP}.log"
TASKS=(hn-nav hn-page2 wiki-search httpbin-form select-native)
MAX_ATTEMPTS=3

{
  echo "PROTOCOL: ${BENCH}/verify-protocol.md"
  echo "ENGINE_MD5_PRE: $(md5 -q "${BENCH}/../scripts/ego-jev.mjs" 2>/dev/null || echo '(md5 不可用)')"
  echo "OUT=$OUT"
  echo "ROUNDS=$ROUNDS"
} | tee -a "$LOG"

extract() { grep -o '^{"stack".*' <<<"$1" | tail -1; }

run_once() {
  local task="$1"
  sed -e "s/__TASK__/${task}/" -e "s|__REPO__|${REPO_SED}|g" "${BENCH}/verify-run-a.tpl.js" |
    timeout 240 ego-browser nodejs 2>&1
}

for round in $(seq 1 "$ROUNDS"); do
  for task in "${TASKS[@]}"; do
    line=""; attempts=0
    while [ "$attempts" -lt "$MAX_ATTEMPTS" ]; do
      attempts=$((attempts + 1))
      raw="$(run_once "$task")"
      printf '%s\n' "$raw" >> "$LOG"
      line="$(extract "$raw")"
      [ -n "$line" ] && break
      sleep 2
    done
    if [ -z "$line" ]; then
      line="{\"stack\":\"A\",\"task\":\"${task}\",\"success\":false,\"reason\":\"no_output\",\"elapsedMs\":null,\"steps\":null}"
    fi
    line="$(sed "s/^{/{\"round\":${round},\"order\":\"A\",\"attempts\":${attempts},/" <<<"$line")"
    echo "$line" >> "$OUT"
    echo "$line"
    sleep 1
  done
done

echo "ENGINE_MD5_POST: $(md5 -q "${BENCH}/../scripts/ego-jev.mjs" 2>/dev/null || echo '(md5 不可用)')" | tee -a "$LOG"
echo "DONE: $OUT"
