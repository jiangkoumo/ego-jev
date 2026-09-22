#!/usr/bin/env bash
# A 栈（移植后 ego-jev）vs B 栈（browser-harness + jev-ultrafast）对照基准。
# 3 个任务 × 交替 3 轮；每轮记录端到端耗时、步数、模型调用数、成功与否、终态 URL。
# 两个栈共用同一个 Chrome 实例，偶尔会撞上 browser-harness 的 5s IPC 超时，故每轮最多重试 3 次。
# 用法: bash bench/vs-bstack.sh [轮数]
set -uo pipefail
ROUNDS="${1:-3}"
BENCH="/Users/jiangkoumo/Documents/ego-jev/bench"
JEVDIR="/Users/jiangkoumo/Documents/scratchpad/jev-ultrafast"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
OUT="${BENCH}/raw/vs-bstack-${STAMP}.jsonl"
LOG="${BENCH}/raw/vs-bstack-${STAMP}.log"
TASKS=(hn-nav wiki-search httpbin-form)
MAX_ATTEMPTS=3

export BU_CDP_WS="$(bh ensure 2>/dev/null)"
echo "BU_CDP_WS=$BU_CDP_WS" | tee -a "$LOG"
echo "OUT=$OUT" | tee -a "$LOG"

# 从混合输出里取出那一行结果 JSON（ego 的 console.log 走 stderr，B 的走 stdout）
extract() { grep -o '^{"stack".*' <<<"$1" | tail -1; }

run_once() {
  local stack="$1" task="$2"
  if [ "$stack" = "A" ]; then
    sed "s/__TASK__/${task}/" "${BENCH}/run-a.tpl.js" | timeout 240 ego-browser nodejs 2>&1
  else
    (cd "$JEVDIR" && timeout 240 uv run --env-file .env python "${BENCH}/run-b.py" "$task" 2>&1)
  fi
}

for round in $(seq 1 "$ROUNDS"); do
  for task in "${TASKS[@]}"; do
    for stack in A B; do
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
        line="{\"stack\":\"${stack}\",\"task\":\"${task}\",\"success\":false,\"reason\":\"no_output\"}"
      fi
      # 注入轮次与尝试次数，便于事后核对
      line="$(sed "s/^{/{\"round\":${round},\"attempts\":${attempts},/" <<<"$line")"
      echo "$line" >> "$OUT"
      echo "$line"
      sleep 1.5
    done
  done
done
echo "DONE: $OUT"
