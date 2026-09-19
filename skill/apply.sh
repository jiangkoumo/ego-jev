#!/usr/bin/env bash
# 把 ego-jev 章节追加/更新进 ego-browser skill 的 SKILL.md。
#
# 注意：ego lite 的 skill 是应用包内的符号链接目标，升级 ego lite 会替换该目录，
# 因此每次升级后需要重新运行本脚本。脚本会先备份原文件。
set -euo pipefail

SECTION="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ego-jev-section.md"
SKILL="${EGO_BROWSER_SKILL:-$HOME/.agents/skills/ego-browser/SKILL.md}"

[ -f "$SECTION" ] || { echo "错误: 找不到章节文件 $SECTION" >&2; exit 2; }
[ -f "$SKILL" ]   || { echo "错误: 找不到 skill 文件 $SKILL（ego lite 是否已安装？）" >&2; exit 2; }

REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$SKILL")"
BACKUP="${REAL}.bak.$(date +%Y%m%d%H%M%S)"
cp "$REAL" "$BACKUP"
echo "已备份: $BACKUP"
echo "真实落点: $REAL"

python3 - "$REAL" "$SECTION" <<'PY'
import re, sys, pathlib
target, section = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
text = target.read_text(encoding="utf-8")
block = section.rstrip() + "\n\n"

# 已有同名章节则就地替换，否则插到 "## References" 之前（没有该标题就追加到末尾）
pattern = re.compile(r"^## ⚡ Jev .*?(?=^## |\Z)", re.S | re.M)
if pattern.search(text):
    new = pattern.sub(block, text, count=1)
    action = "已更新现有章节"
elif "## References" in text:
    idx = text.index("## References")
    new = text[:idx] + block + text[idx:]
    action = "已插入到 ## References 之前"
else:
    new = text.rstrip() + "\n\n" + block
    action = "已追加到文件末尾"

target.write_text(new, encoding="utf-8")
print(action)
PY

echo "完成。若签名或应用行为异常，可用上面的备份还原。"
