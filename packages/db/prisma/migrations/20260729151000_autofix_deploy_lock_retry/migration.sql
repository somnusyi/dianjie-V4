-- 部署锁冲突自动重试：AutoFixRun 增加重试计数与下次重试时间
ALTER TABLE "auto_fix_runs" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "auto_fix_runs" ADD COLUMN "nextRetryAt" TIMESTAMP(3);
