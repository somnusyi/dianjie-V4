-- The same source files may need a new audited revision after BOM rules change.
ALTER TABLE "daily_business_imports"
  ADD COLUMN "calculationFingerprint" VARCHAR(64);

UPDATE "daily_business_imports"
SET "calculationFingerprint" = COALESCE(
  "previewData" ->> 'calculationFingerprint',
  md5("id") || md5("id")
);

ALTER TABLE "daily_business_imports"
  ALTER COLUMN "calculationFingerprint" SET NOT NULL;

DROP INDEX IF EXISTS "daily_import_file_pair_uk";

CREATE UNIQUE INDEX "daily_import_version_uk"
  ON "daily_business_imports"(
    "storeId", "businessDate", "businessFileHash", "salesFileHash", "calculationFingerprint"
  );
