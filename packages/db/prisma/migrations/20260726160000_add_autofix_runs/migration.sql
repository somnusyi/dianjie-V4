-- CreateEnum
CREATE TYPE "AutoFixStatus" AS ENUM (
  'RECEIVED',
  'ANALYZING',
  'PLAN_READY',
  'AWAITING_APPROVAL',
  'PATCHING',
  'VERIFYING',
  'DEPLOYING',
  'VERIFY_PROD',
  'RESOLVED',
  'FAILED_ROLLBACK',
  'ROLLED_BACK',
  'ESCALATED',
  'REJECTED'
);

-- CreateTable
CREATE TABLE "auto_fix_runs" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "status" "AutoFixStatus" NOT NULL DEFAULT 'RECEIVED',
  "analysis" TEXT,
  "planSummary" TEXT,
  "diffPatch" TEXT,
  "diffFiles" JSONB,
  "error" TEXT,
  "baseCommitSha" TEXT,
  "commitSha" TEXT,
  "deployLog" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "auto_fix_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auto_fix_runs_feedbackId_key" ON "auto_fix_runs"("feedbackId");
CREATE INDEX "auto_fix_runs_tenantId_status_createdAt_idx"
  ON "auto_fix_runs"("tenantId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "auto_fix_runs"
  ADD CONSTRAINT "auto_fix_runs_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auto_fix_runs"
  ADD CONSTRAINT "auto_fix_runs_feedbackId_fkey"
  FOREIGN KEY ("feedbackId") REFERENCES "feedbacks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auto_fix_runs"
  ADD CONSTRAINT "auto_fix_runs_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
