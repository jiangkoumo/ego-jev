#!/usr/bin/env bash
# 把 ego-jev 技能装到 Agent 的技能目录（**包外**，ego lite 升级不会冲掉）。
#
# 刻意不修改 ego lite 应用包里的任何文件：
# 那是供应商受签名的应用包，升级会替换 Resources/ego-skills 目录，改动必然丢失。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/SKILL.md"
DEST_DIR="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}/ego-jev"

[ -f "$SRC" ] || { echo "错误: 找不到 $SRC" >&2; exit 2; }
mkdir -p "$DEST_DIR"

if [ -e "$DEST_DIR/SKILL.md" ] && [ ! -L "$DEST_DIR/SKILL.md" ]; then
  cp "$DEST_DIR/SKILL.md" "$DEST_DIR/SKILL.md.bak.$(date +%Y%m%d%H%M%S)"
  echo "已备份原有 SKILL.md"
fi
ln -sfn "$SRC" "$DEST_DIR/SKILL.md"
echo "已安装: $DEST_DIR/SKILL.md -> $SRC"
echo
echo "如需卸载：rm -rf \"$DEST_DIR\""
echo "ego lite 升级后无需重做——本技能在应用包之外。"
