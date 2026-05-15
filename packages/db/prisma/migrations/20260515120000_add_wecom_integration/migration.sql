-- 企微集成: User 加绑定字段 + 新增 WeComConfig / WeComSyncLog 表

-- AlterTable
ALTER TABLE "users" ADD COLUMN "wecomUserId" VARCHAR(64);
ALTER TABLE "users" ADD COLUMN "wecomDeptIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- 同租户内 wecomUserId 唯一 (允许 NULL)
CREATE UNIQUE INDEX "users_tenantId_wecomUserId_key" ON "users"("tenantId", "wecomUserId");

-- CreateTable
CREATE TABLE "wecom_configs" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "corpId" VARCHAR(64) NOT NULL,
  "agentId" VARCHAR(32) NOT NULL,
  "appSecret" TEXT NOT NULL,
  "contactSecret" TEXT,
  "callbackToken" TEXT,
  "encodingAESKey" TEXT,
  "accessToken" TEXT,
  "accessTokenExp" TIMESTAMP(3),
  "contactToken" TEXT,
  "contactTokenExp" TIMESTAMP(3),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wecom_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wecom_configs_tenantId_key" ON "wecom_configs"("tenantId");

-- CreateTable
CREATE TABLE "wecom_sync_logs" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB,
  "errorMsg" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wecom_sync_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "wecom_sync_logs_tenantId_kind_createdAt_idx" ON "wecom_sync_logs"("tenantId", "kind", "createdAt");
