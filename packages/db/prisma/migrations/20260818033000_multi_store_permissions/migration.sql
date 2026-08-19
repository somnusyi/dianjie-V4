-- 多店权限第一阶段（岗位×任职解耦，方案 C B1）：
-- 1) 新增区域经理角色（指派门店集合，机制同店长）
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'REGIONAL_MANAGER';

-- 2) 申请/邀请支持多店（为空时回退单店字段，老数据零影响）
ALTER TABLE "user_applications" ADD COLUMN IF NOT EXISTS "requestedStoreIds" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "invite_tokens" ADD COLUMN IF NOT EXISTS "storeIds" TEXT[] NOT NULL DEFAULT '{}';

-- 3) 存量用户回填：storeId → storeIds 单元素数组（幂等，只补空数组）
UPDATE "users" SET "storeIds" = ARRAY["storeId"]
WHERE "storeId" IS NOT NULL AND "storeIds" = '{}';
