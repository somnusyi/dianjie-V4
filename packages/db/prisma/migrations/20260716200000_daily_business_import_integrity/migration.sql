-- Make the daily POS import audit trail self-protecting at the database layer.
CREATE TYPE "DailyBusinessImportStatus" AS ENUM (
  'PREVIEWED',
  'CONFIRMING',
  'CONFIRMED',
  'SUPERSEDED'
);

ALTER TABLE "daily_business_imports"
  ALTER COLUMN "status" TYPE "DailyBusinessImportStatus"
  USING "status"::"DailyBusinessImportStatus";

ALTER TABLE "daily_business_imports"
  ADD CONSTRAINT "daily_business_imports_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "daily_business_imports_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "daily_business_imports_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "daily_business_imports_confirmedById_fkey"
    FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
