-- Make the payable state of an arrival discrepancy explicit. Receipt-time
-- shortages are already reflected in the net receipt amount, while a later
-- claim starts from a gross payable and must be deducted only when accepted.
CREATE TYPE "LossClaimPayableBasis" AS ENUM (
  'NET_AT_RECEIPT',
  'GROSS_PENDING_CLAIM',
  'NOT_APPLICABLE',
  'LEGACY_UNKNOWN'
);

ALTER TABLE "loss_claims"
  ADD COLUMN "payableBasis" "LossClaimPayableBasis" NOT NULL DEFAULT 'LEGACY_UNKNOWN';

-- Internal waste is authoritative and never belongs to supplier settlement.
UPDATE "loss_claims"
SET "payableBasis" = 'NOT_APPLICABLE'
WHERE "isManual" = TRUE;

-- Only newly traceable receipt-linked arrival claims can be safely identified
-- as already netted. Historical rows without an exact receipt remain unknown.
UPDATE "loss_claims"
SET "payableBasis" = 'NET_AT_RECEIPT'
WHERE "isManual" = FALSE
  AND "receiptId" IS NOT NULL;
