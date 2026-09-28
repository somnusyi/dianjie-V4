-- Warehouse-scoped inventory limits and stagnation rules.
-- Existing Product.minStock remains untouched and is read only as a compatibility fallback.
CREATE TABLE "warehouse_inventory_policies" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "inventoryUnitSnapshot" VARCHAR(16) NOT NULL,
    "minQty" DECIMAL(18,6),
    "maxQty" DECIMAL(18,6),
    "stagnantDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdByName" VARCHAR(100) NOT NULL,
    "createdByRole" VARCHAR(40) NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedByName" VARCHAR(100) NOT NULL,
    "updatedByRole" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_inventory_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "warehouse_inventory_policies_quantities_check"
      CHECK (("minQty" IS NULL OR "minQty" >= 0)
        AND ("maxQty" IS NULL OR "maxQty" >= 0)
        AND ("minQty" IS NULL OR "maxQty" IS NULL OR "minQty" <= "maxQty")),
    CONSTRAINT "warehouse_inventory_policies_stagnant_days_check"
      CHECK ("stagnantDays" BETWEEN 1 AND 36500),
    CONSTRAINT "warehouse_inventory_policies_row_version_check"
      CHECK ("rowVersion" >= 0)
);

CREATE TABLE "warehouse_inventory_policy_events" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" VARCHAR(64) NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" VARCHAR(100) NOT NULL,
    "actorRole" VARCHAR(40) NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_inventory_policy_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_inventory_policies_tenantId_warehouseId_productId_key"
  ON "warehouse_inventory_policies"("tenantId", "warehouseId", "productId");
CREATE UNIQUE INDEX "warehouse_inventory_policies_tenantId_id_key"
  ON "warehouse_inventory_policies"("tenantId", "id");
CREATE INDEX "warehouse_inventory_policies_tenantId_warehouseId_active_idx"
  ON "warehouse_inventory_policies"("tenantId", "warehouseId", "active");
CREATE INDEX "warehouse_inventory_policies_tenantId_productId_idx"
  ON "warehouse_inventory_policies"("tenantId", "productId");
CREATE INDEX "warehouse_inventory_policies_tenantId_createdById_idx"
  ON "warehouse_inventory_policies"("tenantId", "createdById");
CREATE INDEX "warehouse_inventory_policies_tenantId_updatedById_idx"
  ON "warehouse_inventory_policies"("tenantId", "updatedById");

CREATE UNIQUE INDEX "warehouse_inventory_policy_events_tenantId_requestId_key"
  ON "warehouse_inventory_policy_events"("tenantId", "requestId");
CREATE INDEX "warehouse_inventory_policy_events_tenantId_policyId_createdAt_idx"
  ON "warehouse_inventory_policy_events"("tenantId", "policyId", "createdAt");
CREATE INDEX "warehouse_inventory_policy_events_tenantId_actorId_createdAt_idx"
  ON "warehouse_inventory_policy_events"("tenantId", "actorId", "createdAt");

ALTER TABLE "warehouse_inventory_policies"
  ADD CONSTRAINT "warehouse_inventory_policies_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_inventory_policies"
  ADD CONSTRAINT "warehouse_inventory_policies_tenantId_warehouseId_fkey"
  FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_inventory_policies"
  ADD CONSTRAINT "warehouse_inventory_policies_tenantId_productId_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_inventory_policy_events"
  ADD CONSTRAINT "warehouse_inventory_policy_events_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_inventory_policy_events"
  ADD CONSTRAINT "warehouse_inventory_policy_events_tenantId_policyId_fkey"
  FOREIGN KEY ("tenantId", "policyId") REFERENCES "warehouse_inventory_policies"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
