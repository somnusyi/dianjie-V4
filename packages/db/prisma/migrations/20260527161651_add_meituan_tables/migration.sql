-- ════════════════════════════════════════════════════════════════════════════
-- 美团智能版 API 集成 — 新增 7 张表
-- Spec: docs/superpowers/specs/2026-05-27-美团智能版-订单同步与可视化-设计稿.md
-- Plan: docs/superpowers/plans/2026-05-27-美团智能版-订单同步与可视化-实施计划.md
--
-- 配套代码:
--   - apps/api/src/services/meituan/  (sync / processor / cron / client / signature / errors)
--   - apps/api/src/routes/meituanAdmin.ts + meituanData.ts
--   - apps/web/.../src/app/meituan/
--
-- 不动现有任何 model. 全部 CREATE TABLE IF NOT EXISTS 幂等.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. API 调用流水 (响应反馈机制的核心数据源, 工单 markdown 生成基于此)
CREATE TABLE IF NOT EXISTS "meituan_api_call_logs" (
  "id"              TEXT          NOT NULL,
  "correlationId"   TEXT          NOT NULL,
  "apiPath"         TEXT          NOT NULL,
  "apiTitle"        TEXT          NOT NULL,
  "mode"            VARCHAR(8)    NOT NULL,
  "requestPublic"   JSONB         NOT NULL,
  "requestBiz"      JSONB         NOT NULL,
  "signature"       TEXT,
  "httpStatus"      INTEGER,
  "httpDurationMs"  INTEGER,
  "responseRaw"     TEXT,
  "responseCode"    TEXT,
  "responseMsg"     TEXT,
  "responseData"    JSONB,
  "traceId"         TEXT,
  "errorSeverity"   VARCHAR(4),
  "errorMessage"    TEXT,
  "note"            TEXT,
  "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meituan_api_call_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "meituan_api_call_logs_createdAt_idx"
  ON "meituan_api_call_logs" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "meituan_api_call_logs_responseCode_idx"
  ON "meituan_api_call_logs" ("responseCode");
CREATE INDEX IF NOT EXISTS "meituan_api_call_logs_errorSeverity_idx"
  ON "meituan_api_call_logs" ("errorSeverity");
CREATE INDEX IF NOT EXISTS "meituan_api_call_logs_correlationId_idx"
  ON "meituan_api_call_logs" ("correlationId");

-- 2. 同步断点
CREATE TABLE IF NOT EXISTS "meituan_sync_cursors" (
  "id"                    TEXT          NOT NULL,
  "apiPath"               TEXT          NOT NULL,
  "orgId"                 INTEGER       NOT NULL,
  "lastSyncedAt"          TIMESTAMP(3),
  "lastSuccessAt"         TIMESTAMP(3),
  "lastErrorAt"           TIMESTAMP(3),
  "lastErrorCode"         TEXT,
  "consecutiveFailures"   INTEGER       NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "meituan_sync_cursors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "meituan_sync_cursors_apiPath_orgId_key"
  ON "meituan_sync_cursors" ("apiPath", "orgId");

-- 3. 订单主表
CREATE TABLE IF NOT EXISTS "mt_orders" (
  "id"                 TEXT          NOT NULL,
  "mtOrderId"          TEXT          NOT NULL,
  "orderNo"            TEXT          NOT NULL,
  "vendorOrderId"      TEXT,
  "orgId"              INTEGER       NOT NULL,
  "poiId"              INTEGER       NOT NULL,
  "storeId"            TEXT,
  "channel"            VARCHAR(16)   NOT NULL,
  "callLogId"          TEXT          NOT NULL,
  "businessTime"       DATE          NOT NULL,
  "orderTime"          TIMESTAMP(3),
  "checkoutTime"       TIMESTAMP(3),
  "refundTime"         TIMESTAMP(3),
  "cancelTime"         TIMESTAMP(3),
  "syncTime"           TIMESTAMP(3),
  "status"             INTEGER       NOT NULL,
  "statusName"         TEXT,
  "refundStatus"       INTEGER,
  "makeStatus"         INTEGER,
  "isPartRefund"       BOOLEAN       NOT NULL DEFAULT false,
  "payed"              INTEGER       NOT NULL,
  "receivable"         INTEGER       NOT NULL,
  "amount"             INTEGER       NOT NULL,
  "discount"           INTEGER       NOT NULL DEFAULT 0,
  "income"             INTEGER       NOT NULL,
  "serviceFee"         INTEGER       NOT NULL DEFAULT 0,
  "taxAmt"             INTEGER       NOT NULL DEFAULT 0,
  "taxExcludedAmt"     INTEGER,
  "keepAmount"         INTEGER       NOT NULL DEFAULT 0,
  "oddment"            INTEGER       NOT NULL DEFAULT 0,
  "source"             INTEGER,
  "sourceName"         TEXT,
  "businessType"       INTEGER,
  "businessTypeName"   TEXT,
  "typeName"           TEXT,
  "customerCount"      INTEGER       NOT NULL DEFAULT 0,
  "cashier"            INTEGER,
  "cashierName"        TEXT,
  "cashierNo"          TEXT,
  "tableId"            INTEGER,
  "tableComment"       TEXT,
  "unionType"          INTEGER       DEFAULT 0,
  "parentOrderNo"      TEXT,
  "processed"          BOOLEAN       NOT NULL DEFAULT false,
  "processedAt"        TIMESTAMP(3),
  "processedAmount"    INTEGER       NOT NULL DEFAULT 0,
  "revenueRecordId"    TEXT,
  "processError"       TEXT,
  "rawPayload"         JSONB         NOT NULL,
  "createdAt"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "mt_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mt_orders_mtOrderId_key"
  ON "mt_orders" ("mtOrderId");
CREATE INDEX IF NOT EXISTS "mt_orders_storeId_businessTime_idx"
  ON "mt_orders" ("storeId", "businessTime" DESC);
CREATE INDEX IF NOT EXISTS "mt_orders_processed_idx"
  ON "mt_orders" ("processed");
CREATE INDEX IF NOT EXISTS "mt_orders_channel_idx"
  ON "mt_orders" ("channel");
CREATE INDEX IF NOT EXISTS "mt_orders_businessTime_idx"
  ON "mt_orders" ("businessTime");

-- 4. 菜品明细
CREATE TABLE IF NOT EXISTS "mt_order_items" (
  "id"                  TEXT          NOT NULL,
  "mtOrderId"           TEXT          NOT NULL,
  "mtSkuId"             TEXT          NOT NULL,
  "mtSkuNo"             TEXT,
  "mtSpuId"             TEXT,
  "thirdSkuId"          TEXT,
  "name"                TEXT          NOT NULL,
  "specs"               TEXT,
  "spuName"             TEXT,
  "count"               DECIMAL(10,3) NOT NULL,
  "price"               INTEGER       NOT NULL,
  "totalPrice"          INTEGER       NOT NULL,
  "actualPrice"         INTEGER       NOT NULL,
  "apportionPrice"      INTEGER,
  "newTotalPrice"       INTEGER,
  "income"              INTEGER       NOT NULL DEFAULT 0,
  "discountAmount"      INTEGER       NOT NULL DEFAULT 0,
  "isCombo"             INTEGER       NOT NULL DEFAULT 0,
  "comboAddPrice"       INTEGER,
  "parentItemNo"        TEXT,
  "itemNo"              TEXT,
  "serialNo"            INTEGER,
  "cateId"              INTEGER,
  "departmentOrgId"     INTEGER,
  "departmentOrgName"   TEXT,
  "present"             BOOLEAN       NOT NULL DEFAULT false,
  "promotion"           BOOLEAN       NOT NULL DEFAULT false,
  "retreat"             BOOLEAN       NOT NULL DEFAULT false,
  "status"              INTEGER,
  "attrs"               TEXT,
  "newAttrs"            JSONB,
  "taxRate"             TEXT,
  "taxAmt"              INTEGER,
  "taxExcludedAmt"      INTEGER,
  "comment"             TEXT,
  "rawPayload"          JSONB         NOT NULL,
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mt_order_items_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "mt_order_items_mtOrderId_fkey"
    FOREIGN KEY ("mtOrderId") REFERENCES "mt_orders" ("mtOrderId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "mt_order_items_mtOrderId_idx"
  ON "mt_order_items" ("mtOrderId");
CREATE INDEX IF NOT EXISTS "mt_order_items_mtSkuId_idx"
  ON "mt_order_items" ("mtSkuId");

-- 5. 支付方式拆分 (饼图数据源)
CREATE TABLE IF NOT EXISTS "mt_order_payments" (
  "id"                  TEXT          NOT NULL,
  "mtOrderId"           TEXT          NOT NULL,
  "payType"             INTEGER       NOT NULL,
  "payTypeName"         TEXT          NOT NULL,
  "payDetailType"       INTEGER,
  "payed"               INTEGER       NOT NULL,
  "discountAmount"      INTEGER       NOT NULL DEFAULT 0,
  "income"              INTEGER       NOT NULL DEFAULT 0,
  "debtAccount"         INTEGER       NOT NULL DEFAULT 0,
  "tradeNo"             TEXT,
  "payNo"               TEXT,
  "relatedPayNo"        TEXT,
  "refundTradeNo"       TEXT,
  "refundReason"        TEXT,
  "refundWay"           INTEGER,
  "refundTime"          TIMESTAMP(3),
  "merchantNo"          TEXT,
  "merchantType"        INTEGER,
  "dealTitle"           TEXT,
  "status"              INTEGER,
  "type"                INTEGER,
  "manual"              INTEGER,
  "remarks"             TEXT,
  "rawPayload"          JSONB         NOT NULL,
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mt_order_payments_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "mt_order_payments_mtOrderId_fkey"
    FOREIGN KEY ("mtOrderId") REFERENCES "mt_orders" ("mtOrderId")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "mt_order_payments_mtOrderId_idx"
  ON "mt_order_payments" ("mtOrderId");
CREATE INDEX IF NOT EXISTS "mt_order_payments_payType_idx"
  ON "mt_order_payments" ("payType");

-- 6. 退单
CREATE TABLE IF NOT EXISTS "mt_refund_orders" (
  "id"              TEXT          NOT NULL,
  "mtRefundId"      TEXT          NOT NULL,
  "mtOrderId"       TEXT          NOT NULL,
  "orgId"           INTEGER       NOT NULL,
  "poiId"           INTEGER       NOT NULL,
  "status"          INTEGER       NOT NULL,
  "statusName"      TEXT,
  "refundAmount"    INTEGER       NOT NULL,
  "refundTime"      TIMESTAMP(3),
  "businessTime"    DATE,
  "callLogId"       TEXT          NOT NULL,
  "rawPayload"      JSONB         NOT NULL,
  "createdAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "mt_refund_orders_pkey"          PRIMARY KEY ("id"),
  CONSTRAINT "mt_refund_orders_mtOrderId_fkey"
    FOREIGN KEY ("mtOrderId") REFERENCES "mt_orders" ("mtOrderId")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "mt_refund_orders_mtRefundId_key"
  ON "mt_refund_orders" ("mtRefundId");
CREATE INDEX IF NOT EXISTS "mt_refund_orders_mtOrderId_idx"
  ON "mt_refund_orders" ("mtOrderId");
CREATE INDEX IF NOT EXISTS "mt_refund_orders_businessTime_idx"
  ON "mt_refund_orders" ("businessTime");
CREATE INDEX IF NOT EXISTS "mt_refund_orders_status_idx"
  ON "mt_refund_orders" ("status");

-- 7. 凭证 (token 有 refresh 机制不能纯 env)
CREATE TABLE IF NOT EXISTS "meituan_auth_tokens" (
  "id"                TEXT          NOT NULL,
  "orgId"             INTEGER       NOT NULL,
  "appAuthToken"      TEXT          NOT NULL,
  "refreshToken"      TEXT,
  "expiresAt"         TIMESTAMP(3),
  "lastRefreshedAt"   TIMESTAMP(3),
  "refreshAttempts"   INTEGER       NOT NULL DEFAULT 0,
  "rawPayload"        JSONB,
  "createdAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "meituan_auth_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "meituan_auth_tokens_orgId_key"
  ON "meituan_auth_tokens" ("orgId");
