#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

SERVER="${UAT_SERVER:-root@116.62.32.162}"
REMOTE="${UAT_REMOTE:-/app/dianjie-v4-uat}"
UAT_HOST="${UAT_HOST:-uat-dianjie-20260917.116-62-32-162.nip.io}"
UAT_DB_NAME="${UAT_DB_NAME:-dianjie_v4_uat}"
UAT_TENANT_SLUG="${UAT_TENANT_SLUG:-supply-chain-uat}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10)

if [[ ! "$UAT_DB_NAME" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "❌ UAT_DB_NAME 只能包含字母、数字和下划线"
  exit 1
fi
if [[ ! "$UAT_HOST" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "❌ UAT_HOST 格式不正确"
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != release/supply-chain-uat-* ]]; then
  EXPECTED_REF="${UAT_RELEASE_REF:-}"
  if [[ "$EXPECTED_REF" != origin/release/supply-chain-uat-* ]]; then
    echo "❌ 只能从 release/supply-chain-uat-* 分支或对应的 origin 远端引用部署预发布，当前为 ${BRANCH:-detached HEAD}"
    exit 1
  fi
  CURRENT_SHA="$(git rev-parse HEAD)"
  EXPECTED_SHA="$(git rev-parse "${EXPECTED_REF}^{commit}" 2>/dev/null || true)"
  if [[ -z "$EXPECTED_SHA" || "$CURRENT_SHA" != "$EXPECTED_SHA" ]]; then
    echo "❌ 当前提交与 UAT_RELEASE_REF=$EXPECTED_REF 不一致，停止部署"
    exit 1
  fi
fi
if [ ! -d apps/web/public ]; then
  git checkout --ignore-skip-worktree-bits HEAD -- apps/web/public
fi
test -d apps/web/public || { echo "❌ apps/web/public 缺失"; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "❌ 工作区不是干净状态，停止部署"
  git status --short
  exit 1
fi

ssh_run() {
  ssh "${SSH_OPTS[@]}" "$SERVER" "$@"
}
rsync_run() {
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$@"
}

echo "==> [1/9] 获取预发布部署锁"
ssh_run "mkdir -p '$REMOTE'; mkdir '$REMOTE/.deploy-lock' 2>/dev/null"
trap 'ssh_run "rm -rf '\''$REMOTE/.deploy-lock'\''" >/dev/null 2>&1 || true' EXIT
ssh_run "printf '%s\n' '$(whoami)@$(hostname) $(date -u '+%Y-%m-%dT%H:%M:%SZ')' > '$REMOTE/.deploy-lock/owner'"

echo "==> [2/9] 使用 Node 20 执行发布门禁"
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
export TZ=Asia/Shanghai
pnpm env:check
pnpm install --frozen-lockfile
pnpm --filter @dianjie/api test
pnpm --filter @dianjie/web test
pnpm --filter @dianjie/web exec tsc --noEmit
pnpm --filter @dianjie/api build
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4005 WEB_PORT=3299 pnpm --filter @dianjie/web build

test -f apps/api/dist/index.js
test -f apps/api/scripts/seed-upstream-uat.ts
test -f apps/web/.next/standalone/apps/web/server.js
test -d apps/web/public

echo "==> [3/9] 创建独立数据库与预发布环境文件"
ssh_run "REMOTE='$REMOTE' UAT_HOST='$UAT_HOST' UAT_DB_NAME='$UAT_DB_NAME' UAT_TENANT_SLUG='$UAT_TENANT_SLUG' bash -s" <<'REMOTE_SETUP'
set -euo pipefail
PROD_ENV=/app/dianjie-v4/.env
test -f "$PROD_ENV"
PROD_DB_URL=$(sed -n 's/^DATABASE_URL=//p' "$PROD_ENV" | head -1)
ADMIN_DB_URL=$(printf '%s' "$PROD_DB_URL" | sed 's/?[^?]*$//')
if ! psql "$ADMIN_DB_URL" -Atc "select 1 from pg_database where datname='$UAT_DB_NAME'" | grep -q 1; then
  createdb --maintenance-db="$ADMIN_DB_URL" "$UAT_DB_NAME"
fi
UAT_DB_URL=$(python3 - "$PROD_DB_URL" "$UAT_DB_NAME" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
source = urlsplit(sys.argv[1])
print(urlunsplit((source.scheme, source.netloc, '/' + sys.argv[2], source.query, source.fragment)))
PY
)

mkdir -p "$REMOTE/apps/api" "$REMOTE/apps/web/apps/web" "$REMOTE/packages/db" "$REMOTE/uploads"
chmod 700 "$REMOTE"

if [ ! -f "$REMOTE/.uat-seed-password" ]; then
  printf 'Uat!%s\n' "$(openssl rand -hex 10)" > "$REMOTE/.uat-seed-password"
  chmod 600 "$REMOTE/.uat-seed-password"
fi

JWT_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
if [ -f "$REMOTE/.env" ]; then
  JWT_SECRET=$(sed -n 's/^JWT_SECRET=//p' "$REMOTE/.env" | head -1)
  JWT_REFRESH_SECRET=$(sed -n 's/^JWT_REFRESH_SECRET=//p' "$REMOTE/.env" | head -1)
fi

{
  printf 'NODE_ENV=production\n'
  printf 'PREVIEW_MODE=true\n'
  printf 'PREVIEW_TENANT_SLUG=%s\n' "$UAT_TENANT_SLUG"
  printf 'DATABASE_URL=%s\n' "$UAT_DB_URL"
  printf 'REDIS_URL=redis://127.0.0.1:6379/5\n'
  printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
  printf 'JWT_REFRESH_SECRET=%s\n' "$JWT_REFRESH_SECRET"
  printf 'API_HOST=127.0.0.1\n'
  printf 'API_PORT=4005\n'
  printf 'FRONTEND_URL=https://%s\n' "$UAT_HOST"
  printf 'NEXT_PUBLIC_API_URL=\n'
  printf 'NEXT_PUBLIC_API_BASE=http://127.0.0.1:4005\n'
  printf 'UPSTREAM_PROCUREMENT_ENABLED=true\n'
  printf 'UPSTREAM_RECEIPT_POSTING_ENABLED=true\n'
  printf 'UPSTREAM_MANUAL_INBOUND_RESTRICTED=false\n'
  printf 'AUTO_FIX_MODE=off\n'
  printf 'AUTO_FIX_DEPLOY_ENABLED=false\n'
  printf 'AUTO_FIX_CORE_API_ENABLED=false\n'
  printf 'CMB_AUTOPAY_ENABLED=false\n'
  printf 'CMB_INTERNAL_TRANSFER_ENABLED=false\n'
  printf 'CMB_SYNC_ENABLED=false\n'
  printf 'CMB_USE_PROD=false\n'
  printf 'CMB_SERVICE_URL=http://127.0.0.1:5999\n'
  printf 'RECEIPT_STORAGE_DIR=%s/uploads\n' "$REMOTE"
  for key in OSS_REGION OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET; do
    value=$(sed -n "s/^${key}=//p" "$PROD_ENV" | head -1)
    if [ -n "$value" ]; then printf '%s=%s\n' "$key" "$value"; fi
  done
} > "$REMOTE/.env"
chmod 600 "$REMOTE/.env"
ln -sfn "$REMOTE/.env" "$REMOTE/apps/api/.env"
REMOTE_SETUP

echo "==> [4/9] 初始化隔离运行依赖"
ssh_run "REMOTE='$REMOTE' bash -s" <<'REMOTE_DEPS'
set -euo pipefail
if [ ! -d "$REMOTE/apps/api/node_modules" ]; then
  cp -a /app/dianjie-v4/apps/api/node_modules "$REMOTE/apps/api/node_modules"
fi
if [ ! -d "$REMOTE/packages/db/node_modules" ]; then
  cp -a /app/dianjie-v4/packages/db/node_modules "$REMOTE/packages/db/node_modules"
fi
mkdir -p "$REMOTE/apps/api/node_modules/@dianjie"
rm -rf "$REMOTE/apps/api/node_modules/@dianjie/db"
ln -s "$REMOTE/packages/db" "$REMOTE/apps/api/node_modules/@dianjie/db"
REMOTE_DEPS

echo "==> [5/9] 上传候选构建产物"
rsync_run apps/api/dist/ "$SERVER:$REMOTE/apps/api/dist/"
rsync_run apps/api/scripts/ "$SERVER:$REMOTE/apps/api/scripts/"
rsync -az -e "ssh ${SSH_OPTS[*]}" apps/api/package.json "$SERVER:$REMOTE/apps/api/package.json"
rsync_run --exclude=node_modules packages/db/ "$SERVER:$REMOTE/packages/db/"
rsync_run apps/web/.next/standalone/apps/web/ "$SERVER:$REMOTE/apps/web/apps/web/"
# standalone 根目录的 node_modules/package.json 必须一并上传，
# 否则 apps/web/apps/web/server.js 向上找不到 next 等运行时依赖（生产布局同构）
rsync_run apps/web/.next/standalone/node_modules/ "$SERVER:$REMOTE/apps/web/node_modules/"
rsync -az -e "ssh ${SSH_OPTS[*]}" apps/web/.next/standalone/package.json "$SERVER:$REMOTE/apps/web/package.json"
rsync_run apps/web/.next/static/ "$SERVER:$REMOTE/apps/web/apps/web/.next/static/"
rsync_run apps/web/public/ "$SERVER:$REMOTE/apps/web/apps/web/public/"
rsync -az -e "ssh ${SSH_OPTS[*]}" deploy/uat/ecosystem.config.cjs "$SERVER:$REMOTE/ecosystem.config.cjs"
rsync -az -e "ssh ${SSH_OPTS[*]}" deploy/uat/nginx-bootstrap.conf deploy/uat/nginx.conf "$SERVER:$REMOTE/"

echo "==> [6/9] 应用迁移、生成客户端并初始化 UAT 数据"
ssh_run "REMOTE='$REMOTE' UAT_TENANT_SLUG='$UAT_TENANT_SLUG' bash -s" <<'REMOTE_MIGRATE'
set -euo pipefail
DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' "$REMOTE/.env" | head -1)
cd "$REMOTE/packages/db"
DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema.prisma
DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/prisma generate --schema=./prisma/schema.prisma
rm -rf "$REMOTE/apps/api/node_modules/.prisma"
cp -a "$REMOTE/packages/db/node_modules/.prisma" "$REMOTE/apps/api/node_modules/.prisma"
cd "$REMOTE/apps/api"
test -x ./node_modules/.bin/tsx
DATABASE_URL="$DATABASE_URL" \
UAT_SEED_CONFIRM=SEED_SUPPLY_CHAIN_UAT \
UAT_SEED_PASSWORD="$(cat "$REMOTE/.uat-seed-password")" \
UAT_TENANT_SLUG="$UAT_TENANT_SLUG" \
./node_modules/.bin/tsx scripts/seed-upstream-uat.ts >/tmp/dianjie-v4-uat-seed.json
REMOTE_MIGRATE

echo "==> [7/9] 启动独立 API 与 Web 进程"
ssh_run "REMOTE='$REMOTE' bash -s" <<'REMOTE_PM2'
set -euo pipefail
pm2 delete dianjie-v4-uat-api dianjie-v4-uat-web >/dev/null 2>&1 || true
pm2 start "$REMOTE/ecosystem.config.cjs"
pm2 save >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:4005/health || true)
  web=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3205/v2/login || true)
  if [ "$api" = 200 ] && [ "$web" = 200 ]; then exit 0; fi
  sleep 3
done
pm2 logs dianjie-v4-uat-api dianjie-v4-uat-web --lines 30 --nostream
exit 1
REMOTE_PM2

echo "==> [8/9] 配置独立 HTTPS 测试入口"
ssh_run "REMOTE='$REMOTE' UAT_HOST='$UAT_HOST' bash -s" <<'REMOTE_NGINX'
set -euo pipefail
mkdir -p /var/www/letsencrypt
sed "s/__UAT_HOST__/$UAT_HOST/g" "$REMOTE/nginx-bootstrap.conf" > /etc/nginx/sites-available/dianjie-v4-uat
ln -sfn /etc/nginx/sites-available/dianjie-v4-uat /etc/nginx/sites-enabled/dianjie-v4-uat
nginx -t
systemctl reload nginx
if [ ! -f "/etc/letsencrypt/live/$UAT_HOST/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/letsencrypt -d "$UAT_HOST" \
    --non-interactive --agree-tos --register-unsafely-without-email
fi
sed "s/__UAT_HOST__/$UAT_HOST/g" "$REMOTE/nginx.conf" > /etc/nginx/sites-available/dianjie-v4-uat
nginx -t
systemctl reload nginx
REMOTE_NGINX

echo "==> [9/9] 验证外部入口并记录版本"
curl -fsS "https://$UAT_HOST/health" >/dev/null
curl -fsS "https://$UAT_HOST/v2/login" >/dev/null
HEAD="$(git rev-parse HEAD)"
ssh_run "printf '%s\n' '$HEAD' > '$REMOTE/.deployed-commit'"

echo "✅ UAT 部署完成"
echo "URL=https://$UAT_HOST/v2/login?tenant=$UAT_TENANT_SLUG"
echo "COMMIT=$HEAD"
