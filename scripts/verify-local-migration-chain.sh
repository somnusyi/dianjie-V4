#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${PREVIEW_MODE:-}" != "true" || "${DATABASE_URL:-}" != *"dianjie_v4_local"* ]]; then
  echo "Refusing to run: PREVIEW_MODE=true and a dianjie_v4_local DATABASE_URL are required." >&2
  exit 1
fi

DB_USER="$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).username)')"
BASE_DB="$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
POSTGRES_CONTAINER="${DIANJIE_POSTGRES_CONTAINER:-dianjie_v4_local_postgres}"

admin_sql() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1
    return
  fi
  command -v docker >/dev/null 2>&1 || { echo "psql or docker is required." >&2; exit 1; }
  docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$BASE_DB"
}

TEMP_DB="dianjie_v4_migration_e2e_$(date +%Y%m%d%H%M%S)_$$"
TEMP_URL="$({ TEMP_DB="$TEMP_DB" node - <<'NODE'
const url = new URL(process.env.DATABASE_URL)
url.pathname = `/${process.env.TEMP_DB}`
process.stdout.write(url.toString())
NODE
})"

cleanup() {
  admin_sql <<SQL >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TEMP_DB';
DROP DATABASE IF EXISTS "$TEMP_DB";
SQL
}
trap cleanup EXIT

admin_sql <<SQL >/dev/null
CREATE DATABASE "$TEMP_DB";
SQL

echo "Applying the full migration chain to an empty local database..."
DATABASE_URL="$TEMP_URL" pnpm --filter @dianjie/db exec prisma migrate deploy --schema prisma/schema.prisma
DATABASE_URL="$TEMP_URL" pnpm --filter @dianjie/db exec prisma migrate status --schema prisma/schema.prisma
DATABASE_URL="$TEMP_URL" pnpm --filter @dianjie/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --exit-code

echo "Local migration chain verified; temporary database will be removed."
