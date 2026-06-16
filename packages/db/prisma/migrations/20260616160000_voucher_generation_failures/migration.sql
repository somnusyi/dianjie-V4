-- 凭证自动生成失败落账 (2026-06 技术债修复)
-- 原 fire-and-forget 凭证生成失败只 console.error 静默吞, 财务/审计无从发现.
-- 现失败写本表, 可在后台排查 + 手工补凭证 + 标记 resolved.

CREATE TABLE "voucher_generation_failures" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "sourceType"  TEXT,
    "sourceId"    TEXT,
    "summary"     TEXT,
    "reason"      TEXT NOT NULL,
    "detail"      TEXT,
    "entriesJson" JSONB,
    "resolved"    BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_generation_failures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "voucher_generation_failures_tenantId_resolved_idx"
    ON "voucher_generation_failures"("tenantId", "resolved");

CREATE INDEX "voucher_generation_failures_tenantId_sourceType_sourceId_idx"
    ON "voucher_generation_failures"("tenantId", "sourceType", "sourceId");
