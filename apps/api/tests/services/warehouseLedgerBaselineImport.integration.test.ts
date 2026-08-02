import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { resolveTenantWarehouseId } from '../../src/services/defaultWarehouse'
import { recordManualWarehouseInbound } from '../../src/services/warehouseLedger'
import { recordWarehouseBaselineSnapshot } from '../../src/services/warehouseLedgerBaselineImport'

const suffix = `warehouse-baseline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let warehouseId = ''
let supplierId = ''
let userId = ''
const productIds: string[] = []

async function createProduct(label: string) {
  const product = await prisma.product.create({
    data: {
      tenantId,
      supplierId,
      code: `BL-${label}-${suffix}`,
      name: `基线测试${label}`,
      category: '基线测试',
      unit: '袋',
      price: 10,
      purchaseUnit: '袋',
      orderUnit: '袋',
      costUnit: '袋',
      inventoryUnit: '袋',
      inventoryUnitsPerPurchaseUnit: 1,
      inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'VERIFIED',
    },
  })
  productIds.push(product.id)
  return product
}

async function createImport(input: {
  label: string
  snapshotAt: Date
  items: Array<{ productId: string | null; quantity: number; amount: number; code?: string }>
}) {
  const record = await prisma.warehouseInventoryImport.create({
    data: {
      tenantId,
      warehouseId,
      no: `WBI-${input.label}-${suffix.slice(-12)}`,
      source: 'MEITUAN',
      sourceFilename: `${input.label}.xlsx`,
      fileHash: input.label.padEnd(64, '0').slice(0, 64),
      sourceWarehouseName: '供应链总仓',
      snapshotDate: input.snapshotAt,
      sourceRowCount: input.items.length,
      itemCount: input.items.length,
      matchedCount: input.items.filter(item => item.productId).length,
      blockingCount: input.items.filter(item => !item.productId && item.quantity > 0).length,
      warningCount: 0,
      detailTotalAmount: input.items.reduce((sum, item) => sum + item.amount, 0),
      sourceTotalAmount: input.items.reduce((sum, item) => sum + item.amount, 0),
      metadata: { baselineApplied: false },
      createdById: userId,
    },
  })
  await prisma.warehouseInventoryImportItem.createMany({
    data: input.items.map((item, index) => ({
      tenantId,
      importId: record.id,
      rowNumber: index + 4,
      externalCode: item.code || `EXT-${input.label}-${index}`,
      externalName: `外部商品${index}`,
      sourceWarehouseName: '供应链总仓',
      purchaseUnit: '袋',
      conversionText: '1袋=1袋',
      sourceQuantity: item.quantity,
      inventoryAmount: item.amount,
      inventoryAmountExcludingTax: item.amount,
      inventoryTax: 0,
      averageCostExcludingTax: item.quantity > 0 ? item.amount / item.quantity : 0,
      expectedInboundQuantity: 0,
      expectedOutboundQuantity: 0,
      theoreticalQuantity: item.quantity,
      theoreticalAmount: item.amount,
      productId: item.productId,
      matchSource: item.productId ? 'EXACT_CODE' : null,
      inventoryUnit: item.productId ? '袋' : null,
      conversionFactor: item.productId ? 1 : null,
      normalizedQuantity: item.productId ? item.quantity : null,
      issues: item.productId || item.quantity === 0 ? [] : [{ code: 'SKU_UNMATCHED', message: '未匹配' }],
      warnings: [],
      rawData: {},
    })),
  })
  return record
}

function applyImport(importId: string) {
  return recordWarehouseBaselineSnapshot({
    tenantId,
    userId,
    role: 'ADMIN',
    importId,
    rowVersion: 0,
  })
}

describe('warehouse ledger baseline import transaction (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `基线事务测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({
      data: { tenantId, no: `BL-${suffix}`, name: '基线测试供应商', sourceType: 'HEADQ_WAREHOUSE' },
    })
    supplierId = supplier.id
    const user = await prisma.user.create({
      data: {
        tenantId,
        name: '基线测试管理员',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'ADMIN',
      },
    })
    userId = user.id
    warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerReservation.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
    await prisma.warehouseInventoryImport.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.warehouse.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('rolls back earlier ledger writes when a later baseline item fails', async () => {
    const products = [await createProduct('rollback-a'), await createProduct('rollback-b')]
      .sort((a, b) => a.id.localeCompare(b.id))
    const snapshotAt = new Date('2026-07-31T23:59:59+08:00')
    const record = await createImport({
      label: 'rollback',
      snapshotAt,
      items: [
        { productId: products[0].id, quantity: 5, amount: 50 },
        { productId: products[1].id, quantity: 3, amount: 0 },
      ],
    })

    await expect(applyImport(record.id)).rejects.toThrow('有基线库存时金额必须大于0')

    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceId: record.id } })).toBe(0)
    expect(await prisma.warehouseLedgerBalance.count({
      where: { tenantId, productId: { in: products.map(product => product.id) } },
    })).toBe(0)
    expect(await prisma.opLog.count({ where: { tenantId, targetId: record.id } })).toBe(0)
    const unchanged = await prisma.warehouseInventoryImport.findUniqueOrThrow({ where: { id: record.id } })
    expect(unchanged.rowVersion).toBe(0)
    expect(unchanged.metadata).toMatchObject({ baselineApplied: false })
    expect(await prisma.warehouseInventoryImportItem.count({
      where: { importId: record.id, movementId: { not: null } },
    })).toBe(0)
  })

  it('serializes concurrent duplicate submissions and applies the import once', async () => {
    const product = await createProduct('duplicate')
    const snapshotAt = new Date('2026-07-31T23:59:59+08:00')
    const record = await createImport({
      label: 'duplicate',
      snapshotAt,
      items: [{ productId: product.id, quantity: 6, amount: 60 }],
    })

    const results = await Promise.allSettled([applyImport(record.id), applyImport(record.id)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceId: record.id } })).toBe(1)
    expect(await prisma.opLog.count({
      where: { tenantId, entityType: 'WarehouseInventoryImport', targetId: record.id },
    })).toBe(1)
    const applied = await prisma.warehouseInventoryImport.findUniqueOrThrow({ where: { id: record.id } })
    expect(applied.status).toBe('CONFIRMED')
    expect(applied.rowVersion).toBe(1)
    expect(applied.metadata).toMatchObject({ baselineApplied: true })
  })

  it('applies mapped zero rows and clears stale balance and positive lots', async () => {
    const product = await createProduct('zero')
    await recordManualWarehouseInbound({
      tenantId,
      userId,
      productId: product.id,
      purchaseQuantity: 8,
      totalAmount: 80,
      effectiveAt: new Date('2026-07-30T10:00:00+08:00'),
      idempotencyKey: `zero-opening-${suffix}`,
      sourceName: '基线清零前入库',
    })
    const snapshotAt = new Date('2026-07-31T23:59:59+08:00')
    const record = await createImport({
      label: 'zero',
      snapshotAt,
      items: [
        { productId: product.id, quantity: 0, amount: 0 },
        { productId: null, quantity: 0, amount: 0, code: 'UNMATCHED-ZERO' },
      ],
    })

    const result = await applyImport(record.id)
    expect(result.blocked).toBe(false)
    expect(result.snapshotAt).toBe('2026-07-31T15:59:59.999Z')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ productId: product.id, physicalAfter: '0', valueAfter: '0' })
    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId: product.id } },
    })
    expect(Number(balance.physicalQty)).toBe(0)
    expect(Number(balance.inventoryValue)).toBe(0)
    expect(await prisma.warehouseLedgerLot.count({
      where: { tenantId, warehouseId, productId: product.id, remainingQty: { gt: 0 } },
    })).toBe(0)
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceId: record.id } })).toBe(1)
    const importItems = await prisma.warehouseInventoryImportItem.findMany({
      where: { importId: record.id },
      orderBy: { rowNumber: 'asc' },
    })
    expect(importItems[0].movementId).not.toBeNull()
    expect(Number(importItems[0].oldQuantity)).toBe(8)
    expect(Number(importItems[0].delta)).toBe(-8)
    expect(importItems[1].movementId).toBeNull()
  })

  it('blocks an historical baseline when a mapped product has later ledger facts', async () => {
    const product = await createProduct('later')
    const snapshotAt = new Date('2026-07-31T23:59:59+08:00')
    await recordManualWarehouseInbound({
      tenantId,
      userId,
      productId: product.id,
      purchaseQuantity: 2,
      totalAmount: 20,
      effectiveAt: new Date('2026-08-01T08:00:00+08:00'),
      idempotencyKey: `later-${suffix}`,
      sourceName: '快照后入库',
    })
    const record = await createImport({
      label: 'later',
      snapshotAt,
      items: [{ productId: product.id, quantity: 5, amount: 50 }],
    })

    await expect(applyImport(record.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId, sourceId: record.id } })).toBe(0)
    const unchanged = await prisma.warehouseInventoryImport.findUniqueOrThrow({ where: { id: record.id } })
    expect(unchanged.rowVersion).toBe(0)
    expect(unchanged.metadata).toMatchObject({ baselineApplied: false })
  })
})
