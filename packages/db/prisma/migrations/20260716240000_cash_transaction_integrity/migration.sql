-- A single external/business reference may create at most one ledger row per account.
-- Account is part of the key because a legitimate internal transfer writes one row on each side.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "cash_transactions"
    WHERE "refType" IS NOT NULL AND "refId" IS NOT NULL
    GROUP BY "tenantId", "accountId", "refType", "refId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'cash transaction integrity migration blocked: duplicate account/business references exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "cash_transactions_tenantId_accountId_refType_refId_key"
  ON "cash_transactions"("tenantId", "accountId", "refType", "refId");
