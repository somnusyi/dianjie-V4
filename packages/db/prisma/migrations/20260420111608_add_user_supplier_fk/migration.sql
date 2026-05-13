-- AlterTable: 给 users 表增加 supplierId 列（SUPPLIER_STAFF 角色绑定供应商用）
ALTER TABLE "users" ADD COLUMN "supplierId" TEXT;

-- AddForeignKey: users.supplierId -> suppliers.id，供应商被删时置空
ALTER TABLE "users" ADD CONSTRAINT "users_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
