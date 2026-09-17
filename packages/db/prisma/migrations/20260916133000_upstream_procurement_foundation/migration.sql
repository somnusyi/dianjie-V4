-- CreateEnum
CREATE TYPE "UpstreamContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "UpstreamPurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SUBMITTED_TO_SUPPLIER', 'CHANGE_PROPOSED', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'SETTLEMENT_PENDING', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UpstreamPurchaseOrderOrigin" AS ENUM ('MANUAL', 'REPLENISHMENT', 'EMERGENCY', 'HISTORICAL_BACKFILL');

-- CreateEnum
CREATE TYPE "UpstreamPurchaseOrderRevisionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "UpstreamShipmentStatus" AS ENUM ('DRAFT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UpstreamReceiptStatus" AS ENUM ('DRAFT', 'INSPECTING', 'PENDING_REVIEW', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "UpstreamReceiptReviewReason" AS ENUM ('AMOUNT_THRESHOLD', 'OVER_RECEIPT', 'TEMPORARY_PRICE', 'SENSITIVE_CATEGORY');

-- CreateEnum
CREATE TYPE "UpstreamArrivalClaimType" AS ENUM ('SHORTAGE', 'DAMAGE', 'QUALITY', 'WRONG_ITEM', 'OVERAGE', 'POST_RECEIPT_DAMAGE');

-- CreateEnum
CREATE TYPE "UpstreamArrivalClaimStatus" AS ENUM ('PENDING_SUPPLIER', 'SUPPLIER_ACCEPTED', 'SUPPLIER_REJECTED', 'ARBITRATION', 'AUTO_ACCEPTED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UpstreamClaimResponsibility" AS ENUM ('SUPPLIER', 'BUYER', 'SHARED', 'PENDING');

-- CreateEnum
CREATE TYPE "UpstreamClaimResolution" AS ENUM ('DEDUCTION', 'REPLACEMENT', 'RETURN', 'SHARED_LOSS', 'BUYER_ABSORB', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "UpstreamSettlementStatus" AS ENUM ('DRAFT', 'SENT_TO_SUPPLIER', 'DISPUTED', 'CONFIRMED', 'LOCKED', 'INVOICED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UpstreamSettlementLineSourceType" AS ENUM ('RECEIPT', 'CLAIM', 'RETURN', 'PRICE_ADJUSTMENT', 'OTHER_ADJUSTMENT');

-- AlterEnum
ALTER TYPE "WarehouseLedgerMovementType" ADD VALUE 'UPSTREAM_RECEIPT';

-- AlterEnum
ALTER TYPE "WarehouseLedgerLotKind" ADD VALUE 'UPSTREAM_RECEIPT';

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "postReceiptClaimHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "upstreamReceiptReviewThreshold" DECIMAL(20,4) NOT NULL DEFAULT 10000,
ADD COLUMN     "upstreamSensitiveCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "upstream_supplier_contracts" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "contractNo" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" VARCHAR(160) NOT NULL,
    "startsAt" DATE NOT NULL,
    "endsAt" DATE,
    "settlementCycle" "CreditType" NOT NULL DEFAULT 'MONTHLY',
    "settlementDays" INTEGER NOT NULL DEFAULT 0,
    "taxInclusive" BOOLEAN NOT NULL DEFAULT true,
    "defaultTaxRate" DECIMAL(7,6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
    "paymentMethod" VARCHAR(80),
    "discrepancyRule" JSONB,
    "attachments" JSONB,
    "status" "UpstreamContractStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_supplier_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_supplier_contract_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contractId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "upstreamSourceId" VARCHAR(64),
    "productCodeSnapshot" VARCHAR(80) NOT NULL,
    "productNameSnapshot" VARCHAR(160) NOT NULL,
    "productSpecSnapshot" VARCHAR(240),
    "supplierSkuSnapshot" VARCHAR(80),
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "inventoryUnitsPerPurchaseUnit" DECIMAL(18,6) NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "taxRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "minOrderQty" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "packageMultiple" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 0,
    "shortTolerancePct" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "overTolerancePct" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "startsAt" DATE NOT NULL,
    "endsAt" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_supplier_contract_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_purchase_orders" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "contractId" VARCHAR(64),
    "status" "UpstreamPurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "origin" "UpstreamPurchaseOrderOrigin" NOT NULL DEFAULT 'MANUAL',
    "expectedArrivalAt" TIMESTAMP(3),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
    "taxInclusive" BOOLEAN NOT NULL DEFAULT true,
    "amountWithoutTax" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "currentRevisionNo" INTEGER NOT NULL DEFAULT 0,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(160),
    "hasTemporaryPrice" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(500),
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "supplierAcceptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_purchase_order_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" VARCHAR(64) NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "contractLineId" VARCHAR(64),
    "productCodeSnapshot" VARCHAR(80) NOT NULL,
    "productNameSnapshot" VARCHAR(160) NOT NULL,
    "productSpecSnapshot" VARCHAR(240),
    "supplierSkuSnapshot" VARCHAR(80),
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "inventoryUnitsPerPurchaseUnit" DECIMAL(18,6) NOT NULL,
    "orderedQty" DECIMAL(18,6) NOT NULL,
    "confirmedQty" DECIMAL(18,6),
    "shippedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "receivedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "taxRate" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "amountWithoutTax" DECIMAL(20,4) NOT NULL,
    "taxAmount" DECIMAL(20,4) NOT NULL,
    "totalAmount" DECIMAL(20,4) NOT NULL,
    "shortTolerancePct" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "overTolerancePct" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "isTemporaryPrice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_purchase_order_revisions" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" VARCHAR(64) NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "status" "UpstreamPurchaseOrderRevisionStatus" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(500) NOT NULL,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByRole" VARCHAR(40) NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_purchase_order_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_purchase_order_events" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "purchaseOrderId" VARCHAR(64) NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "fromStatus" VARCHAR(40),
    "toStatus" VARCHAR(40),
    "actorId" TEXT,
    "actorRole" VARCHAR(40),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_purchase_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_shipments" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "purchaseOrderId" VARCHAR(64) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "supplierShipmentNo" VARCHAR(100),
    "status" "UpstreamShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "carrierName" VARCHAR(100),
    "trackingNo" VARCHAR(100),
    "driverName" VARCHAR(80),
    "driverPhone" VARCHAR(40),
    "vehicleNo" VARCHAR(40),
    "expectedArrivalAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "attachments" JSONB,
    "note" VARCHAR(500),
    "idempotencyKey" VARCHAR(160),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_shipment_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shipmentId" VARCHAR(64) NOT NULL,
    "purchaseOrderLineId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "shippedQty" DECIMAL(18,6) NOT NULL,
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "batchNo" VARCHAR(80),
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "packageInfo" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_shipment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_receipts" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "purchaseOrderId" VARCHAR(64) NOT NULL,
    "shipmentId" VARCHAR(64),
    "supplierId" TEXT NOT NULL,
    "warehouseId" VARCHAR(64) NOT NULL,
    "status" "UpstreamReceiptStatus" NOT NULL DEFAULT 'DRAFT',
    "arrivedAt" TIMESTAMP(3),
    "inspectionStartedAt" TIMESTAMP(3),
    "inspectorId" TEXT,
    "reviewReasons" "UpstreamReceiptReviewReason"[] DEFAULT ARRAY[]::"UpstreamReceiptReviewReason"[],
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "payableAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "idempotencyKey" VARCHAR(160),
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "note" VARCHAR(500),
    "finalForShipment" BOOLEAN NOT NULL DEFAULT true,
    "postedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_receipt_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" VARCHAR(64) NOT NULL,
    "purchaseOrderLineId" VARCHAR(64) NOT NULL,
    "shipmentLineId" VARCHAR(64),
    "productId" TEXT NOT NULL,
    "orderedQty" DECIMAL(18,6) NOT NULL,
    "shippedQty" DECIMAL(18,6),
    "arrivedQty" DECIMAL(18,6) NOT NULL,
    "acceptedQty" DECIMAL(18,6) NOT NULL,
    "damagedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "shortageQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "overageQty" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "inventoryUnit" VARCHAR(16) NOT NULL,
    "inventoryUnitsPerPurchaseUnit" DECIMAL(18,6) NOT NULL,
    "inventoryAcceptedQty" DECIMAL(18,6) NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "payableAmount" DECIMAL(20,4) NOT NULL,
    "batchNo" VARCHAR(80),
    "manufactureDate" DATE,
    "expiryDate" DATE,
    "ledgerMovementId" VARCHAR(64),
    "evidence" JSONB,
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_arrival_claims" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "purchaseOrderId" VARCHAR(64) NOT NULL,
    "receiptId" VARCHAR(64) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "type" "UpstreamArrivalClaimType" NOT NULL,
    "status" "UpstreamArrivalClaimStatus" NOT NULL DEFAULT 'PENDING_SUPPLIER',
    "responsibility" "UpstreamClaimResponsibility" NOT NULL DEFAULT 'PENDING',
    "resolution" "UpstreamClaimResolution",
    "claimedAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "resolvedAmount" DECIMAL(20,4),
    "description" VARCHAR(1000) NOT NULL,
    "evidence" JSONB,
    "supplierResponse" VARCHAR(1000),
    "supplierRespondedAt" TIMESTAMP(3),
    "responseDueAt" TIMESTAMP(3),
    "arbitratedById" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_arrival_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_arrival_claim_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "claimId" VARCHAR(64) NOT NULL,
    "receiptLineId" VARCHAR(64) NOT NULL,
    "purchaseOrderLineId" VARCHAR(64) NOT NULL,
    "productId" TEXT NOT NULL,
    "affectedQty" DECIMAL(18,6) NOT NULL,
    "purchaseUnit" VARCHAR(16) NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "claimedAmount" DECIMAL(20,4) NOT NULL,
    "resolvedAmount" DECIMAL(20,4),
    "lossMovementId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_arrival_claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_settlement_statements" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(80) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
    "status" "UpstreamSettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "openingUnsettled" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "receiptAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "deductionAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "adjustmentAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "payableAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "buyerConfirmedById" TEXT,
    "buyerConfirmedAt" TIMESTAMP(3),
    "supplierConfirmedById" TEXT,
    "supplierConfirmedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "lockedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "note" VARCHAR(500),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upstream_settlement_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_settlement_lines" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "statementId" VARCHAR(64) NOT NULL,
    "sourceType" "UpstreamSettlementLineSourceType" NOT NULL,
    "sourceId" VARCHAR(64) NOT NULL,
    "sourceNo" VARCHAR(80) NOT NULL,
    "businessDate" DATE NOT NULL,
    "receiptLineId" VARCHAR(64),
    "claimId" VARCHAR(64),
    "description" VARCHAR(500) NOT NULL,
    "originalAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "adjustmentAmount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "payableAmount" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_settlement_invoice_allocations" (
    "id" VARCHAR(64) NOT NULL,
    "tenantId" TEXT NOT NULL,
    "statementId" VARCHAR(64) NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upstream_settlement_invoice_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upstream_supplier_contracts_tenantId_supplierId_status_star_idx" ON "upstream_supplier_contracts"("tenantId", "supplierId", "status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_supplier_contracts_tenantId_supplierId_contractNo__key" ON "upstream_supplier_contracts"("tenantId", "supplierId", "contractNo", "version");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_supplier_contracts_tenantId_id_key" ON "upstream_supplier_contracts"("tenantId", "id");

-- CreateIndex
CREATE INDEX "upstream_supplier_contract_lines_tenantId_productId_isActiv_idx" ON "upstream_supplier_contract_lines"("tenantId", "productId", "isActive");

-- CreateIndex
CREATE INDEX "upstream_supplier_contract_lines_upstreamSourceId_idx" ON "upstream_supplier_contract_lines"("upstreamSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_supplier_contract_lines_contractId_productId_start_key" ON "upstream_supplier_contract_lines"("contractId", "productId", "startsAt");

-- CreateIndex
CREATE INDEX "upstream_purchase_orders_tenantId_supplierId_status_expecte_idx" ON "upstream_purchase_orders"("tenantId", "supplierId", "status", "expectedArrivalAt");

-- CreateIndex
CREATE INDEX "upstream_purchase_orders_tenantId_warehouseId_status_idx" ON "upstream_purchase_orders"("tenantId", "warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_orders_tenantId_no_key" ON "upstream_purchase_orders"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_orders_tenantId_id_key" ON "upstream_purchase_orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_orders_tenantId_idempotencyKey_key" ON "upstream_purchase_orders"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "upstream_purchase_order_lines_tenantId_productId_idx" ON "upstream_purchase_order_lines"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_order_lines_purchaseOrderId_lineNo_key" ON "upstream_purchase_order_lines"("purchaseOrderId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_order_lines_tenantId_id_key" ON "upstream_purchase_order_lines"("tenantId", "id");

-- CreateIndex
CREATE INDEX "upstream_purchase_order_revisions_tenantId_status_createdAt_idx" ON "upstream_purchase_order_revisions"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_purchase_order_revisions_purchaseOrderId_revisionN_key" ON "upstream_purchase_order_revisions"("purchaseOrderId", "revisionNo");

-- CreateIndex
CREATE INDEX "upstream_purchase_order_events_tenantId_purchaseOrderId_cre_idx" ON "upstream_purchase_order_events"("tenantId", "purchaseOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "upstream_shipments_tenantId_supplierId_status_expectedArriv_idx" ON "upstream_shipments"("tenantId", "supplierId", "status", "expectedArrivalAt");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_shipments_tenantId_no_key" ON "upstream_shipments"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_shipments_tenantId_id_key" ON "upstream_shipments"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_shipments_tenantId_idempotencyKey_key" ON "upstream_shipments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "upstream_shipment_lines_tenantId_productId_idx" ON "upstream_shipment_lines"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_shipment_lines_shipmentId_purchaseOrderLineId_key" ON "upstream_shipment_lines"("shipmentId", "purchaseOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_shipment_lines_tenantId_id_key" ON "upstream_shipment_lines"("tenantId", "id");

-- CreateIndex
CREATE INDEX "upstream_receipts_tenantId_supplierId_status_arrivedAt_idx" ON "upstream_receipts"("tenantId", "supplierId", "status", "arrivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_receipts_tenantId_no_key" ON "upstream_receipts"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_receipts_tenantId_id_key" ON "upstream_receipts"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_receipts_tenantId_idempotencyKey_key" ON "upstream_receipts"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_receipt_lines_ledgerMovementId_key" ON "upstream_receipt_lines"("ledgerMovementId");

-- CreateIndex
CREATE INDEX "upstream_receipt_lines_tenantId_productId_idx" ON "upstream_receipt_lines"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_receipt_lines_receiptId_purchaseOrderLineId_key" ON "upstream_receipt_lines"("receiptId", "purchaseOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_receipt_lines_tenantId_id_key" ON "upstream_receipt_lines"("tenantId", "id");

-- CreateIndex
CREATE INDEX "upstream_arrival_claims_tenantId_supplierId_status_createdA_idx" ON "upstream_arrival_claims"("tenantId", "supplierId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_arrival_claims_tenantId_no_key" ON "upstream_arrival_claims"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_arrival_claims_tenantId_id_key" ON "upstream_arrival_claims"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_arrival_claim_lines_lossMovementId_key" ON "upstream_arrival_claim_lines"("lossMovementId");

-- CreateIndex
CREATE INDEX "upstream_arrival_claim_lines_tenantId_productId_idx" ON "upstream_arrival_claim_lines"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_arrival_claim_lines_claimId_receiptLineId_key" ON "upstream_arrival_claim_lines"("claimId", "receiptLineId");

-- CreateIndex
CREATE INDEX "upstream_settlement_statements_tenantId_supplierId_status_p_idx" ON "upstream_settlement_statements"("tenantId", "supplierId", "status", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_settlement_statements_tenantId_no_key" ON "upstream_settlement_statements"("tenantId", "no");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_settlement_statements_tenantId_supplierId_periodSt_key" ON "upstream_settlement_statements"("tenantId", "supplierId", "periodStart", "periodEnd", "version");

-- CreateIndex
CREATE INDEX "upstream_settlement_lines_tenantId_businessDate_idx" ON "upstream_settlement_lines"("tenantId", "businessDate");

-- CreateIndex
CREATE INDEX "upstream_settlement_lines_receiptLineId_idx" ON "upstream_settlement_lines"("receiptLineId");

-- CreateIndex
CREATE INDEX "upstream_settlement_lines_claimId_idx" ON "upstream_settlement_lines"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_settlement_lines_statementId_sourceType_sourceId_key" ON "upstream_settlement_lines"("statementId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "upstream_settlement_invoice_allocations_tenantId_invoiceId_idx" ON "upstream_settlement_invoice_allocations"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "upstream_settlement_invoice_allocations_statementId_invoice_key" ON "upstream_settlement_invoice_allocations"("statementId", "invoiceId");

-- AddForeignKey
ALTER TABLE "upstream_supplier_contracts" ADD CONSTRAINT "upstream_supplier_contracts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_supplier_contracts" ADD CONSTRAINT "upstream_supplier_contracts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_supplier_contract_lines" ADD CONSTRAINT "upstream_supplier_contract_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_supplier_contract_lines" ADD CONSTRAINT "upstream_supplier_contract_lines_tenantId_contractId_fkey" FOREIGN KEY ("tenantId", "contractId") REFERENCES "upstream_supplier_contracts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_supplier_contract_lines" ADD CONSTRAINT "upstream_supplier_contract_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_supplier_contract_lines" ADD CONSTRAINT "upstream_supplier_contract_lines_upstreamSourceId_fkey" FOREIGN KEY ("upstreamSourceId") REFERENCES "product_upstream_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_orders" ADD CONSTRAINT "upstream_purchase_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_orders" ADD CONSTRAINT "upstream_purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_orders" ADD CONSTRAINT "upstream_purchase_orders_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_orders" ADD CONSTRAINT "upstream_purchase_orders_tenantId_contractId_fkey" FOREIGN KEY ("tenantId", "contractId") REFERENCES "upstream_supplier_contracts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "upstream_purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_lines" ADD CONSTRAINT "upstream_purchase_order_lines_contractLineId_fkey" FOREIGN KEY ("contractLineId") REFERENCES "upstream_supplier_contract_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_revisions" ADD CONSTRAINT "upstream_purchase_order_revisions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_revisions" ADD CONSTRAINT "upstream_purchase_order_revisions_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "upstream_purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_events" ADD CONSTRAINT "upstream_purchase_order_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_purchase_order_events" ADD CONSTRAINT "upstream_purchase_order_events_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "upstream_purchase_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipments" ADD CONSTRAINT "upstream_shipments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipments" ADD CONSTRAINT "upstream_shipments_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "upstream_purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipments" ADD CONSTRAINT "upstream_shipments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipments" ADD CONSTRAINT "upstream_shipments_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipment_lines" ADD CONSTRAINT "upstream_shipment_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipment_lines" ADD CONSTRAINT "upstream_shipment_lines_tenantId_shipmentId_fkey" FOREIGN KEY ("tenantId", "shipmentId") REFERENCES "upstream_shipments"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipment_lines" ADD CONSTRAINT "upstream_shipment_lines_tenantId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderLineId") REFERENCES "upstream_purchase_order_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_shipment_lines" ADD CONSTRAINT "upstream_shipment_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "upstream_purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_tenantId_shipmentId_fkey" FOREIGN KEY ("tenantId", "shipmentId") REFERENCES "upstream_shipments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipts" ADD CONSTRAINT "upstream_receipts_tenantId_warehouseId_fkey" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_receiptId_fkey" FOREIGN KEY ("tenantId", "receiptId") REFERENCES "upstream_receipts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderLineId") REFERENCES "upstream_purchase_order_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_shipmentLineId_fkey" FOREIGN KEY ("tenantId", "shipmentLineId") REFERENCES "upstream_shipment_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_receipt_lines" ADD CONSTRAINT "upstream_receipt_lines_ledgerMovementId_fkey" FOREIGN KEY ("ledgerMovementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claims" ADD CONSTRAINT "upstream_arrival_claims_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claims" ADD CONSTRAINT "upstream_arrival_claims_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "upstream_purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claims" ADD CONSTRAINT "upstream_arrival_claims_tenantId_receiptId_fkey" FOREIGN KEY ("tenantId", "receiptId") REFERENCES "upstream_receipts"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claims" ADD CONSTRAINT "upstream_arrival_claims_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claim_lines" ADD CONSTRAINT "upstream_arrival_claim_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claim_lines" ADD CONSTRAINT "upstream_arrival_claim_lines_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "upstream_arrival_claims"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claim_lines" ADD CONSTRAINT "upstream_arrival_claim_lines_tenantId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "receiptLineId") REFERENCES "upstream_receipt_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claim_lines" ADD CONSTRAINT "upstream_arrival_claim_lines_tenantId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderLineId") REFERENCES "upstream_purchase_order_lines"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claim_lines" ADD CONSTRAINT "upstream_arrival_claim_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_arrival_claim_lines" ADD CONSTRAINT "upstream_arrival_claim_lines_lossMovementId_fkey" FOREIGN KEY ("lossMovementId") REFERENCES "warehouse_ledger_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_statements" ADD CONSTRAINT "upstream_settlement_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_statements" ADD CONSTRAINT "upstream_settlement_statements_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_lines" ADD CONSTRAINT "upstream_settlement_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_lines" ADD CONSTRAINT "upstream_settlement_lines_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "upstream_settlement_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_lines" ADD CONSTRAINT "upstream_settlement_lines_receiptLineId_fkey" FOREIGN KEY ("receiptLineId") REFERENCES "upstream_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_lines" ADD CONSTRAINT "upstream_settlement_lines_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "upstream_arrival_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_invoice_allocations" ADD CONSTRAINT "upstream_settlement_invoice_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_invoice_allocations" ADD CONSTRAINT "upstream_settlement_invoice_allocations_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "upstream_settlement_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_settlement_invoice_allocations" ADD CONSTRAINT "upstream_settlement_invoice_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
