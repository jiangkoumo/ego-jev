#!/usr/bin/env bash
# ego-jev — 把 Agent 技能目录里的 ego-browser 入口接管成「路由层」，让多步浏览器任务默认走 ego-jev。
#
# 背景：ego lite 会把官方技能写进每个 Agent 的技能目录（~/.agents/skills、~/.claude/skills……），
# 那个位置由 App 管理、升级时会重建；官方正文不知道 ego-jev 存在，于是 Agent 默认照着它写逐步脚本。
# 本脚本把入口换成路由层：技能正文仍是 App 的当前版本（软链跟随，升级自动更新），
# 只是最前面多一条路由规则——多步线性任务先走 `ego-jev`。
#
# 只写 Agent 技能目录，不碰 /Applications 里的应用包；`--restore` 可还原成官方软链。
#
# 用法:
#   scripts/wire-agent-skills.sh [--dry-run] [--check] [--restore] [--if-enabled]
#                                [--dir DIR]... [--vendor DIR]
#
#   （默认动作）接管 / 刷新：把已存在的 ego-browser 入口换成路由层，幂等
#   --check       只读检查：是否已接管、是否漂移（生成物过期 / 入口消失 / 软链断）
#   --restore     还原成接管前的那条软链（不需要 ego lite 还在，逃生口不自锁）
#   --if-enabled  仅当之前接管过（有启用标记）才动手；给 update.sh 用
#   --dry-run     只打印会做什么，不落盘
#
# 退出码: 0 正常 / 1 需要处理（--check 发现漂移；或接管动作没达成） / 2 用法或环境错误
#
# 环境变量（测试用）:
#   EGO_JEV_SKILLS_DIRS  以 : 分隔的技能目录列表，覆盖默认探测
#   EGO_JEV_VENDOR       官方技能目录，覆盖自动探测
#   EGO_JEV_CONFIG_DIR   启用标记目录，默认 ~/.config/ego-jev
#   EGO_JEV_SKILL_PATH   ego-jev 自己的 SKILL.md（写进路由层）
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/overlay/ego-browser/SKILL.md.in"
WIRE_SCRIPT="$REPO_DIR/scripts/wire-agent-skills.sh"
CONFIG_DIR="${EGO_JEV_CONFIG_DIR:-$HOME/.config/ego-jev}"
FLAG_FILE="$CONFIG_DIR/wire-enabled.json"
MARKER_NAME=".ego-jev-overlay.json"
MARKER_MAGIC='"overlay": "ego-jev"'

# 路由说明（进 frontmatter 的 description，是 Agent 选择技能的依据）
ROUTING_NOTE='本入口已由 ego-jev 接管：连续点击、翻页、搜索表单提交、多字段填写、导航跳转这类多步线性任务，先用 `ego-jev` CLI 在单进程内闭环（一条命令，别写逐步脚本）；单步动作、精确 DOM/选择器操作、批量抓取再落到本技能的 ego-browser API。'

MODE="wire"          # wire | check | restore
DRY_RUN=0
IF_ENABLED=0
DIRS_FIXED=0
VENDOR_ARG="${EGO_JEV_VENDOR:-}"
declare -a DIRS=()

info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --restore) MODE="restore"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --if-enabled) IF_ENABLED=1; shift ;;
    --dir) [[ $# -ge 2 && -n "$2" ]] || fail "--dir 需要一个非空目录"; DIRS+=("$2"); DIRS_FIXED=1; shift 2 ;;
    --vendor) [[ $# -ge 2 && -n "$2" ]] || fail "--vendor 需要一个非空目录"; VENDOR_ARG="$2"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
done

# ── 工具 ─────────────────────────────────────────────────────────────────────

# 解析软链（含相对目标）；目录存在时返回物理路径
resolve_path() {
  local p="$1" d depth=0
  while [[ -L "$p" && $depth -lt 40 ]]; do
    d="$(cd "$(dirname "$p")" && pwd -P)" || break
    p="$(readlink "$p")"
    [[ "$p" = /* ]] || p="$d/$p"
    depth=$((depth + 1))
  done
  if [[ -d "$p" ]]; then (cd "$p" && pwd -P); else printf '%s' "$p"; fi
}

# ego lite 的技能目录形状：稳定软链，或 App 版本目录里的 Resources/ego-skills/ego-browser。
# 用它做判据（而不是宽松的 *ego-skills* 通配），避免误伤名字里带 ego-skills 的无关软链；
# 也允许目标暂时不存在（升级窗口里的悬空软链）——那种情况正是要重接管的。
looks_like_ego_vendor_path() {
  local p="$1"
  [[ -n "$p" ]] || return 1
  case "$p" in
    "$HOME/.local/share/ego/ego-skills"|"$HOME/.local/share/ego/ego-skills/"*) return 0 ;;
    "$HOME/.local/share/ego/active_version_dir/Resources/ego-skills/ego-browser"|"$HOME/.local/share/ego/active_version_dir/Resources/ego-skills/ego-browser/"*) return 0 ;;
    */Versions/*/Resources/ego-skills/ego-browser|*/Versions/*/Resources/ego-skills/ego-browser/*) return 0 ;;
  esac
  return 1
}

vendor_frontmatter_field() { # vendor_frontmatter_field <key>：frontmatter 字段允许缩进（App 的 metadata: 下就是缩进的）
  awk -v key="$1" 'NR==1 && $0=="---" {inf=1; next}
       inf && /^---[[:space:]]*$/ {exit}
       inf { line=$0; sub(/^[[:space:]]*/,"",line);
             if (index(line, key ":")==1) { sub("^" key ":[[:space:]]*","",line); gsub(/"/,"",line); print line; exit } }' \
    "$VENDOR/SKILL.md" 2>/dev/null
}

ego_jev_skill_path() {
  if [[ -n "${EGO_JEV_SKILL_PATH:-}" ]]; then printf '%s' "$EGO_JEV_SKILL_PATH"; return; fi
  local cand
  for cand in "$HOME/.agents/skills/ego-jev/SKILL.md" "$REPO_DIR/SKILL.md"; do
    [[ -f "$cand" ]] && { printf '%s' "$cand"; return; }
  done
  printf '%s' "未安装（直接用 ego-jev CLI 即可）"
}

# 生成路由层 SKILL.md 到 stdout（必须确定性：不含时间戳/随机数，否则 --check 会一直误报漂移）
render_overlay() {
  local desc ver date jev line desc_yaml
  desc="$(vendor_frontmatter_field description)"
  ver="$(vendor_frontmatter_field version)"
  date="$(vendor_frontmatter_field date)"
  jev="$(ego_jev_skill_path)"
  [[ -n "$desc" ]] || desc="When you need a browser, read this Skill by default（原描述读取失败，请重跑本脚本）"
  # frontmatter 是 YAML：description 用单引号标量，内部单引号翻倍，换行压成空格。
  # 不这样做的话，厂商描述里一旦出现 ": " 就会让整条技能解析失败（Agent 直接看不到这个技能）。
  desc_yaml="'$(printf '%s %s' "$desc" "$ROUTING_NOTE" | tr '\n' ' ' | sed "s/'/''/g")'"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//'{{DESCRIPTION_YAML}}'/$desc_yaml}"
    line="${line//'{{VENDOR_VERSION}}'/$ver}"
    line="${line//'{{VENDOR_DATE}}'/$date}"
    line="${line//'{{EGO_SKILLS_DIR}}'/$VENDOR}"
    line="${line//'{{EGO_JEV_SKILL}}'/$jev}"
    line="${line//'{{WIRE_SCRIPT}}'/$WIRE_SCRIPT}"
    printf '%s\n' "$line"
  done < "$TEMPLATE"
}

is_our_overlay() { [[ -d "$1" && -f "$1/$MARKER_NAME" ]] && grep -q "$MARKER_MAGIC" "$1/$MARKER_NAME" 2>/dev/null; }

write_marker() {
  local dir="$1" original="$2"
  {
    printf '{\n'
    printf '  "overlay": "ego-jev",\n'
    printf '  "wiredAt": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "original": "%s",\n' "$original"
    printf '  "vendor": "%s",\n' "${VENDOR:-}"
    printf '  "vendorVersion": "%s",\n' "$(vendor_frontmatter_field version)"
    printf '  "wireScript": "%s",\n' "$WIRE_SCRIPT"
    printf '  "restore": "bash %s --restore"\n' "$WIRE_SCRIPT"
    printf '}\n'
  } > "$dir/$MARKER_NAME"
}

marker_field() { # marker_field <file> <key>：按行锚定，避免贪心匹配吃掉后面的字段
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\\(.*\\)\"[[:space:]]*,\{0,1\}[[:space:]]*$/\\1/p" "$1" | head -1
}

# 生成路由层（覆盖已有同名条目由调用方负责）：SKILL.md + 官方各子目录的软链（按现有目录走，不写死名单）
install_overlay() {
  local target="$1" original="$2" sub name
  if [[ -z "$VENDOR" || ! -f "$VENDOR/SKILL.md" ]]; then
    warn "拒绝写路由层：官方技能目录不可用（${VENDOR:-空}）"
    return 1
  fi
  mkdir -p "$target" || return 1
  render_overlay > "$target/SKILL.md" || return 1
  for sub in "$VENDOR"/*/; do
    [[ -e "$sub" ]] || continue
    name="$(basename "$sub")"
    ln -sfn "$VENDOR/$name" "$target/$name" || return 1
  done
  write_marker "$target" "$original"
}

# ── 解析官方技能目录（可以解析不到：--restore 不需要它）────────────────────────

resolve_vendor() {
  local cand
  for cand in "$VENDOR_ARG" \
              "$HOME/.local/share/ego/ego-skills" \
              "$HOME/.local/share/ego/active_version_dir/Resources/ego-skills/ego-browser"; do
    [[ -z "$cand" ]] && continue
    [[ "$cand" = /* ]] || cand="$PWD/$cand"
    # 刻意不解析软链：保留稳定的 ~/.local/share/ego/ego-skills，App 升级会自己改指向；
    # 解析到 Versions/<版本号>/… 的话，升级后生成物就会指向被删掉的旧版本目录。
    [[ -f "$cand/SKILL.md" ]] && { printf '%s' "$cand"; return 0; }
  done
  if command -v ego-browser >/dev/null 2>&1; then
    local helper version_dir
    helper="$(resolve_path "$(command -v ego-browser)")"
    version_dir="$(cd "$(dirname "$helper")/.." && pwd -P)"
    cand="$version_dir/Resources/ego-skills/ego-browser"
    [[ -f "$cand/SKILL.md" ]] && { printf '%s' "$cand"; return 0; }
  fi
  return 1
}

stable_vendor_path() {  # 稳定入口（App 升级会改指向）；用于把失效的旧版本路径修回来
  local cand="$HOME/.local/share/ego/ego-skills"
  [[ -f "$cand/SKILL.md" ]] && printf '%s' "$cand"
}

# ── 目标技能目录 ─────────────────────────────────────────────────────────────

default_dirs() {
  printf '%s\n' "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.codex/skills" \
                "$HOME/.cursor/skills" "$HOME/.kiro/skills"
}

dedup_lines() { awk '!seen[$0]++'; }   # bash 3.2 兼容：不用 nameref/关联数组

flag_dirs() { # 启用标记里记下的目录（可能没有）
  [[ -f "$FLAG_FILE" ]] || return 0
  sed -n 's/.*"dirs"[[:space:]]*:[[:space:]]*\[\(.*\)\].*/\1/p' "$FLAG_FILE" | head -1 |
    tr ',' '\n' | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' |
    grep -v '^$'
}

if [[ $DIRS_FIXED -eq 0 && -n "${EGO_JEV_SKILLS_DIRS:-}" ]]; then
  IFS=':' read -r -a DIRS <<< "$EGO_JEV_SKILLS_DIRS"   # 命令行 --dir 优先于环境变量
  DIRS_FIXED=1
fi

if [[ $IF_ENABLED -eq 1 && ! -f "$FLAG_FILE" ]]; then
  exit 0   # 从没接管过 → 静默跳过（update.sh 用）
fi

if [[ $DIRS_FIXED -eq 0 ]]; then
  DIRS=()
  # 接管过的自定义目录（--dir）也要继续维护，不能只认默认探测
  while IFS= read -r d; do DIRS+=("$d"); done < <( { flag_dirs; default_dirs; } | dedup_lines )
fi

if [[ -f "$TEMPLATE" ]]; then :; else fail "缺少模板: ${TEMPLATE}（本脚本要在 ego-jev 仓库内运行）"; fi

declare -a RECORDED_DIRS=()
if [[ -f "$FLAG_FILE" ]]; then
  while IFS= read -r d; do [[ -n "$d" ]] && RECORDED_DIRS+=("$d"); done < <(flag_dirs)
fi
is_recorded() {   # 这个目录是「我们接管过、并由启用标记记录在案」的（仅默认探测到、没接管过的不算）
  local v
  for v in "${RECORDED_DIRS[@]:-}"; do [[ "$v" == "$1" ]] && return 0; done
  return 1
}

if [[ -n "$VENDOR_ARG" ]]; then
  # 显式指定（--vendor 或 EGO_JEV_VENDOR）就是权威：合法则用它，非法则直接报环境错误，不回退自动探测
  if [[ -f "$VENDOR_ARG/SKILL.md" ]]; then
    VENDOR="$VENDOR_ARG"
  else
    VENDOR=""
    if [[ "$MODE" == "wire" ]]; then
      fail "--vendor 指定的目录里没有 SKILL.md: ${VENDOR_ARG}（不会回退自动探测；去掉 --vendor 或改对环境变量）"
    fi
    warn "--vendor 指定的目录里没有 SKILL.md: ${VENDOR_ARG}（不回退自动探测）"
  fi
else
  VENDOR="$(resolve_vendor || true)"
fi
VENDOR_REAL=""
[[ -n "$VENDOR" ]] && VENDOR_REAL="$(resolve_path "$VENDOR")"

if [[ "$MODE" == "wire" && -z "$VENDOR" ]]; then
  any_overlay=0
  for dir in "${DIRS[@]}"; do is_our_overlay "$dir/ego-browser" && any_overlay=1; done
  if [[ $any_overlay -eq 0 ]]; then
    fail "找不到 ego lite 的官方技能目录（SKILL.md）。安装 ego lite 后重试，或用 --vendor 指定。"
  fi
  warn "找不到 ego lite 的官方技能目录：本次只能报告状态，不能刷新（装好 ego lite 后重跑）"
fi

# ── 三个动作 ─────────────────────────────────────────────────────────────────

had_drift=0
n_overlay=0
n_skipped=0
n_failed=0
did_something=0
declare -a WIRED_DIRS=()

wire_one() {
  local dir="$1" target="$dir/ego-browser" original raw
  if is_our_overlay "$target"; then
    if [[ -z "$VENDOR" ]]; then
      warn "跳过 ${target}（ego lite 技能目录找不到，无法校验/刷新；装好 ego lite 后重跑）"
      n_skipped=$((n_skipped + 1)); return
    fi
    if [[ "$(render_overlay)" == "$(cat "$target/SKILL.md")" ]]; then
      info "已接管且最新: ${target}"
    elif [[ $DRY_RUN -eq 1 ]]; then
      info "[dry-run] 刷新: ${target}（生成物过期，例如 ego lite 升级过）"
    else
      install_overlay "$target" "$(marker_field "$target/$MARKER_NAME" original)" || { n_failed=$((n_failed + 1)); return; }
      info "已刷新: ${target}（生成物过期，例如 ego lite 升级过）"
    fi
    n_overlay=$((n_overlay + 1)); did_something=1; WIRED_DIRS+=("$dir"); return
  fi
  if [[ -L "$target" ]]; then
    raw="$(readlink "$target")"
    if [[ -z "$VENDOR" ]]; then
      # 官方目录解析不到：绝不能写盘——install_overlay 的 "$VENDOR"/*/ 会变成 /*/，
      # 把文件系统根下的目录全软链进技能目录。只报告。
      warn "跳过（找不到 ego lite 技能目录，不接管）: ${target} → ${raw}"
      n_skipped=$((n_skipped + 1)); return
    fi
    if looks_like_ego_vendor_path "$raw" || [[ "$(resolve_path "$target")" == "$VENDOR_REAL" ]]; then
      if [[ $DRY_RUN -eq 1 ]]; then info "[dry-run] 接管: ${target}（原软链 → ${raw}）"; return; fi
      rm -f "$target"                      # 只删这条软链，不碰它指向的目录
      install_overlay "$target" "$raw" || { n_failed=$((n_failed + 1)); return; }
      info "已接管: ${target}（原软链 → ${raw}）"
      n_overlay=$((n_overlay + 1)); did_something=1; WIRED_DIRS+=("$dir"); return
    fi
    warn "跳过（软链指向别处，不是 ego lite 技能）: ${target} → ${raw}"
    n_skipped=$((n_skipped + 1)); return
  fi
  if [[ -d "$target" ]]; then
    warn "跳过（普通目录，不是我们的路由层，不覆盖——若这是官方技能的一份拷贝，请手工处理）: ${target}"
    n_skipped=$((n_skipped + 1)); return
  fi
  if [[ -d "$dir" ]]; then
    if [[ -n "$VENDOR" ]] && is_recorded "$dir"; then
      # 官方正文在、这个目录也确实是「我们接管过」的，只是入口没了（升级窗口 / 被删）→ 按启用意图重建
      # 启用过、官方正文也在，只是入口没了（升级窗口 / 被删）→ 按启用意图重建
      original="$(stable_vendor_path)"
      [[ -n "$original" ]] || original="$VENDOR"
      if [[ $DRY_RUN -eq 1 ]]; then
        info "[dry-run] 重建入口: ${target}（入口不存在，原目标按稳定入口 ${original}）"
      elif install_overlay "$target" "$original"; then
        info "已重建入口: ${target}（之前接管过，但入口消失了）"
        n_overlay=$((n_overlay + 1)); did_something=1; WIRED_DIRS+=("$dir")
      else
        n_failed=$((n_failed + 1))
      fi
      return
    fi
    info "跳过（目录里没有 ego-browser 入口）: ${dir}"
  else
    info "跳过（目录不存在）: ${dir}"
  fi
  n_skipped=$((n_skipped + 1))
}

check_one() {
  local dir="$1" target="$dir/ego-browser" sub missing=0 raw
  if is_our_overlay "$target"; then
    if [[ -z "$VENDOR" ]]; then
      warn "漂移  ${target}（ego lite 技能目录找不到：无法校验/刷新，装好后重跑本脚本）"; had_drift=1
      return
    fi
    for sub in "$VENDOR"/*/; do
      [[ -e "$sub" ]] || continue
      [[ -e "$target/$(basename "$sub")" ]] || missing=1   # 软链断了：通常指向被删掉的旧版本目录
    done
    if [[ $missing -eq 1 ]]; then
      warn "漂移  ${target}（官方子目录软链已失效：ego lite 升级删掉了旧版本目录，重跑本脚本）"; had_drift=1
    elif [[ "$(render_overlay)" == "$(cat "$target/SKILL.md")" ]]; then
      info "OK    ${target}（路由层，生成物最新）"
    else
      warn "漂移  ${target}（生成物过期：ego lite 升级过，重跑本脚本刷新）"; had_drift=1
    fi
    return
  fi
  if [[ -L "$target" ]]; then
    raw="$(readlink "$target")"
    if looks_like_ego_vendor_path "$raw" || [[ -n "$VENDOR" && "$(resolve_path "$target")" == "$VENDOR_REAL" ]]; then
      if [[ -e "$target" ]]; then
        warn "未接管  ${target}（还是官方软链：重跑本脚本接管）"
      else
        warn "漂移  ${target}（软链断向 ${raw}：升级窗口，重跑本脚本接管）"
      fi
    else
      warn "未知  ${target}（软链指向别处，不是 ego lite 技能）: → ${raw}"
    fi
    had_drift=1
    return
  fi
  if [[ -e "$target" ]]; then
    warn "未知  ${target}（既不是我们的路由层，也不是官方软链）"; had_drift=1
    return
  fi
  if [[ -d "$dir" ]] && is_recorded "$dir"; then
    warn "漂移  ${dir}（接管过，但 ego-browser 入口不见了：重跑本脚本）"; had_drift=1
    return
  fi
  info "跳过  ${dir}（没有 ego-browser 入口）"
}

restore_one() {
  local dir="$1" target="$dir/ego-browser" original stable
  if ! is_our_overlay "$target"; then
    info "无需还原: ${target}"
    return
  fi
  original="$(marker_field "$target/$MARKER_NAME" original)"
  if [[ -z "$original" ]]; then
    warn "跳过 ${target}：标记文件里没记下原始软链目标，请手工恢复"
    n_failed=$((n_failed + 1)); return
  fi
  if [[ ! -e "$original" ]]; then
    # 记的是版本号物理路径、而那个版本已被删：改回稳定入口，别还原成一条断链。
    # 相对软链要相对入口所在目录判断，不能拿进程 CWD 当基准。
    local orig_abs="$original"
    case "$original" in
      /*) ;;
      *) orig_abs="$(cd "$(dirname "$target")" && pwd -P)/$original" ;;
    esac
    if [[ -e "$orig_abs" ]]; then
      :   # 原目标其实还在（只是相对路径）——按原样还原
    else
      stable="$(stable_vendor_path)"
      if [[ -n "$stable" ]]; then
        info "原目标已失效（${original}）→ 还原到稳定入口 ${stable}"
        original="$stable"
      fi
    fi
  fi
  if [[ $DRY_RUN -eq 1 ]]; then info "[dry-run] 还原: 删目录 ${target} → 重建软链 ${original}"; return; fi
  rm -rf "$target"          # 显式路径：只在确认是本公司生成的路由层后执行
  ln -sfn "$original" "$target"
  info "已还原: ${target} → ${original}"
  did_something=1
}

echo "==> ego-jev 路由接管（${MODE}）"
info "官方技能: ${VENDOR:-（未找到）}"

for dir in "${DIRS[@]}"; do
  case "$MODE" in
    wire) wire_one "$dir" ;;
    check) check_one "$dir" ;;
    restore) restore_one "$dir" ;;
  esac
done

case "$MODE" in
  check)
    echo
    if [[ $had_drift -eq 0 ]]; then
      echo "==> 检查通过：所有 ego-browser 入口都已接管且最新"
      exit 0
    fi
    echo "==> 发现需要处理的情况（见上）：能修的用 \`bash $WIRE_SCRIPT\` 重跑；官方技能是拷贝目录时脚本不会覆盖，需人工处理" >&2
    exit 1
    ;;
  restore)
    if [[ $DRY_RUN -eq 0 && -f "$FLAG_FILE" ]]; then
      left=0
      for dir in "${DIRS[@]}"; do is_our_overlay "$dir/ego-browser" && left=1; done
      if [[ $left -eq 0 ]]; then
        rm -f "$FLAG_FILE"
        info "已清掉启用标记: ${FLAG_FILE}"
      fi
    fi
    exit $(( n_failed > 0 ? 1 : 0 ))
    ;;
esac

if [[ $DRY_RUN -eq 0 && $did_something -eq 1 ]]; then
  mkdir -p "$CONFIG_DIR"
  merged=()
  while IFS= read -r d; do merged+=("$d"); done < <( { flag_dirs; printf '%s\n' "${WIRED_DIRS[@]:-}"; } | grep -v '^$' | dedup_lines )
  {
    printf '{\n'
    printf '  "enabled": true,\n'
    printf '  "wiredAt": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "vendor": "%s",\n' "${VENDOR_REAL:-}"
    printf '  "dirs": ['
    first=1
    for d in "${merged[@]}"; do [[ $first -eq 0 ]] && printf ', '; printf '"%s"' "$d"; first=0; done
    printf '],\n'
    printf '  "restore": "bash %s --restore"\n' "$WIRE_SCRIPT"
    printf '}\n'
  } > "$FLAG_FILE"
fi

echo
if [[ $n_overlay -gt 0 ]]; then
  echo "已接管 ${n_overlay} 个入口：多步线性任务先走 ego-jev，其余仍按官方 ego-browser API。"
  echo "技能正文照旧从 App 当前版本读取（软链跟随升级）；新开的 Agent 会话才会看到这层路由。"
fi
if [[ $n_skipped -gt 0 ]]; then
  warn "有 ${n_skipped} 个目录没接管（见上）——那些 Agent 仍会走官方正文；--dry-run 可先预览。"
fi
if [[ $DRY_RUN -eq 0 && $did_something -eq 1 ]]; then
  info "启用标记: ${FLAG_FILE}（ego 升级后 update.sh 会据此自动重接管）"
  info "还原官方软链: bash ${WIRE_SCRIPT} --restore"
fi
if [[ $n_failed -gt 0 ]]; then
  warn "有 ${n_failed} 个入口操作失败（见上）"
  exit 1
fi
if [[ $DRY_RUN -eq 0 && $n_overlay -eq 0 ]]; then
  exit 1   # 一个都没接管：让 install.sh --wire / update.sh 能发现
fi
exit 0
