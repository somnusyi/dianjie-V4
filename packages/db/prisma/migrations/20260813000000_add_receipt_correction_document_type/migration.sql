-- 已入账入库单金额更正单据类型。
-- 系统此前只有 receipts/:id/void，而它明确拒绝 ACCOUNTED/CONFIRMED，
-- 入账后发现的错价没有任何合规出口。更正单走总厨审批，原值留在 payload。
ALTER TYPE "DocumentType" ADD VALUE IF NOT EXISTS 'RECEIPT_CORRECTION';
