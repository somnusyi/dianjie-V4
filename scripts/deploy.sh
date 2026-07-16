#!/bin/bash
# ══════════════════════════════════════════════════════
# 滇界 V4 · 标准部署脚本
# 流程: 预检 → 构建 → 备份 → 上传 → migrate → reload → 验收
# ══════════════════════════════════════════════════════
#
# 用法:
#   ./scripts/deploy.sh                    # 完整流程
#   ./scripts/deploy.sh --skip-tests       # 跳过 smoke test（紧急回滚后快速验证用）
#   ./scripts/deploy.sh --dry-run          # 只打印步骤不执行
#
# 前置:
#   export V4_SSH_PASSWORD='xxx'       # ECS root 密码
#   export V4_DB_PASSWORD='xxx'        # RDS dianjie_v4 密码
#   （或将 SSH key 配到 root@116.62.32.162 免密 + 把 RDS 密码写到 ~/.pgpass）
# ══════════════════════════════════════════════════════

set -euo pipefail

# ── 解析参数 ────────────────────────────────────────
SKIP_TESTS=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
  esac
done

run() {
  if [ $DRY_RUN -eq 1 ]; then
    echo "[DRY-RUN] $*"
  else
    eval "$@"
  fi
}

# ── 路径常量 ────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER="root@116.62.32.162"
REMOTE_BASE="/app/dianjie-v4"

: "${V4_SSH_PASSWORD:?需先 export V4_SSH_PASSWORD=...}"
: "${V4_DB_PASSWORD:?需先 export V4_DB_PASSWORD=...}"

cd "$ROOT_DIR"

# ══════════════════════════════════════════════════════
# 0. 预检
# ══════════════════════════════════════════════════════
echo "════════════════════════════════════════"
echo "  滇界 V4 部署 $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════"

echo "==> [0/7] 预检"

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ git 有未提交改动，请先 commit 或 stash:"
  git status --short
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "⚠️  当前分支: $CURRENT_BRANCH (不是 main)"
  read -p "确认部署 $CURRENT_BRANCH 到生产? (yes/N) " ans
  [ "$ans" = "yes" ] || { echo "已取消"; exit 1; }
fi

# 检测远程比本地新（避免覆盖别人 commit）
git fetch origin "$CURRENT_BRANCH" 2>/dev/null || true
BEHIND=$(git rev-list --count HEAD..origin/$CURRENT_BRANCH 2>/dev/null || echo 0)
if [ "$BEHIND" -gt 0 ]; then
  echo "❌ 本地落后 origin/$CURRENT_BRANCH $BEHIND 个 commit，请先 git pull"
  exit 1
fi

GIT_SHA=$(git rev-parse --short HEAD)
echo "   分支=$CURRENT_BRANCH commit=$GIT_SHA"

# ══════════════════════════════════════════════════════
# 1. 本地构建
# ══════════════════════════════════════════════════════
echo ""
echo "==> [1/7] 安装依赖 + 构建"
run "pnpm install --frozen-lockfile"
run "pnpm --filter @dianjie/db exec prisma generate"
run "pnpm --filter @dianjie/api test"
run "pnpm --filter @dianjie/api build"
run "pnpm --filter @dianjie/web exec tsc --noEmit"
run "pnpm --filter @dianjie/web build"

# 校验产物存在
[ -d apps/api/dist ] || { echo "❌ apps/api/dist 不存在"; exit 1; }
[ -d apps/web/.next/standalone ] || { echo "❌ apps/web/.next/standalone 不存在"; exit 1; }

# ══════════════════════════════════════════════════════
# 2. 备份生产 DB
# ══════════════════════════════════════════════════════
echo ""
echo "==> [2/7] 备份生产 DB"
run "bash '$SCRIPT_DIR/backup-db.sh'"

# 2026-07 P0 one-time guard: the historical drift migration must be baselined
# after the production fingerprint check, otherwise migrate deploy will fail on
# objects that already exist in the legacy database.
if [ -d packages/db/prisma/migrations/20260715101500_reconcile_schema_drift ]; then
  BASELINE_COUNT=$(sshpass -p "$V4_SSH_PASSWORD" ssh -o StrictHostKeyChecking=no "$SERVER" '
    DB_URL=$(grep -E "^DATABASE_URL=" /app/dianjie-v4/.env | head -1 | cut -d= -f2-)
    DB_URL_PG=$(printf "%s" "$DB_URL" | sed "s/?[^?]*$//")
    psql "$DB_URL_PG" -X -Atc "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='"'"'20260715101500_reconcile_schema_drift'"'"' AND finished_at IS NOT NULL AND rolled_back_at IS NULL"
  ')
  if [ "$BASELINE_COUNT" != "1" ]; then
    echo "❌ 生产历史漂移迁移尚未完成安全 baseline，停止上传。"
    echo "   先执行: ./scripts/prepare-production-p0-baseline.sh"
    echo "   在已批准窗口和新备份后再显式执行 --apply-baseline。"
    exit 1
  fi
fi

# ══════════════════════════════════════════════════════
# 3. 备份当前部署产物（用于回滚）
# ══════════════════════════════════════════════════════
echo ""
echo "==> [3/7] 备份当前部署产物"
TS=$(date +%Y%m%d-%H%M%S)
run "sshpass -p \"\$V4_SSH_PASSWORD\" ssh -o StrictHostKeyChecking=no \"$SERVER\" '
  cd /app/backups
  tar -czf v4-build-bak-${TS}.tar.gz \\
    -C $REMOTE_BASE \\
    apps/api/dist \\
    apps/web/.next \\
    apps/web/server.js \\
    packages/db/prisma 2>/dev/null
  ls -lh v4-build-bak-${TS}.tar.gz
  find . -name \"v4-build-bak-*.tar.gz\" -mtime +30 -delete
'"

# ══════════════════════════════════════════════════════
# 4. 上传新产物
# ══════════════════════════════════════════════════════
echo ""
echo "==> [4/7] rsync 上传"

# API: dist/ → /app/dianjie-v4/apps/api/dist/
run "sshpass -p \"\$V4_SSH_PASSWORD\" rsync -avz --delete \\
  -e 'ssh -o StrictHostKeyChecking=no' \\
  apps/api/dist/ \\
  $SERVER:$REMOTE_BASE/apps/api/dist/"

# Web standalone: .next/standalone/ + .next/static/ + public/
# standalone 输出会把 server.js + node_modules 都打包进去
run "sshpass -p \"\$V4_SSH_PASSWORD\" rsync -avz --delete \\
  -e 'ssh -o StrictHostKeyChecking=no' \\
  apps/web/.next/standalone/apps/web/ \\
  $SERVER:$REMOTE_BASE/apps/web/apps/web/"

run "sshpass -p \"\$V4_SSH_PASSWORD\" rsync -avz \\
  -e 'ssh -o StrictHostKeyChecking=no' \\
  apps/web/.next/static/ \\
  $SERVER:$REMOTE_BASE/apps/web/apps/web/.next/static/"

run "sshpass -p \"\$V4_SSH_PASSWORD\" rsync -avz \\
  -e 'ssh -o StrictHostKeyChecking=no' \\
  apps/web/public/ \\
  $SERVER:$REMOTE_BASE/apps/web/apps/web/public/"

# Prisma schema + migrations
run "sshpass -p \"\$V4_SSH_PASSWORD\" rsync -avz --delete \\
  -e 'ssh -o StrictHostKeyChecking=no' \\
  packages/db/prisma/ \\
  $SERVER:$REMOTE_BASE/packages/db/prisma/"

# ══════════════════════════════════════════════════════
# 5. 应用 DB migrations
# ══════════════════════════════════════════════════════
echo ""
echo "==> [5/7] prisma migrate deploy（生产）"
run "sshpass -p \"\$V4_SSH_PASSWORD\" ssh -o StrictHostKeyChecking=no \"$SERVER\" '
  cd $REMOTE_BASE/packages/db
  DATABASE_URL=\"postgresql://dianjie_v4:\$V4_DB_PASSWORD_ENC@pgm-bp14m7g69y66165r.pg.rds.aliyuncs.com:5432/dianjie_v4?connection_limit=3&pool_timeout=20\" \\
    npx prisma migrate deploy
' V4_DB_PASSWORD_ENC=$(python3 -c \"import urllib.parse; print(urllib.parse.quote('\$V4_DB_PASSWORD'))\")"

# ══════════════════════════════════════════════════════
# 6. PM2 reload
# ══════════════════════════════════════════════════════
echo ""
echo "==> [6/7] pm2 reload"
run "sshpass -p \"\$V4_SSH_PASSWORD\" ssh -o StrictHostKeyChecking=no \"$SERVER\" '
  pm2 reload dianjie-v4-api dianjie-v4-web --update-env
  sleep 3
  pm2 list | grep -E \"name|dianjie-v4\"
'"

# ══════════════════════════════════════════════════════
# 7. 验收（smoke test）
# ══════════════════════════════════════════════════════
echo ""
echo "==> [7/7] 验收"
sleep 5  # 给进程 warm-up

# 最低限度: health check
HEALTH=$(curl -sf https://app.dianjie.cc/api/health || echo "FAIL")
if [[ "$HEALTH" == FAIL* ]]; then
  echo "❌ /api/health 失败 — 立即回滚！"
  echo "   ./scripts/rollback.sh"
  exit 1
fi
echo "   /api/health: $HEALTH"

if [ $SKIP_TESTS -eq 0 ]; then
  bash "$SCRIPT_DIR/smoke-test.sh" "https://app.dianjie.cc" || {
    echo "❌ Smoke test 失败，发布不记为成功。请立即评估回滚:"
    echo "   ./scripts/rollback.sh"
    exit 1
  }
fi

echo ""
echo "════════════════════════════════════════"
echo "  ✅ 部署完成 commit=$GIT_SHA"
echo "  备份: /app/backups/v4-build-bak-${TS}.tar.gz"
echo "       /app/backups/dianjie_v4-deploy-bak-*.dump"
echo "════════════════════════════════════════"
