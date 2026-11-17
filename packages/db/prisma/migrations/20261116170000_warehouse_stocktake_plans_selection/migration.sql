-- Warehouse stocktake plans, product-level count policy, and immutable
-- selection provenance. Historical stocktakes intentionally remain NULL and
-- are treated as manual legacy selection; no plan is guessed during migration.

CREATE TYPE "WarehouseStocktakePlanStatus" AS ENUM ('ENABLED', 'DISABLED');
CREATE TYPE "WarehouseStocktakeSelectionRule" AS ENUM (
  'ALL_ENABLED',
  'HISTORICAL_MOVEMENT',
  'PERIOD_MOVEMENT_OR_OPENING',
  'BOOK_NONZERO_AS_OF',
  'FIXED_PLAN_PRODUCTS',
  'MANUAL_SELECTED'
);
CREATE TYPE "WarehouseStocktakePeriodUnit" AS ENUM ('DAY', 'WEEK', 'MONTH');

CREATE TABLE "warehouse_stocktake_plans" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "no" VARCHAR(40) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "status" "WarehouseStocktakePlanStatus" NOT NULL DEFAULT 'ENABLED',
  "warehouseId" VARCHAR(64),
  "countScope" VARCHAR(16) NOT NULL,
  "selectionRule" "WarehouseStocktakeSelectionRule" NOT NULL,
  "periodUnit" "WarehouseStocktakePeriodUnit",
  "note" VARCHAR(500),
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "rowVersion" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_plan_row_version_check" CHECK ("rowVersion" >= 0),
  CONSTRAINT "wst_plan_count_scope_check" CHECK ("countScope" IN ('ALL', 'DAILY', 'WEEKLY', 'SELECTED')),
  CONSTRAINT "wst_plan_period_rule_check" CHECK (
    ("selectionRule" = 'PERIOD_MOVEMENT_OR_OPENING' AND "periodUnit" IS NOT NULL)
    OR ("selectionRule" <> 'PERIOD_MOVEMENT_OR_OPENING' AND "periodUnit" IS NULL)
  ),
  CONSTRAINT "wst_plan_scope_rule_check" CHECK (
    ("countScope" = 'ALL' AND "selectionRule" = 'ALL_ENABLED' AND "periodUnit" IS NULL)
    OR ("countScope" = 'DAILY' AND "selectionRule" = 'PERIOD_MOVEMENT_OR_OPENING' AND "periodUnit" = 'DAY')
    OR ("countScope" = 'WEEKLY' AND "selectionRule" = 'PERIOD_MOVEMENT_OR_OPENING' AND "periodUnit" = 'WEEK')
    OR ("countScope" = 'SELECTED' AND (
      ("selectionRule" IN ('HISTORICAL_MOVEMENT', 'BOOK_NONZERO_AS_OF', 'FIXED_PLAN_PRODUCTS') AND "periodUnit" IS NULL)
      OR ("selectionRule" = 'PERIOD_MOVEMENT_OR_OPENING' AND "periodUnit" = 'MONTH')
    ))
  ),
  CONSTRAINT "wst_plan_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_warehouse_fk" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_created_actor_fk" FOREIGN KEY ("tenantId", "createdById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_updated_actor_fk" FOREIGN KEY ("tenantId", "updatedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_plan_tenant_id_key" ON "warehouse_stocktake_plans"("tenantId", "id");
CREATE UNIQUE INDEX "wst_plan_tenant_no_key" ON "warehouse_stocktake_plans"("tenantId", "no");
CREATE UNIQUE INDEX "wst_plan_tenant_request_key" ON "warehouse_stocktake_plans"("tenantId", "requestKey");
CREATE INDEX "wst_plan_tenant_status_warehouse_idx" ON "warehouse_stocktake_plans"("tenantId", "status", "warehouseId", "updatedAt");

CREATE TABLE "warehouse_stocktake_plan_items" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "planId" VARCHAR(64) NOT NULL,
  "productId" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_plan_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_plan_item_sort_order_check" CHECK ("sortOrder" >= 0),
  CONSTRAINT "wst_plan_item_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_item_plan_fk" FOREIGN KEY ("tenantId", "planId") REFERENCES "warehouse_stocktake_plans"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_item_product_fk" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_plan_item_tenant_plan_product_key" ON "warehouse_stocktake_plan_items"("tenantId", "planId", "productId");
CREATE UNIQUE INDEX "wst_plan_item_tenant_plan_sort_key" ON "warehouse_stocktake_plan_items"("tenantId", "planId", "sortOrder");
CREATE INDEX "wst_plan_item_tenant_product_idx" ON "warehouse_stocktake_plan_items"("tenantId", "productId");

CREATE TABLE "warehouse_stocktake_plan_changes" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "planId" VARCHAR(64) NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "resultRowVersion" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_plan_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_plan_change_row_version_check" CHECK ("resultRowVersion" >= 1),
  CONSTRAINT "wst_plan_change_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_change_plan_fk" FOREIGN KEY ("tenantId", "planId") REFERENCES "warehouse_stocktake_plans"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_plan_change_actor_fk" FOREIGN KEY ("tenantId", "actorId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_plan_change_request_key" ON "warehouse_stocktake_plan_changes"("tenantId", "requestKey");
CREATE INDEX "wst_plan_change_plan_idx" ON "warehouse_stocktake_plan_changes"("tenantId", "planId", "createdAt");

CREATE TABLE "warehouse_stocktake_product_policies" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "warehouseId" VARCHAR(64) NOT NULL,
  "productId" TEXT NOT NULL,
  "canCount" BOOLEAN NOT NULL DEFAULT true,
  "defaultIncluded" BOOLEAN NOT NULL DEFAULT true,
  "reason" VARCHAR(500),
  "rowVersion" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_stocktake_product_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_product_policy_reason_check" CHECK (
    "canCount" OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 2)
  ),
  CONSTRAINT "wst_product_policy_row_version_check" CHECK ("rowVersion" >= 1),
  CONSTRAINT "wst_product_policy_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_product_policy_warehouse_fk" FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_product_policy_product_fk" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_product_policy_actor_fk" FOREIGN KEY ("tenantId", "updatedById") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_product_policy_tenant_id_key" ON "warehouse_stocktake_product_policies"("tenantId", "id");
CREATE UNIQUE INDEX "wst_product_policy_scope_key" ON "warehouse_stocktake_product_policies"("tenantId", "warehouseId", "productId");
CREATE INDEX "wst_product_policy_selection_idx" ON "warehouse_stocktake_product_policies"("tenantId", "warehouseId", "canCount", "defaultIncluded");

CREATE TABLE "warehouse_stocktake_product_policy_changes" (
  "id" VARCHAR(64) NOT NULL,
  "tenantId" TEXT NOT NULL,
  "policyId" VARCHAR(64) NOT NULL,
  "requestKey" VARCHAR(160) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "resultRowVersion" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_stocktake_product_policy_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wst_product_policy_change_row_version_check" CHECK ("resultRowVersion" >= 1),
  CONSTRAINT "wst_product_policy_change_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wst_product_policy_change_policy_fk" FOREIGN KEY ("tenantId", "policyId") REFERENCES "warehouse_stocktake_product_policies"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "wst_product_policy_change_actor_fk" FOREIGN KEY ("tenantId", "actorId") REFERENCES "users"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "wst_product_policy_change_request_key" ON "warehouse_stocktake_product_policy_changes"("tenantId", "requestKey");
CREATE INDEX "wst_product_policy_change_policy_idx" ON "warehouse_stocktake_product_policy_changes"("tenantId", "policyId", "createdAt");

ALTER TABLE "warehouse_stocktakes"
  ADD COLUMN "planId" VARCHAR(64),
  ADD COLUMN "planNoSnapshot" VARCHAR(40),
  ADD COLUMN "planNameSnapshot" VARCHAR(120),
  ADD COLUMN "selectionRuleSnapshot" "WarehouseStocktakeSelectionRule",
  ADD COLUMN "selectionPeriodUnitSnapshot" "WarehouseStocktakePeriodUnit",
  ADD COLUMN "selectionWindowStart" TIMESTAMP(3),
  ADD COLUMN "selectionWindowEndExclusive" TIMESTAMP(3),
  ADD COLUMN "selectionFingerprint" CHAR(64),
  ADD CONSTRAINT "wst_plan_fk" FOREIGN KEY ("tenantId", "planId") REFERENCES "warehouse_stocktake_plans"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "wst_selection_snapshot_check" CHECK (
    ("selectionFingerprint" IS NULL AND "selectionRuleSnapshot" IS NULL AND "selectionPeriodUnitSnapshot" IS NULL AND "selectionWindowStart" IS NULL AND "selectionWindowEndExclusive" IS NULL)
    OR
    ("selectionFingerprint" IS NOT NULL AND "selectionRuleSnapshot" IS NOT NULL
      AND (("selectionRuleSnapshot" = 'PERIOD_MOVEMENT_OR_OPENING' AND "selectionPeriodUnitSnapshot" IS NOT NULL AND "selectionWindowStart" IS NOT NULL AND "selectionWindowEndExclusive" IS NOT NULL)
        OR ("selectionRuleSnapshot" <> 'PERIOD_MOVEMENT_OR_OPENING' AND "selectionPeriodUnitSnapshot" IS NULL AND "selectionWindowStart" IS NULL AND "selectionWindowEndExclusive" IS NULL)))
  ) NOT VALID,
  ADD CONSTRAINT "wst_plan_snapshot_triple_check" CHECK (
    num_nonnulls("planId", "planNoSnapshot", "planNameSnapshot") IN (0, 3)
    AND ("planId" IS NULL OR ("selectionRuleSnapshot" IS NOT NULL AND "selectionFingerprint" IS NOT NULL))
  ) NOT VALID,
  ADD CONSTRAINT "wst_selection_fingerprint_check" CHECK (
    "selectionFingerprint" IS NULL OR "selectionFingerprint" ~ '^[0-9a-f]{64}$'
  ) NOT VALID,
  ADD CONSTRAINT "wst_selection_window_order_check" CHECK (
    ("selectionWindowStart" IS NULL AND "selectionWindowEndExclusive" IS NULL)
    OR ("selectionWindowStart" IS NOT NULL AND "selectionWindowEndExclusive" IS NOT NULL
      AND "selectionWindowStart" < "selectionWindowEndExclusive")
  ) NOT VALID,
  ADD CONSTRAINT "wst_selection_scope_rule_check" CHECK (
    "selectionRuleSnapshot" IS NULL
    OR ("countScope" = 'ALL' AND "selectionRuleSnapshot" = 'ALL_ENABLED' AND "selectionPeriodUnitSnapshot" IS NULL)
    OR ("countScope" = 'DAILY' AND "selectionRuleSnapshot" = 'PERIOD_MOVEMENT_OR_OPENING' AND "selectionPeriodUnitSnapshot" = 'DAY')
    OR ("countScope" = 'WEEKLY' AND "selectionRuleSnapshot" = 'PERIOD_MOVEMENT_OR_OPENING' AND "selectionPeriodUnitSnapshot" = 'WEEK')
    OR ("countScope" = 'SELECTED' AND (
      ("selectionRuleSnapshot" IN ('HISTORICAL_MOVEMENT', 'BOOK_NONZERO_AS_OF', 'FIXED_PLAN_PRODUCTS', 'MANUAL_SELECTED') AND "selectionPeriodUnitSnapshot" IS NULL)
      OR ("selectionRuleSnapshot" = 'PERIOD_MOVEMENT_OR_OPENING' AND "selectionPeriodUnitSnapshot" = 'MONTH')
    ))
  ) NOT VALID,
  ADD CONSTRAINT "wst_selection_plan_rule_check" CHECK (
    ("selectionRuleSnapshot" <> 'FIXED_PLAN_PRODUCTS' OR "planId" IS NOT NULL)
    AND ("selectionRuleSnapshot" <> 'MANUAL_SELECTED' OR "planId" IS NULL)
  ) NOT VALID;

ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_plan_fk";
ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_selection_snapshot_check";
ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_plan_snapshot_triple_check";
ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_selection_fingerprint_check";
ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_selection_window_order_check";
ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_selection_scope_rule_check";
ALTER TABLE "warehouse_stocktakes" VALIDATE CONSTRAINT "wst_selection_plan_rule_check";

CREATE INDEX "wst_tenant_plan_date_idx" ON "warehouse_stocktakes"("tenantId", "planId", "countDate");
