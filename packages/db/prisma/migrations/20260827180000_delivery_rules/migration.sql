-- 配送班表：门店订货→到货节奏规则，供应链自助维护
CREATE TABLE "delivery_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "supplierId" TEXT,
    "weekdays" INTEGER[] NOT NULL,
    "leadDays" INTEGER NOT NULL DEFAULT 1,
    "orderWindowStart" VARCHAR(5),
    "orderWindowEnd" VARCHAR(5),
    "enforce" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ENABLED',
    "note" VARCHAR(240),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "delivery_rule_stores" (
    "ruleId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,

    CONSTRAINT "delivery_rule_stores_pkey" PRIMARY KEY ("ruleId", "storeId")
);

CREATE UNIQUE INDEX "delivery_rules_tenantId_no_key" ON "delivery_rules"("tenantId", "no");
CREATE INDEX "delivery_rules_tenantId_status_idx" ON "delivery_rules"("tenantId", "status");
CREATE INDEX "delivery_rule_stores_storeId_idx" ON "delivery_rule_stores"("storeId");

ALTER TABLE "delivery_rules" ADD CONSTRAINT "delivery_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_rules" ADD CONSTRAINT "delivery_rules_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "delivery_rule_stores" ADD CONSTRAINT "delivery_rule_stores_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "delivery_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_rule_stores" ADD CONSTRAINT "delivery_rule_stores_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
