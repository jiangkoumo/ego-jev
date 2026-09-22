#!/usr/bin/env bash
# ego-jev — 一键更新（幂等，可反复跑）
#
# 用法: ./update.sh [--test]
#
#   1. git 克隆安装 → `git pull --ff-only` 拉最新（软链会自动跟随，无需重装）
#   2. skills CLI 安装（技能是**拷贝**）→ 提示重跑 `npx skills add` 覆盖
#   3. 刷新 CLI 软链（幂等），打印更新前后版本
#   4. `--test` 顺带跑一次端到端冒烟
#
# 不改任何应用包内文件，不动凭证，不删任何东西。

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINDIR="${BINDIR:-$HOME/.local/bin}"
SKILLS_DIR="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
RUN_TEST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) RUN_TEST=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
version() { git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo "（非 git 克隆）"; }

BEFORE="$(version)"
echo "==> ego-jev 更新"
info "仓库: $REPO_DIR"
info "当前版本: $BEFORE"

echo
echo "==> 1/3 拉取最新"
if [ -d "$REPO_DIR/.git" ]; then
  if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
    warn "工作区有未提交改动，跳过 git pull（免得覆盖你的改动）"
    info "想更新请先处理：git -C \"$REPO_DIR\" status"
  elif git -C "$REPO_DIR" pull --ff-only 2>&1 | sed 's/^/     /'; then
    info "拉取完成"
  else
    warn "git pull 失败（网络/权限，或本地与远程分叉）——继续用当前版本"
  fi
else
  info "这不是 git 克隆（skills CLI 装的是拷贝，无法自我更新）"
  info "请重跑一次覆盖更新：npx skills add jiangkoumo/ego-jev"
fi

AFTER="$(version)"
if [ "$BEFORE" != "$AFTER" ]; then
  info "版本: $BEFORE → $AFTER"
else
  info "版本未变（已是最新）"
fi

echo
echo "==> 2/3 刷新 CLI 软链"
mkdir -p "$BINDIR"
ln -sfn "$REPO_DIR/scripts/ego-jev" "$BINDIR/ego-jev"
info "$BINDIR/ego-jev -> $REPO_DIR/scripts/ego-jev"
case ":$PATH:" in
  *":$BINDIR:"*) info "已在 PATH 中" ;;
  *) warn "$BINDIR 不在 PATH 中，请自行加入：export PATH=\"$BINDIR:\$PATH\"" ;;
esac

echo
echo "==> 3/3 技能目录"
SKILL_LINK="$SKILLS_DIR/ego-jev"
if [ -L "$SKILL_LINK" ]; then
  info "$SKILL_LINK 是软链 → 已随仓库一起更新，无需额外操作"
elif [ -e "$SKILL_LINK" ]; then
  info "$SKILL_LINK 是拷贝（skills CLI 安装）"
  info "更新它请重跑：npx skills add jiangkoumo/ego-jev"
else
  info "未发现技能目录 $SKILL_LINK（可选——不装技能也能直接用 CLI）"
  info "  装它：npx skills add jiangkoumo/ego-jev"
  info "  或链接：mkdir -p \"$SKILL_LINK\" && ln -sfn \"$REPO_DIR/SKILL.md\" \"$SKILL_LINK/SKILL.md\""
fi

if [ "$RUN_TEST" = "1" ]; then
  echo
  echo "==> 冒烟测试（会打开一个浏览器 Space）"
  if "$BINDIR/ego-jev" --url "https://en.wikipedia.org/wiki/Main_Page" \
      --text "Jev" --until "/wiki/Japanese_encephalitis" --steps 5 \
      "type Jev into the search box and submit"; then
    echo "==> 冒烟测试通过"
  else
    echo "==> 冒烟测试失败（退出码 $?）——看上面的 reason 字段" >&2
    exit 1
  fi
fi

echo
echo "完成。当前版本: $(version)"
