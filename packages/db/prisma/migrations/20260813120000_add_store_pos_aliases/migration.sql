-- 门店 POS 名称别名。日报上传的门店校验此前用「最长公共子串 >= 2」模糊匹配，
-- 「合肥瑶海店」与「合肥包河万达店」共有「合肥」即判为同一家店，
-- 店长上传错文件时会把别人店的营业额与菜品销量写进自己的账，且不报错。
-- 改成精确匹配主名或别名后，门店可以任意命名而不会互相串。
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "posStoreAliases" TEXT[] NOT NULL DEFAULT '{}';
