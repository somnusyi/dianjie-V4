-- Invoice payment execution must be retry-safe and traceable to the actual cash account.
-- Normalize meaningless references, then fail loudly instead of guessing through historical conflicts.
UPDATE "invoice_payments"
SET "bankTxNo" = NULL
WHERE "bankTxNo" IS NOT NULL
  AND NULLIF(BTRIM("bankTxNo"), '') IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "invoice_payments"
    WHERE NULLIF(BTRIM("bankTxNo"), '') IS NOT NULL
    GROUP BY "tenantId", "bankTxNo"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'invoice payment integrity migration blocked: duplicate tenant/bankTxNo values exist';
  END IF;
END $$;

ALTER TABLE "invoice_payments"
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "cashAccountId" TEXT;

CREATE UNIQUE INDEX "invoice_payments_tenantId_requestId_key"
  ON "invoice_payments"("tenantId", "requestId");

CREATE UNIQUE INDEX "invoice_payments_tenantId_bankTxNo_key"
  ON "invoice_payments"("tenantId", "bankTxNo");

CREATE INDEX "invoice_payments_cashAccountId_idx"
  ON "invoice_payments"("cashAccountId");

ALTER TABLE "invoice_payments"
  ADD CONSTRAINT "invoice_payments_cashAccountId_fkey"
  FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
