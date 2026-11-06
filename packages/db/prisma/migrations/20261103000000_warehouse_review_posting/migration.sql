-- Existing records keep their original posting semantics; no history is reposted.
ALTER TABLE warehouse_docs ADD COLUMN "postingPolicy" VARCHAR(16) NOT NULL DEFAULT 'LEGACY', ADD COLUMN "postedAt" TIMESTAMP(3);
ALTER TABLE warehouse_stocktakes ADD COLUMN "postingPolicy" VARCHAR(16) NOT NULL DEFAULT 'LEGACY', ADD COLUMN "reviewStatus" "WarehouseDocReviewStatus" NOT NULL DEFAULT 'UNREVIEWED', ADD COLUMN "auditedAt" TIMESTAMP(3), ADD COLUMN "auditedById" TEXT;
