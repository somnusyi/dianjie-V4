-- CreateTable
CREATE TABLE "document_quality_images" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "warehouseDocId" TEXT,
    "receiptId" VARCHAR(64),
    "returnId" VARCHAR(64),
    "version" INTEGER NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "image" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_quality_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_quality_images_tenantId_requestId_key" ON "document_quality_images"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "document_quality_images_tenantId_warehouseDocId_version_key" ON "document_quality_images"("tenantId", "warehouseDocId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "document_quality_images_tenantId_receiptId_version_key" ON "document_quality_images"("tenantId", "receiptId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "document_quality_images_tenantId_returnId_version_key" ON "document_quality_images"("tenantId", "returnId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_docs_tenantId_id_key" ON "warehouse_docs"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "document_quality_images" ADD CONSTRAINT "document_quality_images_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_quality_images" ADD CONSTRAINT "document_quality_images_tenantId_warehouseDocId_fkey" FOREIGN KEY ("tenantId", "warehouseDocId") REFERENCES "warehouse_docs"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_quality_images" ADD CONSTRAINT "document_quality_images_tenantId_receiptId_fkey" FOREIGN KEY ("tenantId", "receiptId") REFERENCES "upstream_receipts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_quality_images" ADD CONSTRAINT "document_quality_images_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "upstream_purchase_returns"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE document_quality_images ADD CONSTRAINT document_quality_source_check CHECK (num_nonnulls("warehouseDocId","receiptId","returnId") = 1);
ALTER TABLE document_quality_images ADD CONSTRAINT document_quality_version_check CHECK (version > 0);
