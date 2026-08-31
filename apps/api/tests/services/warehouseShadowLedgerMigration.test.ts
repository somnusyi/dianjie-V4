import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')
const schema = readFileSync(resolve(repoRoot, 'packages/db/prisma/schema.prisma'), 'utf8')
const migration = readFileSync(resolve(
  repoRoot,
  'packages/db/prisma/migrations/20260802090000_warehouse_shadow_ledger/migration.sql',
), 'utf8')
const importRoute = readFileSync(resolve(repoRoot, 'apps/api/src/routes/warehouseInventoryImports.ts'), 'utf8')
const orderRoute = readFileSync(resolve(repoRoot, 'apps/api/src/routes/orders.ts'), 'utf8')

describe('warehouse shadow ledger migration contract', () => {
  it('is expand-only and keeps legacy Product.stock / warehouse_stocks semantics untouched', () => {
    expect(migration).toContain('This migration is expand-only')
    expect(migration).not.toMatch(/UPDATE\s+"products"/i)
    expect(migration).not.toMatch(/ALTER TABLE\s+"products"/i)
    expect(migration).not.toMatch(/DROP TABLE\s+"warehouse_stocks"/i)
    expect(migration).not.toMatch(/UPDATE\s+"warehouse_stocks"/i)
  })

  it('creates a supplier-independent inventory-unit ledger in SHADOW mode', () => {
    const warehouse = schema.match(/model Warehouse \{[\s\S]*?\n\}/)?.[0] || ''
    const balance = schema.match(/model WarehouseLedgerBalance \{[\s\S]*?\n\}/)?.[0] || ''
    const movement = schema.match(/model WarehouseLedgerMovement \{[\s\S]*?\n\}/)?.[0] || ''
    const reservation = schema.match(/model WarehouseLedgerReservation \{[\s\S]*?\n\}/)?.[0] || ''

    expect(warehouse).toContain('inventoryMode        WarehouseInventoryMode @default(OFF)')
    expect(migration).toContain("CREATE TYPE \"WarehouseInventoryMode\" AS ENUM ('OFF', 'SHADOW', 'STRICT')")
    expect(migration).toContain("DEFAULT 'OFF'")
    for (const model of [balance, movement, reservation]) {
      expect(model).toContain('warehouseId')
      expect(model).toContain('productId')
    }
    for (const model of [balance, reservation]) {
      expect(model).toContain('inventoryUnit')
      // 余额/预留保持供应商无关：库存归仓不归供应商
      expect(model).not.toContain('supplierId')
    }
    // P2 起流水可挂供应商（可空，纯归属维度），库存口径不变
    expect(movement).toContain('supplierId           String?')
    expect(movement).toContain('inventoryUnit')
    expect(balance).toContain('@db.Decimal(18, 6)')
    expect(balance).toContain('reservedQty')
    expect(balance).toContain('inventoryValue')
    expect(movement).toContain('effectiveAt')
    expect(movement).toContain('idempotencyKey')
    expect(movement).toContain('reversalOfId')
  })

  it('enforces database uniqueness and tenant-scoped foreign keys', () => {
    expect(migration).toContain('warehouse_ledger_balances_tenantId_warehouseId_productId_key')
    expect(migration).toContain('warehouse_ledger_movements_tenantId_warehouseId_idempotency_key')
    expect(migration).toContain('warehouse_ledger_reservations_purchaseOrderItemId_key')
    expect(migration).toContain('warehouse_ledger_lots_tenantId_warehouseId_productId_batchN_key')
    expect(migration).toContain('FOREIGN KEY ("tenantId", "warehouseId") REFERENCES "warehouses"("tenantId", "id")')
    expect(migration).toContain('FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id")')
  })

  it('keeps the unsafe historical snapshot write path hard-disabled', () => {
    expect(importRoute).toMatch(/function legacySnapshotWritesPermanentlyRemoved\(\): boolean \{\s*return true\s*\}/)
    expect(importRoute.match(/if \(legacySnapshotWritesPermanentlyRemoved\(\)\)/g)).toHaveLength(2)
    expect(importRoute).toContain("return reply.status(410).send")
    expect(importRoute).toContain('WAREHOUSE_SNAPSHOT_CONFIRM_REMOVED')
    expect(importRoute).toContain('WAREHOUSE_SNAPSHOT_REVERSE_REMOVED')
  })

  it('keeps warehouse reservation, release and actual-shipment posting wired into the existing order flow', () => {
    expect(orderRoute).toContain("order.supplier.sourceType === 'HEADQ_WAREHOUSE'")
    expect(orderRoute).toContain("!isWarehouseOrder && order.supplier.inventoryMode === 'STRICT'")
    expect(orderRoute).toContain('await reserveWarehouseLedgerForOrder(tx')
    expect(orderRoute.match(/await releaseWarehouseLedgerForOrder\(tx/g)).toHaveLength(2)
    expect(orderRoute).toContain('await consumeWarehouseLedgerForShipment(tx')
    // The existing single-order path remains wired, plus the new batch path
    // posts one shadow reservation per member order.
    expect(orderRoute.match(/void postShadowWarehouseLedger\(\{/g)).toHaveLength(5)
    expect(orderRoute).toContain("ledgerMode?.inventoryMode === 'SHADOW'")
    expect(orderRoute).toContain("return { warehouseId: null, inventoryMode: 'OFF' as const }")
    expect(orderRoute).toContain('const shadowPostingQueues = new Map<string, Promise<void>>()')
    expect(orderRoute).toContain('effectiveAt: shippedAt')
    expect(orderRoute).toContain('orderUnitSnapshot: line.it.orderUnitSnapshot')
    expect(orderRoute).toContain('inventoryUnitSnapshot: line.it.inventoryUnitSnapshot')
    expect(orderRoute).toContain('inventoryUnitsPerOrderUnitSnapshot: line.it.inventoryUnitsPerOrderUnitSnapshot')
  })
})
