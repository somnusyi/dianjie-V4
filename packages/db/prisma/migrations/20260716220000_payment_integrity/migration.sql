-- A reconciliation is settled by exactly one full payment in the current model.
-- A non-empty external transaction reference must not be reused within a tenant.
-- Fail loudly on historical conflicts: silently choosing a payment would corrupt audit history.
-- Historical whitespace-only references carry no business meaning; normalize them before indexing.
UPDATE "payments"
SET "bankTxNo" = NULL
WHERE "bankTxNo" IS NOT NULL
  AND NULLIF(BTRIM("bankTxNo"), '') IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payments"
    WHERE "reconciliationId" IS NOT NULL
    GROUP BY "reconciliationId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'payment integrity migration blocked: duplicate reconciliationId values exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "payments"
    WHERE NULLIF(BTRIM("bankTxNo"), '') IS NOT NULL
    GROUP BY "tenantId", "bankTxNo"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'payment integrity migration blocked: duplicate tenant/bankTxNo values exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "payments_reconciliationId_key"
  ON "payments"("reconciliationId");

CREATE UNIQUE INDEX "payments_tenantId_bankTxNo_key"
  ON "payments"("tenantId", "bankTxNo");
