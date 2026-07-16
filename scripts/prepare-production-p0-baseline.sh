#!/usr/bin/env bash
# Verify the one-time production migration baseline required by the 2026-07 P0 release.
#
# Default mode is read-only:
#   ./scripts/prepare-production-p0-baseline.sh
#
# The write mode only records the already-existing historical schema migration in
# Prisma's ledger. It does not run migrate deploy, upload application artifacts,
# or restart any service. A fresh verified backup is required first.
#
#   CONFIRM_PRODUCTION_BASELINE=APPLY_BASELINE_dianjie_v4 \
#     ./scripts/prepare-production-p0-baseline.sh --apply-baseline

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER="${V4_SERVER:-root@116.62.32.162}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
TARGET_MIGRATION="20260715101500_reconcile_schema_drift"
APPLY=0

if [[ "${1:-}" == "--apply-baseline" ]]; then
  APPLY=1
elif [[ -n "${1:-}" ]]; then
  echo "Unknown argument: $1" >&2
  exit 2
fi

if [[ ! -f "$ROOT_DIR/packages/db/prisma/migrations/$TARGET_MIGRATION/migration.sql" ]]; then
  echo "Release migration $TARGET_MIGRATION is missing from this checkout." >&2
  exit 1
fi

if [[ $APPLY -eq 1 && "${CONFIRM_PRODUCTION_BASELINE:-}" != "APPLY_BASELINE_dianjie_v4" ]]; then
  echo "Refusing to write the production migration ledger without the confirmation phrase." >&2
  exit 1
fi

for command_name in ssh scp tar mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is missing: $command_name" >&2
    exit 1
  }
done

LOCAL_ARCHIVE="$(mktemp /tmp/dianjie-p0-prisma.XXXXXX.tar.gz)"
REMOTE_ARCHIVE="/tmp/dianjie-p0-prisma-$$.tar.gz"
cleanup() {
  rm -f "$LOCAL_ARCHIVE"
  ssh "${SSH_OPTS[@]}" "$SERVER" "rm -f '$REMOTE_ARCHIVE'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

COPYFILE_DISABLE=1 tar -C "$ROOT_DIR/packages/db/prisma" -czf "$LOCAL_ARCHIVE" .
scp -q "${SSH_OPTS[@]}" "$LOCAL_ARCHIVE" "$SERVER:$REMOTE_ARCHIVE"

ssh "${SSH_OPTS[@]}" "$SERVER" \
  "REMOTE_ARCHIVE='$REMOTE_ARCHIVE' APPLY='$APPLY' TARGET_MIGRATION='$TARGET_MIGRATION' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

APP_ROOT=/app/dianjie-v4
TMP_DIR="$(mktemp -d /tmp/dianjie-p0-baseline.XXXXXX)"
trap 'rm -rf "$TMP_DIR" "$REMOTE_ARCHIVE"' EXIT
tar -xzf "$REMOTE_ARCHIVE" -C "$TMP_DIR" 2>/dev/null

DB_URL="$(grep -E '^DATABASE_URL=' "$APP_ROOT/.env" | head -1 | cut -d= -f2-)"
DB_URL_PSQL="$(printf '%s' "$DB_URL" | sed 's/?[^?]*$//')"
PRISMA="$APP_ROOT/packages/db/node_modules/.bin/prisma"

[[ -n "$DB_URL" ]] || { echo "Production DATABASE_URL is missing." >&2; exit 1; }
[[ -x "$PRISMA" ]] || { echo "Production Prisma binary is missing." >&2; exit 1; }

echo "==> Production P0 migration baseline preflight"
CHECK_OUTPUT="$(psql "$DB_URL_PSQL" -X -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'database=' || current_database();
SELECT 'applied_migrations=' || count(*)
FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'failed_migrations=' || count(*)
FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT 'target_baseline_rows=' || count(*)
FROM "_prisma_migrations"
WHERE migration_name='20260715101500_reconcile_schema_drift'
  AND finished_at IS NOT NULL AND rolled_back_at IS NULL;

WITH expected(name) AS (
  VALUES ('InvoiceStatus'),('PaymentStatus'),('CapitalProjectType'),('CapitalProjectStatus'),
  ('CapitalCategory'),('ContractStatus'),('CapitalExpenseStatus'),('ApplicationStatus'),
  ('StoreLifecyclePhase'),('OpeningTaskCategory'),('OpeningTaskStatus'),('BudgetCategory'),
  ('SkuApprovalAction'),('StockMovementType')
)
SELECT 'historical_enums=' || count(*) || '/14'
FROM expected e WHERE EXISTS (SELECT 1 FROM pg_type t WHERE t.typname=e.name);

WITH expected(name) AS (
  VALUES ('product_batches'),('invoices'),('invoice_payments'),('capital_projects'),
  ('capital_contracts'),('capital_expenses'),('store_repayments'),('user_applications'),
  ('invite_tokens'),('opening_tasks'),('store_opening_budgets'),('supplier_stock_movements')
)
SELECT 'historical_tables=' || count(*) || '/12'
FROM expected e WHERE to_regclass('public."' || e.name || '"') IS NOT NULL;

WITH expected(tbl,col) AS (
  VALUES ('products','batchId'),('products','minOrderQty'),('products','spec'),('products','stepQty'),
  ('receipts','invoiceId'),('stores','aggregatorApiKeyEnc'),('stores','autoSyncRevenue'),
  ('stores','lifecyclePhase'),('loss_claims','isManual'),('loss_claims','reason')
)
SELECT 'historical_columns=' || count(*) || '/10'
FROM expected e WHERE EXISTS (
  SELECT 1 FROM information_schema.columns c
  WHERE c.table_schema='public' AND c.table_name=e.tbl AND c.column_name=e.col
);

WITH expected(name) AS (VALUES ('documents'),('document_steps'),('document_decisions'))
SELECT 'document_tables=' || count(*) || '/3'
FROM expected e WHERE to_regclass('public."' || e.name || '"') IS NOT NULL;

SELECT 'delivered_at_submillisecond_rows=' || count(*)
FROM purchase_orders
WHERE "deliveredAt" IS NOT NULL
  AND "deliveredAt" <> date_trunc('milliseconds', "deliveredAt");
SQL
)"
printf '%s\n' "$CHECK_OUTPUT"

value_for() {
  printf '%s\n' "$CHECK_OUTPUT" | sed -n "s/^$1=//p" | tail -1
}

[[ "$(value_for database)" == "dianjie_v4" ]] || {
  echo "Refusing: unexpected production database name." >&2
  exit 1
}
[[ "$(value_for failed_migrations)" == "0" ]] || {
  echo "Refusing: unresolved failed migration exists." >&2
  exit 1
}
[[ "$(value_for historical_enums)" == "14/14" ]] || {
  echo "Refusing: historical enum fingerprint does not match." >&2
  exit 1
}
[[ "$(value_for historical_tables)" == "12/12" ]] || {
  echo "Refusing: historical table fingerprint does not match." >&2
  exit 1
}
[[ "$(value_for historical_columns)" == "10/10" ]] || {
  echo "Refusing: historical column fingerprint does not match." >&2
  exit 1
}
[[ "$(value_for document_tables)" == "3/3" ]] || {
  echo "Refusing: document schema fingerprint does not match." >&2
  exit 1
}
[[ "$(value_for delivered_at_submillisecond_rows)" == "0" ]] || {
  echo "Refusing: deliveredAt contains precision that the alignment migration would truncate." >&2
  exit 1
}

BASELINE_ROWS="$(value_for target_baseline_rows)"
if [[ "$BASELINE_ROWS" == "1" ]]; then
  echo "Baseline is already recorded; no write is necessary."
  exit 0
fi
[[ "$BASELINE_ROWS" == "0" ]] || {
  echo "Refusing: unexpected duplicate baseline ledger rows." >&2
  exit 1
}

if [[ "$APPLY" != "1" ]]; then
  echo "Preflight passed (read-only). Re-run with --apply-baseline during the approved release window."
  exit 0
fi

export DATABASE_URL="$DB_URL"
"$PRISMA" migrate resolve --applied "$TARGET_MIGRATION" --schema="$TMP_DIR/schema.prisma"

RECORDED="$(psql "$DB_URL_PSQL" -X -Atc \
  "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='$TARGET_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")"
[[ "$RECORDED" == "1" ]] || {
  echo "Baseline write did not produce exactly one applied ledger row." >&2
  exit 1
}
echo "Baseline recorded successfully. Application migrations have not been executed."
REMOTE_SCRIPT
