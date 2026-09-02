#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DATABASE_URL="${LOCAL_DATABASE_URL:-postgresql://${USER}@localhost:5432/dianjie_v4_local}"
LOCAL_TENANT_SLUG="${LOCAL_TENANT_SLUG:-dianjie}"

for tool in node psql pg_dump pg_restore dropdb createdb pnpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少必需工具: $tool" >&2; exit 1; }
done

read_url_field() {
  FIELD="$1" DATABASE_URL="$2" node -e '
    const u = new URL(process.env.DATABASE_URL)
    const values = { host: u.hostname, db: decodeURIComponent(u.pathname.slice(1)) }
    process.stdout.write(values[process.env.FIELD] || "")
  '
}

admin_url() {
  DATABASE_URL="$1" node -e '
    const u = new URL(process.env.DATABASE_URL)
    u.pathname = "/postgres"
    process.stdout.write(u.toString())
  '
}

# pg_dump 不识别 Prisma 的 connection_limit/pool_timeout 等查询参数。
# 只保留 libpq 需要的 sslmode，且不在日志中打印连接串。
pg_dump_url() {
  DATABASE_URL="$1" node -e '
    const u = new URL(process.env.DATABASE_URL)
    const sslmode = u.searchParams.get("sslmode")
    u.search = ""
    if (sslmode) u.searchParams.set("sslmode", sslmode)
    process.stdout.write(u.toString())
  '
}

LOCAL_HOST="$(read_url_field host "$LOCAL_DATABASE_URL")"
LOCAL_DB="$(read_url_field db "$LOCAL_DATABASE_URL")"
if [[ "$LOCAL_HOST" != "localhost" && "$LOCAL_HOST" != "127.0.0.1" && "$LOCAL_HOST" != "::1" ]]; then
  echo "拒绝操作：本地库 host 必须是 localhost/127.0.0.1/::1" >&2
  exit 1
fi
if [[ "$LOCAL_DB" != *"dianjie_v4_local"* ]]; then
  echo "拒绝操作：本地库名必须包含 dianjie_v4_local" >&2
  exit 1
fi
if [[ ! "$LOCAL_DB" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "拒绝操作：本地库名只允许字母、数字和下划线" >&2
  exit 1
fi
if [[ -z "${LOCAL_SUPPLY_CHAIN_PHONE:-}" || -z "${LOCAL_SUPPLY_CHAIN_PASSWORD:-}" ]]; then
  echo "请设置 LOCAL_SUPPLY_CHAIN_PHONE 和 LOCAL_SUPPLY_CHAIN_PASSWORD" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dianjie-sandbox.XXXXXX")"
cleanup() { rm -f "$WORK_DIR/production.dump"; rmdir "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

if [[ "${1:-}" == "--empty" ]]; then
  echo "正在建立空白本地沙盒…"
else
  if [[ -z "${PRODUCTION_DATABASE_URL:-}" ]]; then
    echo "同步线上数据时必须设置 PRODUCTION_DATABASE_URL（建议使用只读账号）" >&2
    exit 1
  fi
  PROD_HOST="$(read_url_field host "$PRODUCTION_DATABASE_URL")"
  PROD_DB="$(read_url_field db "$PRODUCTION_DATABASE_URL")"
  if [[ "$PROD_HOST" == "localhost" || "$PROD_HOST" == "127.0.0.1" || "$PROD_DB" == *"dianjie_v4_local"* ]]; then
    echo "拒绝同步：生产源不能指向本地沙盒库" >&2
    exit 1
  fi
  echo "正在以只读方式拉取线上快照…"
  PG_DUMP_DATABASE_URL="$(pg_dump_url "$PRODUCTION_DATABASE_URL")"
  PGOPTIONS='-c default_transaction_read_only=on' pg_dump \
    --format=custom --no-owner --no-acl --file="$WORK_DIR/production.dump" \
    "$PG_DUMP_DATABASE_URL"
fi

# 重建前保留一份本地可恢复快照，严格限制文件权限并禁止 Git 追踪。
if psql "$(admin_url "$LOCAL_DATABASE_URL")" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$LOCAL_DB'" | grep -q 1; then
  BACKUP_DIR="$ROOT_DIR/.local-sandbox-backups"
  BACKUP_FILE="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-before-sync.dump"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_FILE" "$LOCAL_DATABASE_URL"
  chmod 600 "$BACKUP_FILE"
  echo "已备份当前本地库: $BACKUP_FILE"
fi

echo "正在重建本地沙盒库 $LOCAL_DB …"
LOCAL_ADMIN_URL="$(admin_url "$LOCAL_DATABASE_URL")"
dropdb --maintenance-db="$LOCAL_ADMIN_URL" --if-exists --force "$LOCAL_DB"
createdb --maintenance-db="$LOCAL_ADMIN_URL" "$LOCAL_DB"

if [[ "${1:-}" == "--empty" ]]; then
  DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --dir "$ROOT_DIR" --filter @dianjie/db exec \
    prisma migrate deploy --schema prisma/schema.prisma
  if ! psql "$LOCAL_DATABASE_URL" -Atqc "SELECT 1 FROM tenants WHERE slug = '$LOCAL_TENANT_SLUG' LIMIT 1" | grep -q 1; then
    ALLOW_DEMO_SEED=true DEMO_SEED_PASSWORD="${LOCAL_DEMO_SEED_PASSWORD:-local-only-demo-password}" \
      DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --dir "$ROOT_DIR" --filter @dianjie/db db:seed
  fi
else
  pg_restore --exit-on-error --no-owner --no-acl --dbname="$LOCAL_DATABASE_URL" "$WORK_DIR/production.dump"
  DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --dir "$ROOT_DIR" --filter @dianjie/db exec \
    prisma migrate deploy --schema prisma/schema.prisma
fi

echo "正在创建/更新本地供应链账号…"
NODE_ENV=development PREVIEW_MODE=true SANDBOX_MODE=true \
  DATABASE_URL="$LOCAL_DATABASE_URL" LOCAL_TENANT_SLUG="$LOCAL_TENANT_SLUG" \
  pnpm --dir "$ROOT_DIR" --filter @dianjie/db exec tsx src/seed-local-supply-chain.ts

echo "本地沙盒已就绪。线上库未发生任何写入。"
