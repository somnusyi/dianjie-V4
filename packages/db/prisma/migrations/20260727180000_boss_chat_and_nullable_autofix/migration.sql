-- 超管 AI 助手聊天：
-- 1. auto_fix_runs.feedbackId 改为可空（聊天任务不关联反馈）
-- 2. 新增 boss_chat_messages 表

ALTER TABLE "auto_fix_runs" ALTER COLUMN "feedbackId" DROP NOT NULL;

CREATE TABLE "boss_chat_messages" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "runId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "boss_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "boss_chat_messages_tenantId_userId_createdAt_idx"
  ON "boss_chat_messages"("tenantId", "userId", "createdAt");

ALTER TABLE "boss_chat_messages"
  ADD CONSTRAINT "boss_chat_messages_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "boss_chat_messages"
  ADD CONSTRAINT "boss_chat_messages_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
