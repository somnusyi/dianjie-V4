-- CreateEnum
CREATE TYPE "ProcurementApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'AUDITED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "ProcurementApprovalAction" AS ENUM ('SAVE', 'SUBMIT', 'AUDIT', 'UNCONFIRM', 'REVIEW');

-- AlterTable
ALTER TABLE "upstream_receipts" ADD COLUMN     "approvalContentFingerprint" CHAR(64),
ADD COLUMN     "approvalStatus" "ProcurementApprovalStatus",
ADD COLUMN     "approvalVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "upstream_purchase_returns" ADD COLUMN     "approvalContentFingerprint" CHAR(64),
ADD COLUMN     "approvalStatus" "ProcurementApprovalStatus",
ADD COLUMN     "approvalVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "procurement_approval_events" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" VARCHAR(64),
    "returnId" VARCHAR(64),
    "action" "ProcurementApprovalAction" NOT NULL,
    "requestId" VARCHAR(100) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "procurement_approval_events_tenantId_receiptId_createdAt_idx" ON "procurement_approval_events"("tenantId", "receiptId", "createdAt");

-- CreateIndex
CREATE INDEX "procurement_approval_events_tenantId_returnId_createdAt_idx" ON "procurement_approval_events"("tenantId", "returnId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_approval_events_tenantId_requestId_key" ON "procurement_approval_events"("tenantId", "requestId");

-- AddForeignKey
ALTER TABLE "procurement_approval_events" ADD CONSTRAINT "procurement_approval_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_approval_events" ADD CONSTRAINT "procurement_approval_events_tenantId_receiptId_fkey" FOREIGN KEY ("tenantId", "receiptId") REFERENCES "upstream_receipts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_approval_events" ADD CONSTRAINT "procurement_approval_events_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "upstream_purchase_returns"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE procurement_approval_events ADD CONSTRAINT procurement_approval_source_check CHECK (("receiptId" IS NULL) <> ("returnId" IS NULL));
