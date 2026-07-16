-- A receipt represents one confirmed payable event and must never be included
-- in more than one reconciliation. Abort instead of guessing when historical
-- duplicates exist; they require an explicit finance audit before deployment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "reconciliation_items"
    GROUP BY "receiptId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce reconciliation receipt uniqueness: duplicate receiptId rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "reconciliation_items_receiptId_key"
  ON "reconciliation_items"("receiptId");
