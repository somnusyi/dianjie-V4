-- 补建 documents / 审批流模块 (迁移链 drift 修复)
-- 背景: DocumentType / DocumentStatus / StepStatus 三个枚举与 documents 系列表当年是用
--       `prisma db push` 直接建到生产库的, 从未进入迁移链。后续迁移
--       20260516040000_add_payment_request_doc_type 依赖 "DocumentType", 导致对空库
--       `prisma migrate deploy` 会在该步报 `type "DocumentType" does not exist` 断链。
-- 本迁移置于 040000 之前, 幂等补建全部缺失对象, 使空库全链 deploy 能复现 db push 后的 schema。
-- 生产库(已 db push, 对象均已存在)重跑本迁移安全: 所有对象 IF NOT EXISTS / 条件化守卫。
-- 生产基线化亦可: `prisma migrate resolve --applied 20260516035000_add_documents_module`
-- 将本条标记为已应用而不实际执行 SQL (见 README / 交接说明)。

-- CreateEnum (Postgres 无 CREATE TYPE IF NOT EXISTS, 用 pg_type 守卫)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentType') THEN
    CREATE TYPE "DocumentType" AS ENUM ('PETTY_CASH', 'REIMBURSEMENT', 'PURCHASE_FOOD_REGULAR', 'PURCHASE_FOOD_OVER', 'PURCHASE_NON_FOOD', 'CONTRACT', 'PRICE_ADJUSTMENT', 'NEW_SUPPLIER', 'NEW_DISH', 'STORE_TRANSFER', 'MARKETING_BUDGET', 'PERSONNEL_PAY', 'PAYMENT_REQUEST');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DocumentStatus') THEN
    CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'AUTO_APPROVED', 'REJECTED', 'CANCELED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StepStatus') THEN
    CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "isOverThreshold" BOOLEAN NOT NULL DEFAULT false,
    "thresholdRule" TEXT,
    "payload" JSONB,
    "storeId" TEXT,
    "initiatorId" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_steps" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "approverRole" TEXT NOT NULL,
    "approverId" TEXT,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,

    CONSTRAINT "document_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "document_decisions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stepId" TEXT,
    "userId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documents_tenantId_status_type_idx" ON "documents"("tenantId", "status", "type");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "documents_tenantId_no_key" ON "documents"("tenantId", "no");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "document_steps_approverRole_status_idx" ON "document_steps"("approverRole", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "document_steps_documentId_seq_key" ON "document_steps"("documentId", "seq");

-- AddForeignKey (pg_constraint 守卫, ALTER TABLE ADD CONSTRAINT 无 IF NOT EXISTS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_tenantId_fkey') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_storeId_fkey') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_initiatorId_fkey') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_steps_documentId_fkey') THEN
    ALTER TABLE "document_steps" ADD CONSTRAINT "document_steps_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_steps_approverId_fkey') THEN
    ALTER TABLE "document_steps" ADD CONSTRAINT "document_steps_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_decisions_documentId_fkey') THEN
    ALTER TABLE "document_decisions" ADD CONSTRAINT "document_decisions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_decisions_userId_fkey') THEN
    ALTER TABLE "document_decisions" ADD CONSTRAINT "document_decisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
