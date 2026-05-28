#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# 把 ops/crontab.production install 到生产 ECS 的 root crontab
#
# 流程: 拉 ECS 现有 crontab → 与 git 上的真理对 diff → 用户确认 → install
#
# 安全机制:
#   - 先拉 ECS 当前 crontab 备份到 /tmp/crontab.ecs.backup-<timestamp>
#   - diff 给用户看清楚要加 / 删 / 改的行
#   - 用户敲 yes 才 install
#   - install 失败可立刻用 backup 恢复
#
# 用法:
#   export V4_SSH_PASSWORD='xxx'
#   ./scripts/crontab-install.sh                # 交互式 (推荐)
#   ./scripts/crontab-install.sh --dry-run      # 只 diff 不 install
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

LOCAL_FILE="$ROOT_DIR/ops/crontab.production"
SERVER='root@116.62.32.162'
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

# ── 前置检查 ─────────────────────────────────────
if [ ! -f "$LOCAL_FILE" ]; then
  echo "❌ 未找到 $LOCAL_FILE" >&2
  exit 1
fi
: "${V4_SSH_PASSWORD:?需先 export V4_SSH_PASSWORD=...}"

# ── 1. 拉 ECS 当前 crontab ──────────────────────
TS=$(date +%Y%m%d-%H%M%S)
ECS_FILE="/tmp/crontab.ecs.$TS"
BACKUP_FILE="/tmp/crontab.ecs.backup-$TS"

echo "==> 拉 ECS 当前 crontab → $ECS_FILE"
sshpass -p "$V4_SSH_PASSWORD" ssh $SSH_OPTS "$SERVER" 'crontab -l' > "$ECS_FILE" 2>/dev/null || {
  # crontab 为空时 crontab -l 退 1, 不算错
  echo "" > "$ECS_FILE"
}
cp "$ECS_FILE" "$BACKUP_FILE"
echo "   备份: $BACKUP_FILE"

# ── 2. diff ─────────────────────────────────────
echo ""
echo "==> 与 ops/crontab.production diff"
echo "--- ECS 现状"
echo "+++ git 真理 (ops/crontab.production)"
if diff -u "$ECS_FILE" "$LOCAL_FILE"; then
  echo ""
  echo "✓ ECS crontab 已与 git 一致, 无需 install"
  rm "$ECS_FILE"
  exit 0
fi

# ── 3. dry-run 模式停在这里 ─────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "(dry-run, 未实际 install)"
  rm "$ECS_FILE"
  exit 0
fi

# ── 4. 确认 ─────────────────────────────────────
echo ""
echo "⚠ 上面是要 install 的变更. ECS crontab 会被覆盖."
echo "   备份在 $BACKUP_FILE (失败可恢复: sshpass -p '\$PWD' ssh root@116.62.32.162 'crontab' < $BACKUP_FILE)"
read -p "继续? 敲 yes: " ans
if [ "$ans" != "yes" ]; then
  echo "已取消"
  rm "$ECS_FILE"
  exit 0
fi

# ── 5. install ──────────────────────────────────
echo ""
echo "==> install"
sshpass -p "$V4_SSH_PASSWORD" ssh $SSH_OPTS "$SERVER" 'crontab' < "$LOCAL_FILE"

# ── 6. 验证 ─────────────────────────────────────
echo "==> 验证 ECS crontab 现状"
sshpass -p "$V4_SSH_PASSWORD" ssh $SSH_OPTS "$SERVER" 'crontab -l'

echo ""
echo "✅ 完成. 备份在 $BACKUP_FILE"
rm "$ECS_FILE"
