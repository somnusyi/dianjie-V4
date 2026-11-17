-- Safe, append-only warehouse stocktake approval reversal.
-- Existing confirmed documents intentionally receive no approved balance provenance;
-- the API must refuse automatic reversal for those historical rows.

CREATE TYPE "WarehouseStocktakeAdjustmentStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "WarehouseStocktakeLifecycleAction" AS ENUM ('APPROVE', 'REVERSE_APPROVAL');

-- Preserve every historical approval/review field byte-for-byte. Older
-- confirmed rows intentionally receive no posting provenance and therefore
-- remain ineligible for automatic reversal; only 1.3.4 approvals append the
-- cycle and lifecycle evidence required by the reversal service.

ALTER TABLE "warehouse_stocktakes"
  ADD CONSTRAINT "wst_audited_actor_fk"
  FOREIGN KEY ("tenantId", "auditedById")
  REFERENCES "users"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_stocktakes"
  ADD COLUMN "postingCycle" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "warehouse_stocktake_items"
  ADD COLUMN "approvedPostingSequence" INTEGER,
  ADD COLUMN "approvedBalanceVersion" INTEGER;

ALTER TABLE "warehouse_stocktake_adjustments"
  ADD COLUMN "cycle" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "status" "WarehouseStocktakeAdjustmentStatus" NOT NULL DEFAULT 'POSTED',
  ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" VARCHAR(500);

-- Historical rows retain postingCycle=0. The API refuses reversal unless a
-- positive cycle plus exact item/balance provenance exists.

DROP INDEX "warehouse_stocktake_adjustments_stocktakeId_type_key";
CREATE UNIQUE INDEX "warehouse_stocktake_adjustments_stocktakeId_cycle_type_key"
  ON "warehouse_stocktake_adjustments"("stocktakeId", "cycle", "type");

ALTER TABLE "warehouse_stocktake_adjustments"
  ADD CONSTRAINT "warehouse_stocktake_adjustment_cycle_positive" CHECK ("cycle" > 0),
  ADD CONSTRAINT "warehouse_stocktake_adjustment_reversal_evidence" CHECK (
    ("status" = 'POSTED' AND "reversedAt" IS NULL AND "reversedById" IS NULL AND "reversalReason" IS NULL)
    OR
    ("status" = 'REVERSED' AND "reversedAt" IS NOT NULL AND "reversedById" IS NOT NULL AND length(btrim("reversalReason")) >= 2)
  );

CREATE TABLE "warehouse_stocktake_lifecycle_events" (
  "id" VARCHAR(64) NOT NULL,
  "sequence" BIGSERIAL NOT NULL,
  "tenantId" TEXT NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "cycle" INTEGER NOT NULL,
  "action" "WarehouseStocktakeLifecycleAction" NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" VARCHAR(500),
  "fromStatus" "WarehouseStocktakeStatus" NOT NULL,
  "toStatus" "WarehouseStocktakeStatus" NOT NULL,
  "fromReviewStatus" "WarehouseDocReviewStatus" NOT NULL,
  "toReviewStatus" "WarehouseDocReviewStatus" NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_lifecycle_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouse_stocktake_lifecycle_cycle_positive" CHECK ("cycle" > 0),
  CONSTRAINT "warehouse_stocktake_lifecycle_stocktake_fk"
    FOREIGN KEY ("tenantId", "stocktakeId")
    REFERENCES "warehouse_stocktakes"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "warehouse_stocktake_lifecycle_actor_fk"
    FOREIGN KEY ("tenantId", "actorId")
    REFERENCES "users"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "warehouse_stocktake_lifecycle_tenant_request_key"
  ON "warehouse_stocktake_lifecycle_events"("tenantId", "requestKey");
CREATE UNIQUE INDEX "warehouse_stocktake_lifecycle_sequence_key"
  ON "warehouse_stocktake_lifecycle_events"("sequence");
CREATE INDEX "wst_lifecycle_stocktake_cycle_idx"
  ON "warehouse_stocktake_lifecycle_events"("tenantId", "stocktakeId", "cycle", "createdAt");

