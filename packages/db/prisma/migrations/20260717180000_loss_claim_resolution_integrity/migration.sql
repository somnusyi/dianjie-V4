ALTER TABLE "loss_claims"
ADD COLUMN "resolvedDeductAmount" DECIMAL(12,2),
ADD COLUMN "resolvedById" TEXT;

ALTER TABLE "loss_claims"
ADD CONSTRAINT "loss_claims_resolvedById_fkey"
FOREIGN KEY ("resolvedById") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "loss_claims_resolvedById_idx" ON "loss_claims"("resolvedById");
