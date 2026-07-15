-- 订货单不可变原单 + 修订/审批 + 事件时间线
-- 仅做向前兼容扩展；旧 totalAmount/amount/shippedQty/receivedQty 保留给兼容流程。

CREATE TYPE "PurchaseOrderItemOrigin" AS ENUM ('ORIGINAL', 'APPROVED_REVISION', 'LEGACY_UNKNOWN');
CREATE TYPE "PurchaseOrderRevisionType" AS ENUM ('ADD_ITEM', 'REMOVE_ITEM', 'CHANGE_QTY', 'CHANGE_EXPECTED_DATE', 'CHANGE_NOTE', 'MIXED');
CREATE TYPE "PurchaseOrderRevisionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "PurchaseOrderEventType" AS ENUM ('CREATED', 'SUBMITTED', 'ACCEPTED', 'REVISION_REQUESTED', 'REVISION_APPROVED', 'REVISION_REJECTED', 'CANCELLED', 'LEGACY_MIGRATED');

ALTER TABLE "purchase_order_items"
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "lastRevisionId" TEXT,
  ADD COLUMN "lineOrigin" "PurchaseOrderItemOrigin" NOT NULL DEFAULT 'ORIGINAL',
  ADD COLUMN "originalAmount" DECIMAL(12,2),
  ADD COLUMN "originalQuantity" DECIMAL(10,2),
  ADD COLUMN "originalUnitPrice" DECIMAL(10,2);

ALTER TABLE "purchase_orders"
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT,
  ADD COLUMN "currentOrderAmount" DECIMAL(12,2),
  ADD COLUMN "currentRevisionNo" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idempotencyKey" VARCHAR(80),
  ADD COLUMN "originalTotalAmount" DECIMAL(12,2),
  ADD COLUMN "rowVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "submittedSnapshot" JSONB,
  ADD COLUMN "submittedSnapshotHash" VARCHAR(64);

-- 历史 typed 字段可确定地回填；商品名称等快照由可续跑脚本补齐。
UPDATE "purchase_order_items"
SET
  "originalQuantity" = "quantity",
  "originalUnitPrice" = "unitPrice",
  "originalAmount" = ROUND("quantity" * "unitPrice", 2)
WHERE "originalQuantity" IS NULL;

WITH totals AS (
  SELECT "purchaseOrderId", ROUND(SUM("originalAmount"), 2) AS amount
  FROM "purchase_order_items"
  GROUP BY "purchaseOrderId"
)
UPDATE "purchase_orders" po
SET
  "originalTotalAmount" = COALESCE(t.amount, po."totalAmount"),
  "currentOrderAmount" = COALESCE(t.amount, po."totalAmount"),
  "submittedAt" = COALESCE(po."submittedAt", po."createdAt")
FROM totals t
WHERE po.id = t."purchaseOrderId";

UPDATE "purchase_orders"
SET
  "originalTotalAmount" = COALESCE("originalTotalAmount", "totalAmount"),
  "currentOrderAmount" = COALESCE("currentOrderAmount", "originalTotalAmount", "totalAmount"),
  "submittedAt" = COALESCE("submittedAt", "createdAt")
WHERE "originalTotalAmount" IS NULL
   OR "currentOrderAmount" IS NULL
   OR "submittedAt" IS NULL;

CREATE TABLE "purchase_order_revisions" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "revisionNo" INTEGER NOT NULL,
  "type" "PurchaseOrderRevisionType" NOT NULL,
  "status" "PurchaseOrderRevisionStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "beforeSnapshot" JSONB NOT NULL,
  "afterSnapshot" JSONB NOT NULL,
  "changeSet" JSONB NOT NULL,
  "requestKey" VARCHAR(80),
  "baseRowVersion" INTEGER NOT NULL,
  "requestedById" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "purchase_order_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_order_events" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "eventType" "PurchaseOrderEventType" NOT NULL,
  "actorId" TEXT,
  "actorRole" TEXT,
  "fromStatus" "PurchaseOrderStatus",
  "toStatus" "PurchaseOrderStatus",
  "metadata" JSONB,
  "requestId" TEXT,
  "ip" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_order_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "business_sequences" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "scope" VARCHAR(20) NOT NULL,
  "period" VARCHAR(12) NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_sequences_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_order_revisions_tenantId_status_createdAt_idx"
  ON "purchase_order_revisions"("tenantId", "status", "createdAt");
CREATE UNIQUE INDEX "purchase_order_revisions_purchaseOrderId_revisionNo_key"
  ON "purchase_order_revisions"("purchaseOrderId", "revisionNo");
CREATE UNIQUE INDEX "purchase_order_revisions_purchaseOrderId_requestKey_key"
  ON "purchase_order_revisions"("purchaseOrderId", "requestKey");
-- 数据库层保证同一订单同一时刻仅一条待确认修订。
CREATE UNIQUE INDEX "purchase_order_revisions_one_pending_per_order_key"
  ON "purchase_order_revisions"("purchaseOrderId") WHERE "status" = 'PENDING';

CREATE INDEX "purchase_order_events_purchaseOrderId_occurredAt_idx"
  ON "purchase_order_events"("purchaseOrderId", "occurredAt");
CREATE INDEX "purchase_order_events_tenantId_eventType_occurredAt_idx"
  ON "purchase_order_events"("tenantId", "eventType", "occurredAt");
CREATE UNIQUE INDEX "business_sequences_tenantId_scope_period_key"
  ON "business_sequences"("tenantId", "scope", "period");
CREATE INDEX "purchase_order_items_purchaseOrderId_isActive_idx"
  ON "purchase_order_items"("purchaseOrderId", "isActive");
CREATE UNIQUE INDEX "purchase_orders_tenantId_createdById_idempotencyKey_key"
  ON "purchase_orders"("tenantId", "createdById", "idempotencyKey");

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_lastRevisionId_fkey"
  FOREIGN KEY ("lastRevisionId") REFERENCES "purchase_order_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_order_revisions"
  ADD CONSTRAINT "purchase_order_revisions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_revisions"
  ADD CONSTRAINT "purchase_order_revisions_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_revisions"
  ADD CONSTRAINT "purchase_order_revisions_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_revisions"
  ADD CONSTRAINT "purchase_order_revisions_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchase_order_events"
  ADD CONSTRAINT "purchase_order_events_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_events"
  ADD CONSTRAINT "purchase_order_events_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_events"
  ADD CONSTRAINT "purchase_order_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_sequences"
  ADD CONSTRAINT "business_sequences_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
