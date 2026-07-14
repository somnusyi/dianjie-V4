-- 门店实物盘点快照：为历史缺少消耗记录的门店建立可信库存基准
CREATE TABLE "inventory_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sourceFilename" TEXT,
    "sourceHash" VARCHAR(64),
    "totalValue" DECIMAL(14,3) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "nonzeroCount" INTEGER NOT NULL,
    "zeroCount" INTEGER NOT NULL,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_snapshot_items" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "productId" TEXT,
    "section" TEXT,
    "rawName" TEXT NOT NULL,
    "rawSpec" TEXT,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_snapshot_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_snapshots_storeId_snapshotDate_key"
    ON "inventory_snapshots"("storeId", "snapshotDate");
CREATE INDEX "inventory_snapshots_tenantId_snapshotDate_idx"
    ON "inventory_snapshots"("tenantId", "snapshotDate");
CREATE INDEX "inventory_snapshot_items_snapshotId_sortOrder_idx"
    ON "inventory_snapshot_items"("snapshotId", "sortOrder");
CREATE INDEX "inventory_snapshot_items_productId_idx"
    ON "inventory_snapshot_items"("productId");

ALTER TABLE "inventory_snapshots"
    ADD CONSTRAINT "inventory_snapshots_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_snapshots"
    ADD CONSTRAINT "inventory_snapshots_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_snapshot_items"
    ADD CONSTRAINT "inventory_snapshot_items_snapshotId_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "inventory_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_snapshot_items"
    ADD CONSTRAINT "inventory_snapshot_items_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
