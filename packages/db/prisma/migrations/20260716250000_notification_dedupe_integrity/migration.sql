-- Optional business idempotency key for durable, at-most-once notifications.
-- PostgreSQL unique indexes allow multiple NULL values, so legacy notifications
-- keep their existing repeatable semantics until a caller opts into deduplication.
ALTER TABLE "notifications"
  ADD COLUMN "dedupeKey" VARCHAR(160);

CREATE UNIQUE INDEX "notifications_tenantId_dedupeKey_key"
  ON "notifications"("tenantId", "dedupeKey");
