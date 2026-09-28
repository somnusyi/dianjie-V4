import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../../..')

describe('replenishment persistence contract', () => {
  it('keeps the request independent and bridges to exactly one formal purchase order', () => {
    const schema = fs.readFileSync(path.join(root, 'packages/db/prisma/schema.prisma'), 'utf8')
    expect(schema).toContain('model ReplenishmentOrder {')
    expect(schema).toContain('model ReplenishmentFulfillmentLink {')
    expect(schema).toContain('replenishmentOrderId String   @unique')
    expect(schema).toContain('purchaseOrderId      String   @unique')
    expect(schema).not.toMatch(/model DeliveryOrder \{[\s\S]*replenishmentOrderId/)
  })

  it('enforces state facts, nonnegative values and unique idempotency/link constraints in SQL', () => {
    const migration = fs.readFileSync(path.join(
      root,
      'packages/db/prisma/migrations/20260928011000_store_replenishment_orders/migration.sql',
    ), 'utf8')
    expect(migration).toContain('replenishment_orders_state_fact_check')
    expect(migration).toContain('replenishment_order_items_values_check')
    expect(migration).toContain('replenishment_orders_tenantId_createdById_idempotencyKey_key')
    expect(migration).toContain('replenishment_fulfillment_links_replenishmentOrderId_key')
    expect(migration).toContain('replenishment_fulfillment_links_purchaseOrderId_key')
    expect(migration).toContain('FOREIGN KEY ("tenantId", "storeId") REFERENCES "stores"("tenantId", "id")')
    expect(migration).toContain('FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id")')
    expect(migration).toContain('FOREIGN KEY ("tenantId", "actorId") REFERENCES "users"("tenantId", "id")')
    expect(migration).toContain('FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id")')
  })

  it('does not silently reprice a frozen draft during submit', () => {
    const route = fs.readFileSync(path.join(root, 'apps/api/src/routes/replenishmentOrders.ts'), 'utf8')
    expect(route).toContain('frozenByProduct')
    expect(route).toContain('REPLENISHMENT_PRICE_CHANGED')
    expect(route).toContain('changedItems: priceChanges')
    expect(route).toContain("return reply.status(409)")
  })
})
