-- CreateTable
CREATE TABLE "supplier_create_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestKey" VARCHAR(160) NOT NULL,
    "actorId" TEXT NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_create_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_create_requests_tenantId_requestKey_key" ON "supplier_create_requests"("tenantId", "requestKey");

-- AddForeignKey
ALTER TABLE "supplier_create_requests" ADD CONSTRAINT "supplier_create_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_create_requests" ADD CONSTRAINT "supplier_create_requests_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

