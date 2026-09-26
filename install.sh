#!/usr/bin/env bash
# ego-jev — 手工安装（不想用 `npx skills add` 时走这条路）。
#
# 做五件事：
#   1. 检查 ego lite / ego-browser 是否就绪
#   2. 把 scripts/ego-jev 链接进 PATH
#   3. 准备 ~/.config/typesafe/api_key（会把 shell 里的 TYPESAFE_API_KEY 落盘，权限 600）
#   4. 提示 ego-jev 技能怎么装（本脚本不改任何应用包内文件）
#   5. `--wire`：把 Agent 技能目录里的官方 ego-browser 入口接管成路由层，
#      让多步浏览器任务默认走 ego-jev（可还原，同样不碰应用包）
#
# 用法: ./install.sh [--bindir DIR] [--test] [--skills-dir DIR] [--wire]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINDIR="${BINDIR:-$HOME/.local/bin}"
SKILLS_DIR="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
RUN_TEST=0
WIRE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bindir) BINDIR="$2"; shift 2 ;;
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    --wire) WIRE=1; shift ;;
    --test) RUN_TEST=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

info() { printf '  %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

echo "==> 1/5 检查前置条件"
command -v ego-browser >/dev/null 2>&1 || fail "未找到 ego-browser。请先安装 ego lite：https://github.com/citrolabs/ego-lite"
info "ego-browser: $(ego-browser --version 2>/dev/null | head -1)"
command -v node >/dev/null 2>&1 || fail "未找到 node（CLI 需要它生成配置 JSON）"

echo "==> 2/5 安装命令入口"
mkdir -p "$BINDIR"
ln -sfn "$REPO_DIR/scripts/ego-jev" "$BINDIR/ego-jev"
info "$BINDIR/ego-jev -> $REPO_DIR/scripts/ego-jev"
case ":$PATH:" in
  *":$BINDIR:"*) info "已在 PATH 中" ;;
  *) info "注意: $BINDIR 不在 PATH 中，请自行加入（export PATH=\"$BINDIR:\$PATH\"）" ;;
esac

echo "==> 3/5 准备 Jev 凭证"
KEY_FILE="${TYPESAFE_API_KEY_FILE:-$HOME/.config/typesafe/api_key}"
mkdir -p "$(dirname "$KEY_FILE")"
if [ -f "$KEY_FILE" ] && [ -s "$KEY_FILE" ]; then
  info "已存在: $KEY_FILE"
elif [ -n "${TYPESAFE_API_KEY:-}" ]; then
  # ego 的内嵌运行时拿不到环境变量，所以必须落盘
  printf '%s\n' "$TYPESAFE_API_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  info "已从环境变量写入: $KEY_FILE"
else
  info "缺少凭证文件: $KEY_FILE"
  info "请执行（把 KEY 换成你的 TypeSafe API Key）:"
  info "  printf '%s\\n' 'KEY' > \"$KEY_FILE\" && chmod 600 \"$KEY_FILE\""
fi

echo "==> 4/5 安装技能（让 Agent 知道怎么用）"
SKILL_DEST="$SKILLS_DIR/ego-jev"
if [ -f "$SKILL_DEST/SKILL.md" ] || [ -L "$SKILL_DEST/SKILL.md" ]; then
  info "技能已存在: $SKILL_DEST"
else
  info "本脚本不替你把技能装到任何 Agent 目录（各 Agent 约定不同）。二选一："
  info "  a) npx skills add jiangkoumo/ego-jev"
  info "  b) mkdir -p \"$SKILL_DEST\" && ln -sfn \"$REPO_DIR/SKILL.md\" \"$SKILL_DEST/SKILL.md\""
fi

if [ "$RUN_TEST" = "1" ]; then
  echo "==> 冒烟测试（会打开一个浏览器 Space）"
  if "$BINDIR/ego-jev" --url "https://en.wikipedia.org/wiki/Main_Page" \
      --text "Jev" --until "/wiki/Jev" --steps 5 \
      "type Jev into the search box and submit"; then
    echo "==> 冒烟测试通过"
  else
    echo "==> 冒烟测试失败（退出码 $?）——请看上面的 reason 字段" >&2
    exit 1
  fi
fi

echo
WIRE_FAILED=0
if [ "$WIRE" = "1" ]; then
  echo "==> 5/5 接管官方 ego-browser 入口"
  if ! bash "$REPO_DIR/scripts/wire-agent-skills.sh"; then
    WIRE_FAILED=1
    echo "  ! 接管没完成——上面是原因；ego-jev CLI 仍可用。修好后重跑：bash \"$REPO_DIR/scripts/wire-agent-skills.sh\"" >&2
  fi
else
  echo "==> 5/5 接管官方 ego-browser 入口（未启用：加 --wire）"
  info "ego lite 会把官方 ego-browser 技能写进每个 Agent 的技能目录，"
  info "而官方正文不知道 ego-jev —— 不接管的话，Agent 默认照它写逐步脚本。"
  info "接管（可还原、不改应用包）: bash \"$REPO_DIR/scripts/wire-agent-skills.sh\""
  info "或安装时直接带上: ./install.sh --wire"
fi

echo
echo "完成。常用命令："
echo "  ego-jev --url \"https://…\" --until \"/expected/path\" \"目标描述\""
echo "  引擎也可在 ego-browser nodejs 脚本里 import: $REPO_DIR/scripts/ego-jev.mjs"

[ "$WIRE_FAILED" = "0" ] || exit 1
