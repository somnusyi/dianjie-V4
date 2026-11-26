CREATE TYPE "WarehouseStocktakeBatchAction" AS ENUM (
  'SUBMIT', 'APPROVE', 'FINAL_REVIEW', 'REVERSE_APPROVAL'
);

CREATE TYPE "WarehouseStocktakeBatchStatus" AS ENUM ('RUNNING', 'COMPLETED');

CREATE TYPE "WarehouseStocktakeBatchItemStatus" AS ENUM (
  'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'
);

-- Exact domain-side evidence for crash recovery. This deliberately has no
-- foreign key so batch retention cannot block stocktake history retention.
ALTER TABLE "warehouse_stocktakes"
  ADD COLUMN "lastBatchItemId" VARCHAR(64);

CREATE TABLE "warehouse_stocktake_batch_operations" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "action" "WarehouseStocktakeBatchAction" NOT NULL,
  "status" "WarehouseStocktakeBatchStatus" NOT NULL DEFAULT 'RUNNING',
  "actorId" TEXT NOT NULL,
  "reason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_batch_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_batch_tenant_fk" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_batch_actor_fk" FOREIGN KEY ("tenantId", "actorId")
    REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_batch_tenant_request_key"
  ON "warehouse_stocktake_batch_operations"("tenantId", "requestKey");
CREATE UNIQUE INDEX "wst_batch_tenant_id_key"
  ON "warehouse_stocktake_batch_operations"("tenantId", "id");
CREATE INDEX "wst_batch_actor_created_idx"
  ON "warehouse_stocktake_batch_operations"("tenantId", "actorId", "createdAt");

CREATE TABLE "warehouse_stocktake_batch_operation_items" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "operationId" VARCHAR(64) NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "stocktakeNo" VARCHAR(40),
  "inputRowVersion" INTEGER NOT NULL,
  "status" "WarehouseStocktakeBatchItemStatus" NOT NULL DEFAULT 'PENDING',
  "errorCode" VARCHAR(48),
  "message" VARCHAR(500),
  "outputRowVersion" INTEGER,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" VARCHAR(64),
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_batch_operation_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_batch_item_version_nonnegative" CHECK ("inputRowVersion" >= 0),
  CONSTRAINT "wst_batch_item_attempt_nonnegative" CHECK ("attemptCount" >= 0),
  CONSTRAINT "wst_batch_item_tenant_fk" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_batch_item_operation_fk" FOREIGN KEY ("tenantId", "operationId")
    REFERENCES "warehouse_stocktake_batch_operations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_batch_item_operation_stocktake_key"
  ON "warehouse_stocktake_batch_operation_items"("operationId", "stocktakeId");
CREATE INDEX "wst_batch_item_operation_status_idx"
  ON "warehouse_stocktake_batch_operation_items"("tenantId", "operationId", "status");
CREATE INDEX "wst_batch_item_stocktake_idx"
  ON "warehouse_stocktake_batch_operation_items"("tenantId", "stocktakeId", "createdAt");
