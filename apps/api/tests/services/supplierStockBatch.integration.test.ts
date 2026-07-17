import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'
import {
  applySupplierStockBatchDelta,
  consumeSupplierStockBatches,
  createSupplierStockBatchIncrease,
} from '../../src/services/supplierStockBatch'

const suffix = `stock-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let productId = ''
let userId = ''

describe('supplier stock batches (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `批次测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '批次测试供应商' } })
    supplierId = supplier.id
    const user = await prisma.user.create({
      data: {
        tenantId, supplierId, name: '批次测试账号', email: `${suffix}@local.test`,
        password: 'integration-test-only', role: 'SUPPLIER_OWNER',
      },
    })
    userId = user.id
    const product = await prisma.product.create({
      data: { tenantId, supplierId, code: `P-${suffix}`, name: '批次测试鲜菌', price: 10, stock: 10 },
    })
    productId = product.id
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId, batchNo: `OPENING-${suffix}`, kind: 'OPENING',
        initialQty: 2, remainingQty: 2, createdById: userId,
      },
    })
    for (const lot of [
      { qty: 5, expiry: new Date('2026-08-31'), suffix: 'LATE' },
      { qty: 3, expiry: new Date('2026-07-31'), suffix: 'EARLY' },
    ]) {
      const movement = await prisma.supplierStockMovement.create({
        data: {
          tenantId, supplierId, productId, delta: lot.qty, balanceAfter: 10,
          type: 'INBOUND_MANUAL', sourceType: 'Test', sourceId: lot.suffix,
          expiryDate: lot.expiry, createdById: userId,
        },
      })
      await prisma.$transaction(tx => createSupplierStockBatchIncrease(tx, {
        tenantId, supplierId, productId, quantity: lot.qty, movementId: movement.id,
        createdById: userId, kind: 'INBOUND', batchNo: `${lot.suffix}-${suffix}`, expiryDate: lot.expiry,
      }))
    }
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('consumes opening stock first and then FEFO lots with allocations', async () => {
    const movement = await prisma.supplierStockMovement.create({
      data: {
        tenantId, supplierId, productId, delta: -6, balanceAfter: 4,
        type: 'OUTBOUND_PO', sourceType: 'Test', sourceId: `OUT-${suffix}`, createdById: userId,
      },
    })
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${productId} FOR UPDATE`
      await consumeSupplierStockBatches(tx, {
        tenantId, supplierId, productId, quantity: 6, movementId: movement.id,
      })
      await tx.product.update({ where: { id: productId }, data: { stock: 4 } })
    })

    const batches = await prisma.supplierStockBatch.findMany({
      where: { tenantId, productId }, orderBy: { batchNo: 'asc' },
    })
    const remaining = new Map(batches.map(batch => [batch.batchNo.split('-')[0], Number(batch.remainingQty)]))
    expect(remaining.get('OPENING')).toBe(0)
    expect(remaining.get('EARLY')).toBe(0)
    expect(remaining.get('LATE')).toBe(4)
    const allocations = await prisma.supplierStockBatchAllocation.findMany({ where: { movementId: movement.id } })
    expect(allocations.map(row => Number(row.quantity)).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('creates a separate lot for positive adjustments', async () => {
    const movement = await prisma.supplierStockMovement.create({
      data: {
        tenantId, supplierId, productId, delta: 1.5, balanceAfter: 5.5,
        type: 'ADJUSTMENT', sourceType: 'Test', sourceId: `ADJ-${suffix}`, createdById: userId,
      },
    })
    await prisma.$transaction(async tx => {
      await applySupplierStockBatchDelta(tx, {
        tenantId, supplierId, productId, delta: new Prisma.Decimal(1.5),
        movementId: movement.id, createdById: userId,
      })
      await tx.product.update({ where: { id: productId }, data: { stock: 5.5 } })
    })
    const batch = await prisma.supplierStockBatch.findUniqueOrThrow({ where: { sourceMovementId: movement.id } })
    expect(batch.kind).toBe('ADJUSTMENT')
    expect(Number(batch.remainingQty)).toBe(1.5)
  })
})
