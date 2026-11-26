-- Existing stores remain unassigned until the business confirms their brand.
ALTER TABLE "stores" ADD COLUMN "brandCode" TEXT;
ALTER TABLE "stores" ADD CONSTRAINT "stores_brandCode_check"
  CHECK ("brandCode" IS NULL OR "brandCode" IN ('DIANJIE', 'LANCANGYAO', 'PAOPAO_ISLAND'));

-- The user-confirmed list has DJ001-DJ023 (Dianjie) and DJ025-DJ027
-- (Lancangyao). The business separately confirmed that the additional DJ024
-- is Dianjie. Match the three Lancangyao numbers and either display spelling.
DO $$
DECLARE group_count integer;
DECLARE dianjie_count integer;
DECLARE lancang_count integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE s.no BETWEEN 'DJ001' AND 'DJ024'),
         count(*) FILTER (WHERE s.no IN ('DJ025', 'DJ026', 'DJ027')
                           AND (s.name LIKE '%澜沧遥%' OR s.name LIKE '%澜苍谣%'))
    INTO group_count, dianjie_count, lancang_count
    FROM "stores" s JOIN "tenants" t ON t.id = s."tenantId"
   WHERE t.slug = 'dianjie';
  IF group_count = 27 AND (dianjie_count <> 24 OR lancang_count <> 3) THEN
    RAISE EXCEPTION 'Expected 24 Dianjie and 3 Lancangyao stores, found % and %', dianjie_count, lancang_count;
  END IF;
  IF group_count = 27 AND dianjie_count = 24 AND lancang_count = 3 THEN
    UPDATE "stores" s
       SET "brandCode" = CASE WHEN s.no IN ('DJ025', 'DJ026', 'DJ027') THEN 'LANCANGYAO' ELSE 'DIANJIE' END
      FROM "tenants" t
     WHERE t.id = s."tenantId" AND t.slug = 'dianjie' AND s."brandCode" IS NULL
       AND (s.no BETWEEN 'DJ001' AND 'DJ024' OR s.no IN ('DJ025', 'DJ026', 'DJ027'));
  ELSE
    RAISE NOTICE 'Skipped brand backfill: dianjie tenant has % stores, expected 27', group_count;
  END IF;
END $$;

-- Approval posts both stores' inventory movements in one transaction.
ALTER TABLE "store_transfers" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "store_transfers" ADD COLUMN "approvedById" TEXT;
