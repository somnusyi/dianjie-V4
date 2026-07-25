import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')
const schema = readFileSync(
  resolve(repoRoot, 'packages/db/prisma/schema.prisma'),
  'utf8',
)
const migration = readFileSync(
  resolve(
    repoRoot,
    'packages/db/prisma/migrations/20260726140000_tenant_warehouse_foundation/migration.sql',
  ),
  'utf8',
)
const rollback = readFileSync(
  resolve(
    repoRoot,
    'packages/db/prisma/migrations/20260726140000_tenant_warehouse_foundation/rollback.sql',
  ),
  'utf8',
)

const warehouseFacts = [
  'delivery_orders',
  'supplier_stock_movements',
  'supplier_stock_batches',
  'supplier_stock_batch_allocations',
  'supplier_stock_reservations',
]

describe('tenant warehouse migration contract', () => {
  it('models warehouses at tenant scope without supplier ownership', () => {
    const warehouseModel = schema.match(/model Warehouse \{[\s\S]*?\n\}/)?.[0]
    const stockModel = schema.match(/model WarehouseStock \{[\s\S]*?\n\}/)?.[0]

    expect(warehouseModel).toBeTruthy()
    expect(warehouseModel).toContain('tenantId')
    expect(warehouseModel).not.toContain('supplierId')
    expect(stockModel).toContain('physicalQty')
    expect(stockModel).toContain('rowVersion')
    expect(stockModel).toContain('isActive')
    expect(stockModel).toContain('@@unique([tenantId, warehouseId, productId])')
    expect(schema.match(/generator client \{[\s\S]*?\n\}/)?.[0]).not.toContain(
      'output',
    )
  })

  it('backfills and tenant-binds all five warehouse facts', () => {
    for (const table of warehouseFacts) {
      expect(migration).toContain(`UPDATE "${table}" fact`)
      expect(migration).toContain(
        `ALTER TABLE "${table}"\nADD CONSTRAINT "${table}_tenantId_warehouseId_fkey"`,
      )
      expect(migration).toContain(
        `VALIDATE CONSTRAINT "${table}_tenantId_warehouseId_fkey"`,
      )
      expect(migration).toContain(
        `VALIDATE CONSTRAINT "${table}_warehouse_present_ck"`,
      )
    }
  })

  it('creates one deterministic default and initializes every product balance', () => {
    expect(migration).toContain(
      `CONCAT('wh_', MD5(t."id" || ':default'))`,
    )
    expect(migration).toContain(`'default',\n    '默认仓',\n    true,\n    true`)
    expect(migration).toContain('CREATE UNIQUE INDEX "warehouses_one_default_per_tenant_key"')
    expect(migration).toMatch(
      /INSERT INTO "warehouse_stocks"[\s\S]*FROM "products" p[\s\S]*JOIN "warehouses" w/,
    )
  })

  it('keeps the stock bridge one-way and documents complete removal in rollback', () => {
    expect(migration).toContain('Temporary one-way bridge: Product -> WarehouseStock only.')
    expect(migration).toContain(
      'CREATE FUNCTION "sync_product_stock_to_default_warehouse"()',
    )
    expect(migration).toContain(
      'AFTER INSERT OR UPDATE OF "stock" ON "products"',
    )
    expect(migration).not.toMatch(
      /CREATE TRIGGER[\s\S]*?ON "warehouse_stocks"/,
    )
    expect(rollback).toContain(
      'DROP TRIGGER "products_sync_default_warehouse_stock_trg" ON "products";',
    )
    expect(rollback).toContain(
      'DROP FUNCTION "sync_product_stock_to_default_warehouse"();',
    )
    expect(rollback).toContain('DROP TABLE "warehouse_stocks";')
    expect(rollback).toContain('DROP TABLE "warehouses";')
  })
})
