-- 门店订货单的打印状态必须来自不可变事件，不用 updatedAt 推断。
ALTER TYPE "PurchaseOrderEventType" ADD VALUE IF NOT EXISTS 'PRINT_REQUESTED';
