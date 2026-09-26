#!/usr/bin/env bash
# 大样本验证编排（预登记协议 §3/§4）：
#   5 任务 × 2 栈 × 10 轮 = 100 轮；A/B 交替，且奇轮 A→B、偶轮 B→A（控制同轮内先后顺序）。
#   harness 级失败（无输出行）最多重试到 attempts=3；任务级失败保留不重试。
#
# 用法: bash bench/verify.sh [轮数] [--a-only] [--check-env]
#   --a-only     只跑 A 臂（ego-jev）；B 臂需要 browser-harness，机器上没有 bh 时用这个
#   --check-env  只做环境预检就退出（0 = A 臂可用；B 臂缺失只算警告）
# 注：产品路径（CLI / 路由层）与 A 臂都不依赖 browser-harness；B 臂脚本是历史对照的复现工具。
set -uo pipefail
ROUNDS=10
A_ONLY=0
CHECK_ENV=0
for arg in "$@"; do
  case "$arg" in
    --a-only) A_ONLY=1 ;;
    --check-env) CHECK_ENV=1 ;;
    ''|*[!0-9]*) echo "未知参数: ${arg}" >&2; exit 2 ;;
    *) ROUNDS="$arg" ;;
  esac
done
BENCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${BENCH}/.." && pwd)"
# B 臂对照需要 jev-ultrafast 仓库（不在本仓库里）——用环境变量显式给出，本来就不写死本机路径
JEVDIR="${JEV_ULTRAFAST_DIR:-}"

b_stack_blockers() {   # 逐行输出 B 臂缺什么（没有输出 = 可用）
  command -v bh >/dev/null 2>&1 || echo "bh 不在 PATH（browser-harness 已移除？）"
  [ -n "$JEVDIR" ] || echo "JEV_ULTRAFAST_DIR 未设置（B 臂需要 jev-ultrafast 仓库路径）"
  [[ -z "$JEVDIR" || -d "$JEVDIR" ]] || echo "JEV_ULTRAFAST_DIR 不是目录: ${JEVDIR}"
}

if [ "$CHECK_ENV" = "1" ]; then
  rc=0
  if command -v ego-browser >/dev/null 2>&1; then
    echo "A 臂（ego-jev）: 可用（$(ego-browser --version 2>&1 | head -1)）"
  else
    echo "A 臂（ego-jev）: 不可用——找不到 ego-browser"
    rc=1
  fi
  blockers="$(b_stack_blockers)"
  if [ -z "$blockers" ]; then
    echo "B 臂（browser-harness + jev-ultrafast）: 可用"
  else
    echo "B 臂（browser-harness + jev-ultrafast）: 不可用"
    while IFS= read -r b; do printf '  - %s\n' "$b"; done <<< "$blockers"
    echo "  （B 臂只是历史对照的复现工具；A 臂与产品路径都不依赖它）"
  fi
  exit $rc
fi

if [ "$A_ONLY" != "1" ]; then
  blockers="$(b_stack_blockers)"
  if [ -n "$blockers" ]; then
    echo "B 臂不可用，先不跑了（不加 --a-only 就需要 B 臂）:" >&2
    while IFS= read -r b; do printf '  - %s\n' "$b" >&2; done <<< "$blockers"
    echo "  A 臂单独跑: bash bench/verify.sh ${ROUNDS} --a-only" >&2
    echo "  先看环境: bash bench/verify.sh --check-env" >&2
    exit 2
  fi
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

BU_CDP_WS=""
if [ "$A_ONLY" != "1" ]; then
  BU_CDP_WS="$(bh ensure 2>/dev/null)"
  if [ -z "$BU_CDP_WS" ]; then echo "bh ensure 没给出 CDP 端点（BU_CDP_WS 为空）——B 臂跑不了，先查 bh" >&2; exit 2; fi
fi
export BU_CDP_WS
{
  echo "PROTOCOL: ${BENCH}/verify-protocol.md"
  echo "ENGINE_MD5_PRE: $(md5 -q "${BENCH}/../scripts/ego-jev.mjs")"
  echo "BU_CDP_WS=$BU_CDP_WS"
  echo "A_ONLY=$A_ONLY"
  echo "OUT=$OUT"
  echo "ROUNDS=$ROUNDS"
} | tee -a "$LOG"

extract() { grep -o '^{"stack".*' <<<"$1" | tail -1; }

run_once() {
  local stack="$1" task="$2"
  if [ "$stack" = "A" ]; then
    sed -e "s/__TASK__/${task}/" -e "s|__REPO__|${REPO_SED}|g" "${BENCH}/verify-run-a.tpl.js" | timeout 240 ego-browser nodejs 2>&1
  else
    (cd "$JEVDIR" && timeout 240 uv run --env-file .env python "${BENCH}/verify-run-b.py" "$task" 2>&1)
  fi
}

for round in $(seq 1 "$ROUNDS"); do
  # 奇轮 A→B，偶轮 B→A；--a-only 就只有 A
  if [ "$A_ONLY" = "1" ]; then ORDER=(A);
  elif [ $((round % 2)) -eq 1 ]; then ORDER=(A B);
  else ORDER=(B A); fi
  order_tag="$(printf '%s' "${ORDER[@]}")"   # AB / BA / A（--a-only 时数组只有 1 项）
  for task in "${TASKS[@]}"; do
    for stack in "${ORDER[@]}"; do
      line=""; attempts=0
      while [ "$attempts" -lt "$MAX_ATTEMPTS" ]; do
        attempts=$((attempts + 1))
        raw="$(run_once "$stack" "$task")"
        printf '%s\n' "$raw" >> "$LOG"
        line="$(extract "$raw")"
        [ -n "$line" ] && break
        sleep 2
      done
      if [ -z "$line" ]; then
        line="{\"stack\":\"${stack}\",\"task\":\"${task}\",\"success\":false,\"reason\":\"no_output\",\"elapsedMs\":null,\"steps\":null}"
      fi
      line="$(sed "s/^{/{\"round\":${round},\"order\":\"${order_tag}\",\"attempts\":${attempts},/" <<<"$line")"
      echo "$line" >> "$OUT"
      echo "$line"
      sleep 1
    done
  done
done

echo "ENGINE_MD5_POST: $(md5 -q "${BENCH}/../scripts/ego-jev.mjs")" | tee -a "$LOG"
echo "DONE: $OUT"
