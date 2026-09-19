#!/usr/bin/env bash
# 单轮对照：A = ego-jev 单进程闭环；B = 经典循环（每步一个进程 + 大模型思考）。输出一行 JSON。
#
# ego 内嵌运行时拿不到自定义环境变量，所以配置在这里替换进脚本正文再送进去。
set -uo pipefail

ARM="${1:?用法: run-pair.sh A|B [model]}"
BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EGO_BROWSER_BIN="${EGO_BROWSER_BIN:-ego-browser}"

BASE_URL="${BENCH_BASE_URL:-https://opencode.ai/zen/go/v1}"
AUTH_FILE="${BENCH_AUTH_FILE:-$HOME/.pi/agent/auth.json}"
AUTH_PATH="${BENCH_AUTH_PATH:-opencode-go.key}"
API_KEY="${BENCH_API_KEY:-}"
MODEL_BIG="${2:-${BENCH_MODEL:-kimi-k3}}"
MODEL_TEXT="${BENCH_TEXT_MODEL:-deepseek-v4.1-flash}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ego-jev-bench.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

subst() {
  sed -e "s|__BENCH_DIR__|$BENCH_DIR|g" \
      -e "s|__BASE_URL__|$BASE_URL|g" \
      -e "s|__AUTH_FILE__|$AUTH_FILE|g" \
      -e "s|__AUTH_PATH__|$AUTH_PATH|g" \
      -e "s|__API_KEY__|$API_KEY|g" \
      -e "s|__MODEL_BIG__|$MODEL_BIG|g" \
      -e "s|__MODEL_TEXT__|$MODEL_TEXT|g" \
      "$1" > "$TMP/$(basename "$1")"
}

now() { python3 -c 'import time;print(int(time.time()*1000))'; }
result() { grep '^RESULT ' | sed 's/^RESULT //' | head -1; }

if [ "$ARM" = "A" ]; then
  subst "$BENCH_DIR/arm-a.js"
  START="$(now)"
  OUT="$("$EGO_BROWSER_BIN" nodejs < "$TMP/arm-a.js" 2>&1 | result)"
  END="$(now)"
  [ -z "$OUT" ] && { echo '{"arm":"jev","error":"no result"}'; exit 1; }
  python3 -c "import json,sys;d=json.loads(sys.argv[1]);d['wallMs']=$((END-START));d['processSpawns']=1;print(json.dumps(d))" "$OUT"
else
  subst "$BENCH_DIR/warmup.js"
  subst "$BENCH_DIR/arm-b-step.js"
  echo '{"progress":[]}' > "$BENCH_DIR/state-b.json"
  "$EGO_BROWSER_BIN" nodejs < "$TMP/warmup.js" >/dev/null 2>&1   # 导航不计时
  START="$(now)"
  SPAWNS=0; INTERNAL=0; DECISION=0; STEPS=0; OK=0
  for _ in $(seq 1 "${BENCH_MAX_STEPS:-8}"); do
    OUT="$("$EGO_BROWSER_BIN" nodejs < "$TMP/arm-b-step.js" 2>&1 | result)"
    SPAWNS=$((SPAWNS+1)); STEPS=$((STEPS+1))
    [ -z "$OUT" ] && break
    INTERNAL=$(python3 -c "import json,sys;print($INTERNAL+json.loads(sys.argv[1]).get('internalMs',0))" "$OUT")
    DECISION=$(python3 -c "import json,sys;print($DECISION+json.loads(sys.argv[1]).get('decisionMs',0))" "$OUT")
    if python3 -c "import json,sys;raise SystemExit(0 if json.loads(sys.argv[1]).get('done') else 1)" "$OUT"; then OK=1; break; fi
  done
  END="$(now)"
  python3 -c "
import json
print(json.dumps({'arm':'classic','model':'$MODEL_BIG','wallMs':$((END-START)),'success':bool($OK),
                  'steps':$STEPS,'processSpawns':$SPAWNS,'internalMs':$INTERNAL,'decisionMs':$DECISION}))"
fi
