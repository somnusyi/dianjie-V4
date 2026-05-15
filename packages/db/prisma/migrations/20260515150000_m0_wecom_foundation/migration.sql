-- M0 · 企微集成数据基础
-- Spec: docs/2026-05-15-企微集成-Spec.md
-- 内容: Role enum 加 SUPERVISOR/STAFF + UserStatus 加 PENDING_BIND
--       User.storeIds[] 多店支持
--       StoreHandover / NotificationPref / NotificationLog 三表

-- ─── 枚举扩展 ─────────────────────────────────────
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'STAFF';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING_BIND';

-- ─── User.storeIds[] 多店支持 ─────────────────────
ALTER TABLE "users"
  ADD COLUMN "storeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 历史 storeId 回填到 storeIds[0] (兼容期)
UPDATE "users" SET "storeIds" = ARRAY["storeId"]
  WHERE "storeId" IS NOT NULL AND cardinality("storeIds") = 0;

-- ─── 门店交接表 ────────────────────────────────────
CREATE TABLE "store_handovers" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "storeId"       TEXT NOT NULL,
  "fromUserId"    TEXT NOT NULL,
  "toUserId"      TEXT NOT NULL,
  "reason"        TEXT,
  "handoverItems" JSONB,
  "note"          TEXT,
  "createdById"   TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_handovers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "store_handovers_tenantId_storeId_createdAt_idx"
  ON "store_handovers"("tenantId", "storeId", "createdAt");

-- ─── 通知偏好表 ────────────────────────────────────
CREATE TABLE "notification_prefs" (
  "userId"    TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "channels"  TEXT[] NOT NULL DEFAULT ARRAY['wecom']::TEXT[],
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_prefs_pkey" PRIMARY KEY ("userId", "eventType")
);

-- ─── 通知日志表 ────────────────────────────────────
CREATE TABLE "notification_logs" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventKey"  TEXT NOT NULL,
  "channel"   TEXT NOT NULL,
  "status"    TEXT NOT NULL,
  "errorMsg"  TEXT,
  "payload"   JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_logs_userId_eventType_createdAt_idx"
  ON "notification_logs"("userId", "eventType", "createdAt");

CREATE INDEX "notification_logs_tenantId_eventKey_idx"
  ON "notification_logs"("tenantId", "eventKey");
