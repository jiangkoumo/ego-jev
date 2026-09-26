#!/usr/bin/env bash
# ego-decision-layer 迁移脚本：把 0.3.x（旧名 ego-jev）留下的本地残留一次做完。
#
# 幂等：再跑一次是 no-op；--dry-run 只打印将要做的事，不写任何文件。
# 顺序很重要（先用旧路径还原，再改身份，再用新名重建）：
#   1. 旧接管状态先 --restore（清路由层 + always-on 块 + 启用标记 + opt-out）
#   2. 记下旧 always-on.list 里的文件（还原会清掉 list，先备份清单）
#   3. 旧技能软链删除 → 建新名的同款软链；~/.local/bin 更新入口（含历史垫片）
#   4. 配置目录迁移 ~/.config/ego-jev → ~/.config/ego-decision-layer
#   5. 用新名重新接管；把第 2 步记下的文件重新插块
#   6. 自检（--check / --route-status）
#
# 用法: scripts/rename-self.sh [--dry-run]
# 退出码: 0 正常（含幂等 no-op）/ 2 用法错误
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIRE="$REPO_DIR/scripts/wire-agent-skills.sh"
NEW_CLI="$REPO_DIR/scripts/ego-decision-layer"
OLD_SHIM="$REPO_DIR/scripts/ego-jev"            # 历史入口垫片（旧名）
OLD_NAME="ego-jev"                              # 旧名
NEW_NAME="ego-decision-layer"
OLD_CONFIG="$HOME/.config/$OLD_NAME"            # 旧配置目录
NEW_CONFIG="$HOME/.config/$NEW_NAME"
BINDIR="${BINDIR:-$HOME/.local/bin}"

DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
do_run() { [[ "$DRY" == "1" ]] && return 0; "$@"; }
plan() { if [[ "$DRY" == "1" ]]; then printf '  [dry-run] %s\n' "$*"; else printf '  %s\n' "$*"; fi; }

# 只在需要时建/改软链，保证幂等（不触碰已正确的软链）
link_to() {  # <target> <linkpath>
  local target="$1" link="$2"
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then return 0; fi
  plan "软链: $link -> $target"
  do_run mkdir -p "$(dirname "$link")"
  do_run ln -sfn "$target" "$link"
}

in_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

[[ -f "$WIRE" ]] || { echo "错误: 找不到 $WIRE" >&2; exit 2; }
[[ -f "$NEW_CLI" ]] || { echo "错误: 找不到新 CLI $NEW_CLI" >&2; exit 2; }

say "==> ego-decision-layer 本地迁移"
[[ "$DRY" == "1" ]] && say "    （dry-run：只打印，不写任何文件）"

# ── 0. 先读旧 always-on 清单（--restore 会清掉它）─────────────────────────────
AO_FILES=""
if [[ -f "$OLD_CONFIG/always-on.list" ]]; then
  AO_FILES="$(grep -v '^[[:space:]]*$' "$OLD_CONFIG/always-on.list" 2>/dev/null || true)"
fi

# ── 1. 旧接管状态：用旧路径还原 ───────────────────────────────────────────────
say
say "==> 1/6 还原旧接管状态（旧配置目录仍在，先清干净）"
if [[ -d "$OLD_CONFIG" ]]; then
  plan "bash $WIRE --restore（清路由层 + always-on 块 + 启用标记 + opt-out）"
  do_run bash "$WIRE" --restore >/dev/null 2>&1 || warn "--restore 有非零退出（继续）"
else
  note "没有旧配置目录，跳过还原"
fi

# ── 2. always-on 清单备份（打印用；真正的重插在第 5 步）────────────────────────
if [[ -n "$AO_FILES" ]]; then
  say
  say "==> 2/6 记录旧 always-on 文件（还原后会丢，稍后用新名重插）"
  printf '%s\n' "$AO_FILES" | while IFS= read -r f; do [[ -n "$f" ]] && note "$f"; done
fi

# ── 3. 技能软链 + PATH 入口 ──────────────────────────────────────────────────
say
say "==> 3/6 重建技能软链与 PATH 入口"
SKILL_DIRS="$HOME/.agents/skills $HOME/.claude/skills $HOME/.codex/skills $HOME/.cursor/skills $HOME/.kiro/skills"
if [[ -n "${EGO_JEV_SKILLS_DIRS:-}" ]]; then
  SKILL_DIRS="$(printf '%s' "$EGO_JEV_SKILLS_DIRS" | tr ':' ' ')"
fi
for sd in $SKILL_DIRS; do
  old_link="$sd/$OLD_NAME"
  new_link="$sd/$NEW_NAME"
  target="$REPO_DIR"
  if [[ -L "$old_link" ]]; then
    target="$(readlink "$old_link")"
    plan "删除旧技能软链: ${old_link}（原指向 ${target}）"
    do_run rm -f "$old_link"
  elif [[ -d "$old_link" ]]; then
    warn "跳过 ${old_link}：是普通目录（拷贝安装？），不自动删——请手工处理"
  fi
  if [[ -d "$sd" ]]; then
    link_to "$target" "$new_link"
  fi
done

if [[ -d "$BINDIR" ]] && in_path "$BINDIR"; then
  link_to "$NEW_CLI" "$BINDIR/$NEW_NAME"
  link_to "$OLD_SHIM" "$BINDIR/$OLD_NAME"
else
  note "跳过 PATH 入口：$BINDIR 不存在或不在 PATH 中"
fi

# ── 4. 配置目录迁移 ─────────────────────────────────────────────────────────
say
say "==> 4/6 迁移配置目录 $OLD_CONFIG -> $NEW_CONFIG"
if [[ -d "$OLD_CONFIG" && ! -e "$NEW_CONFIG" ]]; then
  plan "mv $OLD_CONFIG $NEW_CONFIG"
  do_run mv "$OLD_CONFIG" "$NEW_CONFIG"
elif [[ -d "$OLD_CONFIG" && -d "$NEW_CONFIG" ]]; then
  for entry in "$OLD_CONFIG"/* "$OLD_CONFIG"/.[!.]*; do
    [[ -e "$entry" ]] || continue
    name="$(basename "$entry")"
    if [[ ! -e "$NEW_CONFIG/$name" ]]; then
      plan "合并: $entry -> $NEW_CONFIG/$name"
      do_run mv "$entry" "$NEW_CONFIG/$name"
    fi
  done
  plan "旧目录留一份备份: $OLD_CONFIG -> $OLD_CONFIG.bak"
  do_run rm -rf "$OLD_CONFIG.bak"
  do_run mv "$OLD_CONFIG" "$OLD_CONFIG.bak"
else
  note "没有旧配置目录（或已迁移过），跳过"
fi

# ── 5. 用新名重新接管 + 重插 always-on ──────────────────────────────────────
say
say "==> 5/6 用新名重新接管 + 重插 always-on"
# 幂等：已是最新（--check exit 0）且不在 opt-out 状态时不重跑 wire（wire 每次会重写启用标记）
NEED_WIRE=1
if [[ "$DRY" == "0" ]] && [[ ! -f "$NEW_CONFIG/opted-out" ]] && bash "$WIRE" --check >/dev/null 2>&1; then
  NEED_WIRE=0
  note "接管已是最新（--check exit 0），跳过 wire"
fi
if [[ "$NEED_WIRE" == "1" ]]; then
  plan "bash $WIRE"
  do_run bash "$WIRE" >/dev/null 2>&1 || warn "接管有非零退出（可能没装 ego lite；见上一步输出）"
fi
if [[ -n "$AO_FILES" ]]; then
  printf '%s\n' "$AO_FILES" | while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    # 幂等：新标记的块已在位且没有旧标记块，就跳过（不再重写，避免 mtime 漂移）
    if [[ -f "$f" ]] && grep -qF '<!-- ego-decision-layer:route begin -->' "$f" 2>/dev/null \
       && ! grep -qF '<!-- ego-jev:route begin -->' "$f" 2>/dev/null; then   # 旧标记判断（兼容）
      note "always-on 块已在新标记下在位，跳过: $f"
      continue
    fi
    plan "bash $WIRE --always-on $f"
    do_run bash "$WIRE" --always-on "$f" >/dev/null 2>&1 || warn "--always-on $f 失败"
  done
fi

# ── 6. 自检 ─────────────────────────────────────────────────────────────────
say
say "==> 6/6 自检"
if [[ "$DRY" == "1" ]]; then
  say "  （dry-run 到此为止；未执行 --check / --route-status）"
  exit 0
fi
bash "$WIRE" --check
CHK=$?
note "wire --check exit=$CHK"
if bash "$NEW_CLI" --route-status >/dev/null 2>&1; then
  note "新 CLI --route-status exit=0"
else
  warn "新 CLI --route-status 非零退出"
fi
say
if [[ $CHK -eq 0 ]]; then
  say "迁移完成：已用 $NEW_NAME 接管，新开的 Agent 会话才会看到。"
else
  warn "迁移执行完，但 --check 非 0：看上面原因（通常是没装 ego lite / 官方入口是拷贝目录）。"
fi
exit 0
