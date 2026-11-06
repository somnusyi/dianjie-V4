-- AlterTable
ALTER TABLE "warehouse_ledger_balances" ADD COLUMN     "postingSequence" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "warehouse_ledger_movements" ADD COLUMN     "postingSequence" INTEGER;

-- CreateTable
CREATE TABLE "warehouse_net_cost_basis_confirmations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "movementId" VARCHAR(64) NOT NULL,
    "netValueDelta" DECIMAL(20,4),
    "poolNetValueAfter" DECIMAL(20,4),
    "physicalAfterSnapshot" DECIMAL(18,6) NOT NULL,
    "grossValueAfterSnapshot" DECIMAL(20,4) NOT NULL,
    "postingSequenceSnapshot" INTEGER,
    "grossValueDeltaSnapshot" DECIMAL(20,4) NOT NULL,
    "physicalDeltaSnapshot" DECIMAL(18,6) NOT NULL,
    "inventoryUnitSnapshot" VARCHAR(16) NOT NULL,
    "basisType" VARCHAR(20) NOT NULL,
    "taxRate" DECIMAL(7,6),
    "evidenceRefs" JSONB NOT NULL,
    "note" VARCHAR(500) NOT NULL DEFAULT '',
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestKey" VARCHAR(120) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedesId" TEXT,

    CONSTRAINT "warehouse_net_cost_basis_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_net_cost_basis_confirmations_supersedesId_key" ON "warehouse_net_cost_basis_confirmations"("supersedesId");

-- CreateIndex
CREATE INDEX "warehouse_net_cost_basis_confirmations_tenantId_warehouseId_idx" ON "warehouse_net_cost_basis_confirmations"("tenantId", "warehouseId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_net_cost_basis_confirmations_tenantId_requestKey_key" ON "warehouse_net_cost_basis_confirmations"("tenantId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_net_cost_basis_confirmations_tenantId_movementId__key" ON "warehouse_net_cost_basis_confirmations"("tenantId", "movementId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_movement_scope_id_key" ON "warehouse_ledger_movements"("tenantId", "warehouseId", "productId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_movement_posting_sequence_key" ON "warehouse_ledger_movements"("tenantId", "warehouseId", "productId", "postingSequence");

-- AddForeignKey
ALTER TABLE "warehouse_net_cost_basis_confirmations" ADD CONSTRAINT "warehouse_net_cost_basis_confirmations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_net_cost_basis_confirmations" ADD CONSTRAINT "net_basis_warehouse_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_net_cost_basis_confirmations" ADD CONSTRAINT "warehouse_net_cost_basis_confirmations_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_net_cost_basis_confirmations" ADD CONSTRAINT "net_basis_movement_fkey" FOREIGN KEY ("tenantId", "warehouseId", "productId", "movementId") REFERENCES "warehouse_ledger_movements"("tenantId", "warehouseId", "productId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_net_cost_basis_confirmations" ADD CONSTRAINT "warehouse_net_cost_basis_confirmations_tenantId_confirmedB_fkey" FOREIGN KEY ("tenantId", "confirmedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_net_cost_basis_confirmations" ADD CONSTRAINT "warehouse_net_cost_basis_confirmations_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "warehouse_net_cost_basis_confirmations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every new movement obtains the next balance-local posting number while taking that balance lock.
-- Historical movement numbers intentionally remain NULL; no random-id/timestamp backfill is invented.
CREATE FUNCTION assign_warehouse_posting_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE warehouse_ledger_balances SET "postingSequence" = "postingSequence" + 1
    WHERE "tenantId" = NEW."tenantId" AND "warehouseId" = NEW."warehouseId" AND "productId" = NEW."productId"
    RETURNING "postingSequence" INTO NEW."postingSequence";
  IF NOT FOUND THEN RAISE EXCEPTION 'Warehouse ledger balance must exist before posting'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER warehouse_movement_posting_sequence BEFORE INSERT ON warehouse_ledger_movements
  FOR EACH ROW EXECUTE FUNCTION assign_warehouse_posting_sequence();
ALTER TABLE warehouse_ledger_movements ADD CONSTRAINT warehouse_movement_posting_sequence_positive CHECK ("postingSequence" IS NULL OR "postingSequence" > 0);
ALTER TABLE warehouse_net_cost_basis_confirmations ADD CONSTRAINT warehouse_net_basis_sign CHECK (
  "version" > 0 AND (
    ("basisType" = 'POOL_DOCUMENT' AND "netValueDelta" IS NULL AND "poolNetValueAfter" > 0 AND "poolNetValueAfter" <= "grossValueAfterSnapshot" AND "physicalAfterSnapshot" > 0 AND "postingSequenceSnapshot" IS NOT NULL AND "postingSequenceSnapshot" >= 0 AND "taxRate" IS NULL)
    OR
    ("basisType" IN ('TAX_RATE', 'NET_DOCUMENT', 'ALREADY_NET') AND "poolNetValueAfter" IS NULL AND "postingSequenceSnapshot" IS NULL AND "netValueDelta" IS NOT NULL AND abs("netValueDelta") <= abs("grossValueDeltaSnapshot") AND
     (("grossValueDeltaSnapshot" > 0 AND "netValueDelta" > 0) OR ("grossValueDeltaSnapshot" < 0 AND "netValueDelta" < 0) OR ("grossValueDeltaSnapshot" = 0 AND "netValueDelta" = 0 AND "physicalDeltaSnapshot" = 0)))
  )
);
