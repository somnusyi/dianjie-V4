#!/bin/bash
# ══════════════════════════════════════════════════════
# 滇界 V4 · 紧急回滚脚本
# 用最近一次 deploy 之前的 build + DB 备份恢复
# ══════════════════════════════════════════════════════
#
# 用法:
#   ./scripts/rollback.sh              # 回滚到最近一次 build 备份
#   ./scripts/rollback.sh <tag>        # 回滚到指定 tag, e.g. 20260513-103000
#   ./scripts/rollback.sh --list       # 列出可用备份
#   ./scripts/rollback.sh --with-db    # 同时回滚 DB（注意：会丢失最近 deploy 后的所有数据写入）
#
# 前置:
#   export V4_SSH_PASSWORD='xxx'
#   export V4_DB_PASSWORD='xxx'
# ══════════════════════════════════════════════════════

set -euo pipefail

SERVER="root@116.62.32.162"
REMOTE_BASE="/app/dianjie-v4"

: "${V4_SSH_PASSWORD:?需先 export V4_SSH_PASSWORD=...}"

# ── 解析参数 ────────────────────────────────────────
ACTION=""
TAG=""
WITH_DB=0
for arg in "$@"; do
  case "$arg" in
    --list)    ACTION="list" ;;
    --with-db) WITH_DB=1 ;;
    --*)       ;;
    *)         TAG="$arg" ;;
  esac
done

# ── --list ──────────────────────────────────────────
if [ "$ACTION" = "list" ]; then
  echo "==> 可回滚的 build 备份："
  sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" \
    'ls -lh /app/backups/v4-build-bak-*.tar.gz 2>/dev/null'
  echo ""
  echo "==> 可恢复的 DB 备份："
  sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" \
    'ls -lh /app/backups/dianjie_v4-deploy-bak-*.dump 2>/dev/null'
  exit 0
fi

# ── 确认 TAG ────────────────────────────────────────
if [ -z "$TAG" ]; then
  TAG=$(sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" \
    'ls -t /app/backups/v4-build-bak-*.tar.gz 2>/dev/null | head -1 | xargs -I{} basename {} .tar.gz | sed "s/^v4-build-bak-//"')
  if [ -z "$TAG" ]; then
    echo "❌ 没有任何 build 备份"
    exit 1
  fi
fi

BUILD_TARBALL="/app/backups/v4-build-bak-${TAG}.tar.gz"
DB_DUMP="/app/backups/dianjie_v4-deploy-bak-${TAG}.dump"

echo "════════════════════════════════════════"
echo "  滇界 V4 回滚到 $TAG"
if [ $WITH_DB -eq 1 ]; then
  echo "  ⚠️  含 DB 回滚！会丢失 $TAG 之后的所有数据写入"
fi
echo "════════════════════════════════════════"
read -p "确认? (yes/N) " ans
[ "$ans" = "yes" ] || { echo "已取消"; exit 1; }

# ── Step 1: 解 build 备份 ────────────────────────────
echo ""
echo "==> [1/3] 恢复 build 产物"
sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" bash <<EOF
set -e
[ -f $BUILD_TARBALL ] || { echo "❌ $BUILD_TARBALL 不存在"; exit 1; }
cd $REMOTE_BASE
tar -xzf $BUILD_TARBALL
echo "✓ 已展开 $BUILD_TARBALL"
EOF

# ── Step 2: DB 回滚（可选）────────────────────────────
if [ $WITH_DB -eq 1 ]; then
  : "${V4_DB_PASSWORD:?--with-db 需先 export V4_DB_PASSWORD=...}"
  echo ""
  echo "==> [2/3] 恢复 DB（pg_restore --clean）"
  sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" bash <<EOF
set -e
[ -f $DB_DUMP ] || { echo "❌ $DB_DUMP 不存在"; exit 1; }
PGPASSWORD='$V4_DB_PASSWORD' pg_restore \\
  -h pgm-bp14m7g69y66165r.pg.rds.aliyuncs.com -U dianjie_v4 -d dianjie_v4 \\
  --clean --if-exists --no-owner --no-acl --single-transaction \\
  $DB_DUMP 2>&1 | tail -20
echo "✓ DB 恢复完成"
EOF
else
  echo ""
  echo "==> [2/3] 跳过 DB 回滚（如需 → 加 --with-db）"
fi

# ── Step 3: pm2 reload ──────────────────────────────
echo ""
echo "==> [3/3] pm2 reload"
sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" '
  pm2 reload dianjie-v4-api dianjie-v4-web --update-env
  sleep 3
  pm2 list | grep -E "name|dianjie-v4"
'

# ── 验收 ────────────────────────────────────────
echo ""
sleep 5
HEALTH=$(curl -sf https://www.njdianjie.com/api/health || echo "FAIL")
if [[ "$HEALTH" == FAIL* ]]; then
  echo "❌ 回滚后 /api/health 仍失败 — 手工 ssh 上去看 pm2 log"
  exit 1
fi
echo "✅ 回滚完成: $HEALTH"
