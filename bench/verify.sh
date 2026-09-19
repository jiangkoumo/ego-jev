#!/usr/bin/env bash
# 大样本验证编排（预登记协议 §3/§4）：
#   5 任务 × 2 栈 × 10 轮 = 100 轮；A/B 交替，且奇轮 A→B、偶轮 B→A（控制同轮内先后顺序）。
#   harness 级失败（无输出行）最多重试到 attempts=3；任务级失败保留不重试。
# 用法: bash bench/verify.sh [轮数]
set -uo pipefail
ROUNDS="${1:-10}"
BENCH="/Users/jiangkoumo/Documents/scratchpad/ego-jev/bench"
JEVDIR="/Users/jiangkoumo/Documents/scratchpad/jev-ultrafast"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
OUT="${BENCH}/raw/verify-${STAMP}.jsonl"
LOG="${BENCH}/raw/verify-${STAMP}.log"
TASKS=(hn-nav hn-page2 wiki-search httpbin-form select-native)
MAX_ATTEMPTS=3

export BU_CDP_WS="$(bh ensure 2>/dev/null)"
{
  echo "PROTOCOL: ${BENCH}/verify-protocol.md"
  echo "ENGINE_MD5_PRE: $(md5 -q "${BENCH}/../scripts/ego-jev.mjs")"
  echo "BU_CDP_WS=$BU_CDP_WS"
  echo "OUT=$OUT"
  echo "ROUNDS=$ROUNDS"
} | tee -a "$LOG"

extract() { grep -o '^{"stack".*' <<<"$1" | tail -1; }

run_once() {
  local stack="$1" task="$2"
  if [ "$stack" = "A" ]; then
    sed "s/__TASK__/${task}/" "${BENCH}/verify-run-a.tpl.js" | timeout 240 ego-browser nodejs 2>&1
  else
    (cd "$JEVDIR" && timeout 240 uv run --env-file .env python "${BENCH}/verify-run-b.py" "$task" 2>&1)
  fi
}

for round in $(seq 1 "$ROUNDS"); do
  # 奇轮 A→B，偶轮 B→A
  if [ $((round % 2)) -eq 1 ]; then ORDER=(A B); else ORDER=(B A); fi
  order_tag="${ORDER[0]}${ORDER[1]}"
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
