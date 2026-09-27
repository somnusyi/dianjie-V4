-- DropForeignKey
ALTER TABLE "warehouse_stocktake_lines" DROP CONSTRAINT "warehouse_stocktake_lines_tenantId_partitionId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_ledger_movements_tenantId_id_key" ON "warehouse_ledger_movements"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_lines_tenantId_movementId_key" ON "warehouse_stocktake_lines"("tenantId", "movementId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocktake_partitions_tenantId_stocktakeId_id_key" ON "warehouse_stocktake_partitions"("tenantId", "stocktakeId", "id");

-- AddForeignKey
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_submittedById_fkey" FOREIGN KEY ("tenantId", "submittedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktakes" ADD CONSTRAINT "warehouse_stocktakes_tenantId_confirmedById_fkey" FOREIGN KEY ("tenantId", "confirmedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_partitions" ADD CONSTRAINT "warehouse_stocktake_partitions_tenantId_assignedToId_fkey" FOREIGN KEY ("tenantId", "assignedToId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_partitions" ADD CONSTRAINT "warehouse_stocktake_partitions_tenantId_savedById_fkey" FOREIGN KEY ("tenantId", "savedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_lines" ADD CONSTRAINT "warehouse_stocktake_lines_tenantId_stocktakeId_partitionId_fkey" FOREIGN KEY ("tenantId", "stocktakeId", "partitionId") REFERENCES "warehouse_stocktake_partitions"("tenantId", "stocktakeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocktake_lines" ADD CONSTRAINT "warehouse_stocktake_lines_tenantId_movementId_fkey" FOREIGN KEY ("tenantId", "movementId") REFERENCES "warehouse_ledger_movements"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

