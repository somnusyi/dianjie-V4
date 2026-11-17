CREATE TYPE "WarehouseStocktakePrintJobStatus" AS ENUM ('PREPARED', 'COMPLETED', 'ABANDONED');

ALTER TABLE "warehouse_stocktakes"
  ADD COLUMN "printCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastPrintedAt" TIMESTAMP(3),
  ADD COLUMN "lastPrintedById" TEXT,
  ADD COLUMN "lastPrintedRowVersion" INTEGER,
  ADD CONSTRAINT "wst_last_printed_actor_fk"
    FOREIGN KEY ("tenantId", "lastPrintedById")
    REFERENCES "users"("tenantId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "wst_print_count_nonnegative" CHECK ("printCount" >= 0),
  ADD CONSTRAINT "wst_print_evidence_complete" CHECK (
    (
      "printCount" = 0
      AND "lastPrintedAt" IS NULL
      AND "lastPrintedById" IS NULL
      AND "lastPrintedRowVersion" IS NULL
    )
    OR
    (
      "printCount" > 0
      AND "lastPrintedAt" IS NOT NULL
      AND "lastPrintedById" IS NOT NULL
      AND "lastPrintedRowVersion" IS NOT NULL
      AND "lastPrintedRowVersion" >= 0
    )
  );

CREATE TABLE "warehouse_stocktake_print_jobs" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "actorId" TEXT NOT NULL,
  "status" "WarehouseStocktakePrintJobStatus" NOT NULL DEFAULT 'PREPARED',
  "completedAt" TIMESTAMP(3),
  "abandonedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_print_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_print_job_tenant_fk" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_print_job_actor_fk" FOREIGN KEY ("tenantId", "actorId")
    REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_print_job_terminal_evidence" CHECK (
    ("status" = 'PREPARED' AND "completedAt" IS NULL AND "abandonedAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "completedAt" IS NOT NULL AND "abandonedAt" IS NULL)
    OR ("status" = 'ABANDONED' AND "completedAt" IS NULL AND "abandonedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "wst_print_job_tenant_id_key"
  ON "warehouse_stocktake_print_jobs"("tenantId", "id");
CREATE UNIQUE INDEX "wst_print_job_tenant_request_key"
  ON "warehouse_stocktake_print_jobs"("tenantId", "requestKey");
CREATE INDEX "wst_print_job_actor_created_idx"
  ON "warehouse_stocktake_print_jobs"("tenantId", "actorId", "createdAt");

CREATE TABLE "warehouse_stocktake_print_job_items" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "printJobId" VARCHAR(64) NOT NULL,
  "stocktakeId" VARCHAR(64) NOT NULL,
  "stocktakeRowVersion" INTEGER NOT NULL,
  "renderFingerprint" CHAR(64) NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_print_job_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_print_item_version_nonnegative" CHECK ("stocktakeRowVersion" >= 0),
  CONSTRAINT "wst_print_item_sort_nonnegative" CHECK ("sortOrder" >= 0),
  CONSTRAINT "wst_print_item_tenant_fk" FOREIGN KEY ("tenantId")
    REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_print_item_job_fk" FOREIGN KEY ("tenantId", "printJobId")
    REFERENCES "warehouse_stocktake_print_jobs"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_print_item_stocktake_fk" FOREIGN KEY ("tenantId", "stocktakeId")
    REFERENCES "warehouse_stocktakes"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_print_item_job_stocktake_key"
  ON "warehouse_stocktake_print_job_items"("printJobId", "stocktakeId");
CREATE INDEX "wst_print_item_stocktake_idx"
  ON "warehouse_stocktake_print_job_items"("tenantId", "stocktakeId", "createdAt");
