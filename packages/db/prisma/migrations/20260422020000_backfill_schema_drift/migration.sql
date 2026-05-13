-- 补齐 schema drift：从初始提交至今，schema.prisma 加了一批字段 / 整表 / enum
-- 但一直没写 migration。prod 通过历史上的 `db push` 直接同步过，因此已有；
-- 但 CI 跑 `migrate deploy` 每次起一个全新 pg，seed 就会炸：
--   column "needApproval" does not exist / table "cash_accounts" does not exist / ...
--
-- 本迁移全部用 `IF NOT EXISTS` + `DO` 块让其在 prod（已有）和 CI（全新）都能跑：
--   - CREATE TABLE IF NOT EXISTS
--   - ADD COLUMN IF NOT EXISTS（Postgres 9.6+）
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE TYPE 包 DO + EXCEPTION duplicate_object
--   - ADD CONSTRAINT 包 DO + pg_constraint 查重

-- ── Enum ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CashAccountType" AS ENUM ('BANK', 'ALIPAY', 'WECHAT', 'CASH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── payment_schedules：10 个补齐字段（含 needApproval，CI seed 炸点）──
ALTER TABLE "payment_schedules"
  ADD COLUMN IF NOT EXISTS "approvalNote"    TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedById"    TEXT,
  ADD COLUMN IF NOT EXISTS "bankRawResponse" JSONB,
  ADD COLUMN IF NOT EXISTS "bankTxNo"        TEXT,
  ADD COLUMN IF NOT EXISTS "failReason"      TEXT,
  ADD COLUMN IF NOT EXISTS "needApproval"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "rejectedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectionNote"   TEXT,
  ADD COLUMN IF NOT EXISTS "retryCount"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "storeId"         TEXT;

-- ── receipt_items：生产/保质日期 ──────────────────────────────────────
ALTER TABLE "receipt_items"
  ADD COLUMN IF NOT EXISTS "expiry_date"     DATE,
  ADD COLUMN IF NOT EXISTS "production_date" DATE;

-- ── reconciliations：按门店分组 ───────────────────────────────────────
ALTER TABLE "reconciliations"
  ADD COLUMN IF NOT EXISTS "storeId" TEXT;

-- ── 新表 store_expenses ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "store_expenses" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "storeId"   TEXT NOT NULL,
    "month"     TEXT NOT NULL,
    "category"  TEXT NOT NULL,
    "item"      TEXT NOT NULL,
    "amount"    DECIMAL(12,2) NOT NULL,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_expenses_pkey" PRIMARY KEY ("id")
);

-- ── 新表 cash_accounts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "cash_accounts" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "type"      "CashAccountType" NOT NULL DEFAULT 'BANK',
    "bankName"  TEXT,
    "accountNo" TEXT,
    "balance"   DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note"      TEXT,
    "status"    TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_accounts_pkey" PRIMARY KEY ("id")
);

-- ── 新表 cash_transactions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "cash_transactions" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT NOT NULL,
    "accountId"    TEXT NOT NULL,
    "direction"    INTEGER NOT NULL,
    "category"     TEXT NOT NULL,
    "amount"       DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "note"         TEXT,
    "txDate"       TIMESTAMP(3) NOT NULL,
    "refType"      TEXT,
    "refId"        TEXT,
    "createdById"  TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_transactions_pkey" PRIMARY KEY ("id")
);

-- ── 新表 notifications ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notifications" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL,
    "recipientRole" TEXT NOT NULL,
    "recipientId"   TEXT,
    "type"          TEXT NOT NULL,
    "title"         TEXT NOT NULL,
    "body"          TEXT NOT NULL,
    "refType"       TEXT,
    "refId"         TEXT,
    "read"          BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "store_expenses_storeId_month_item_key"
  ON "store_expenses"("storeId", "month", "item");

CREATE INDEX IF NOT EXISTS "cash_accounts_tenantId_idx"
  ON "cash_accounts"("tenantId");

CREATE INDEX IF NOT EXISTS "cash_transactions_tenantId_txDate_idx"
  ON "cash_transactions"("tenantId", "txDate" DESC);

CREATE INDEX IF NOT EXISTS "cash_transactions_accountId_idx"
  ON "cash_transactions"("accountId");

CREATE INDEX IF NOT EXISTS "notifications_tenantId_recipientRole_read_idx"
  ON "notifications"("tenantId", "recipientRole", "read");

CREATE INDEX IF NOT EXISTS "notifications_recipientId_read_idx"
  ON "notifications"("recipientId", "read");

-- ── Foreign Keys（PG 没有 ADD CONSTRAINT IF NOT EXISTS，用 pg_constraint 查重）──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_expenses_tenantId_fkey') THEN
    ALTER TABLE "store_expenses"
      ADD CONSTRAINT "store_expenses_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_expenses_storeId_fkey') THEN
    ALTER TABLE "store_expenses"
      ADD CONSTRAINT "store_expenses_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_accounts_tenantId_fkey') THEN
    ALTER TABLE "cash_accounts"
      ADD CONSTRAINT "cash_accounts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_transactions_tenantId_fkey') THEN
    ALTER TABLE "cash_transactions"
      ADD CONSTRAINT "cash_transactions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_transactions_accountId_fkey') THEN
    ALTER TABLE "cash_transactions"
      ADD CONSTRAINT "cash_transactions_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_transactions_createdById_fkey') THEN
    ALTER TABLE "cash_transactions"
      ADD CONSTRAINT "cash_transactions_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_tenantId_fkey') THEN
    ALTER TABLE "notifications"
      ADD CONSTRAINT "notifications_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_recipientId_fkey') THEN
    ALTER TABLE "notifications"
      ADD CONSTRAINT "notifications_recipientId_fkey"
      FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
