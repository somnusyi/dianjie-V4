-- AlterTable: 给 suppliers 表加 bankCode 列（联行号/SWIFT，跨行付款用）
-- 2026-04-15 在服务器上手动 migrate dev 造了这个迁移，但文件从未进 repo
-- 导致后续 rsync --delete 把文件清掉了。此处补齐，DB 已有列，migrate
-- deploy 会发现 _prisma_migrations 表里已有该 migration_name，直接跳过。
ALTER TABLE "suppliers" ADD COLUMN "bankCode" TEXT;
