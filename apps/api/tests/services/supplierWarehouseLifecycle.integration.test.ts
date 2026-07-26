import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'
import { supplierStockRoutes } from '../../src/routes/supplierStock'
import {
  consumeSupplierStockForShipment,
  reserveSupplierStockForOrder,
} from '../../src/services/supplierStockReservation'

const databaseUrl = process.env.DATABASE_URL
function isCiDatabaseUrl(value: string) {
  try {
    return decodeURIComponent(new URL(value).pathname).replace(/^\/+/, '').endsWith('_ci')
  } catch {
    return false
  }
}
if (databaseUrl && !isCiDatabaseUrl(databaseUrl)) {
  throw new Error(
    '拒绝运行仓库生命周期测试：DATABASE_URL 的数据库名必须以 _ci 结尾',
  )
}
const describeWithSafeDatabase = databaseUrl ? describe : describe.skip

const suffix = `wh-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let tenantId = ''
let supplierId = ''
let storeId = ''
let userId = ''
let productAId = ''
let productBId = ''
let defaultWarehouseId = ''
let secondaryWarehouseId = ''
let app: ReturnType<typeof Fastify>

const orders: Array<{ id: string; itemIdA: string; itemIdB: string }> = []

function dec(value: number | string) {
  return new Prisma.Decimal(value)
}

async function readProductStock(productId: string) {
  return Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)
}

async function readWarehouseStock(warehouseId: string, productId: string) {
  const row = await prisma.warehouseStock.findUniqueOrThrow({
    where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
  })
  return Number(row.physicalQty)
}

async function assertMirrorConsistency(productId: string, warehouseId: string) {
  const productStock = await readProductStock(productId)
  const wsQty = await readWarehouseStock(warehouseId, productId)
  expect(productStock).toBe(wsQty)
}

function supplyChainActor() {
  return { tenantId, userId, role: 'SUPPLY_CHAIN' as const }
}

function stockWriteUrl(path: string) {
  return `/api/supplier/stock/${path}?supplierId=${encodeURIComponent(supplierId)}&warehouseId=default`
}

describeWithSafeDatabase('default warehouse lifecycle conservation (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `生命周期测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id

    const supplier = await prisma.supplier.create({
      data: { tenantId, no: `SUP-${suffix}`, name: '生命周期测试供应商', inventoryMode: 'STRICT' },
    })
    supplierId = supplier.id

    const store = await prisma.store.create({
      data: { tenantId, no: `STORE-${suffix}`, name: '生命周期测试门店' },
    })
    storeId = store.id

    const user = await prisma.user.create({
      data: {
        tenantId, name: '生命周期测试账号',
        email: `${suffix}@local.test`, password: 'integration-test-only',
        role: 'SUPPLY_CHAIN',
      },
    })
    userId = user.id

    const [productA, productB] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `${suffix}-A`, name: '生命周期鲜菌A',
          category: '菌菇', unit: '斤', price: 10, stock: 0,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `${suffix}-B`, name: '生命周期蔬菜B',
          category: '蔬菜', unit: '斤', price: 5, stock: 0,
        },
      }),
    ])
    productAId = productA.id
    productBId = productB.id

    defaultWarehouseId = (await prisma.warehouse.findFirstOrThrow({
      where: { tenantId, isDefault: true, isActive: true },
      select: { id: true },
    })).id

    const secondary = await prisma.warehouse.create({
      data: { tenantId, code: 'secondary', name: '非默认辅助仓' },
    })
    secondaryWarehouseId = secondary.id

    await prisma.warehouseStock.create({
      data: { tenantId, warehouseId: secondaryWarehouseId, productId: productAId, physicalQty: dec('999') },
    })
    await prisma.warehouseStock.create({
      data: { tenantId, warehouseId: secondaryWarehouseId, productId: productBId, physicalQty: dec('888') },
    })

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = supplyChainActor()
    })
    await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.warehouseStock.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderEvent.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderEvent.deleteMany({ where: { tenantId } })
    await prisma.deliveryOrderItem.deleteMany({ where: { deliveryOrder: { tenantId } } })
    await prisma.deliveryOrder.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.warehouse.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  // ── 1. 手工入库 ──────────────────────────────────────────────────────────

  it('manual inbound increases default warehouse stock and maintains mirror consistency', async () => {
    const res = await app.inject({
      method: 'POST',
      url: stockWriteUrl('inbound'),
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { productId: productAId, qty: 50 },
          { productId: productBId, qty: 30 },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.warehouseId).toBe(defaultWarehouseId)
    expect(body.items).toHaveLength(2)

    for (const item of body.items) {
      expect(item.warehouseId).toBe(defaultWarehouseId)
    }

    await assertMirrorConsistency(productAId, defaultWarehouseId)
    await assertMirrorConsistency(productBId, defaultWarehouseId)
    expect(await readProductStock(productAId)).toBe(50)
    expect(await readProductStock(productBId)).toBe(30)

    const movements = await prisma.supplierStockMovement.findMany({
      where: { tenantId, type: 'INBOUND_MANUAL' },
      orderBy: { createdAt: 'asc' },
    })
    expect(movements).toHaveLength(2)
    for (const m of movements) {
      expect(m.warehouseId).toBe(defaultWarehouseId)
    }

    const batches = await prisma.supplierStockBatch.findMany({
      where: { tenantId, kind: 'INBOUND' },
    })
    expect(batches).toHaveLength(2)
    for (const b of batches) {
      expect(b.warehouseId).toBe(defaultWarehouseId)
    }
  })

  it('non-default warehouse balances are untouched by default warehouse inbound', async () => {
    expect(await readWarehouseStock(secondaryWarehouseId, productAId)).toBe(999)
    expect(await readWarehouseStock(secondaryWarehouseId, productBId)).toBe(888)

    const secondaryMovements = await prisma.supplierStockMovement.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryMovements).toBe(0)

    const secondaryBatches = await prisma.supplierStockBatch.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryBatches).toBe(0)
  })

  // ── 2. 订单严格库存预占 ──────────────────────────────────────────────────

  it('order confirmation reserves stock in default warehouse with correct available qty', async () => {
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        no: `PO-LC-${suffix}-1`,
        storeId,
        supplierId,
        expectedDate: new Date('2026-08-10'),
        totalAmount: 300,
        status: 'SUBMITTED',
        createdById: userId,
        items: {
          create: [
            { productId: productAId, quantity: 10, unitPrice: 10, amount: 100 },
            { productId: productBId, quantity: 6, unitPrice: 5, amount: 30 },
          ],
        },
      },
      include: { items: true },
    })
    orders.push({
      id: order.id,
      itemIdA: order.items.find(i => i.productId === productAId)!.id,
      itemIdB: order.items.find(i => i.productId === productBId)!.id,
    })

    await prisma.$transaction(async (tx) => {
      const updated = await tx.purchaseOrder.updateMany({
        where: { id: order.id, status: 'SUBMITTED' },
        data: { status: 'CONFIRMED', rowVersion: { increment: 1 } },
      })
      expect(updated.count).toBe(1)

      await reserveSupplierStockForOrder(tx, {
        tenantId,
        supplierId,
        purchaseOrderId: order.id,
        lines: order.items.map(item => ({
          purchaseOrderItemId: item.id,
          productId: item.productId,
          quantity: item.quantity,
          productName: 'test',
        })),
      })
    })

    const reservations = await prisma.supplierStockReservation.findMany({
      where: { tenantId, purchaseOrderId: order.id, status: 'ACTIVE' },
    })
    expect(reservations).toHaveLength(2)
    for (const r of reservations) {
      expect(r.warehouseId).toBe(defaultWarehouseId)
    }

    const reservedA = Number(reservations.find(r => r.productId === productAId)!.quantity)
    const reservedB = Number(reservations.find(r => r.productId === productBId)!.quantity)
    expect(reservedA).toBe(10)
    expect(reservedB).toBe(6)

    expect(await readProductStock(productAId)).toBe(50)
    expect(await readProductStock(productBId)).toBe(30)
    expect(await readWarehouseStock(defaultWarehouseId, productAId)).toBe(50)
    expect(await readWarehouseStock(defaultWarehouseId, productBId)).toBe(30)
  })

  it('reservation does not create records in non-default warehouse', async () => {
    const secondaryReservations = await prisma.supplierStockReservation.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryReservations).toBe(0)
  })

  // ── 3. 部分发货关闭未发余量 ──────────────────────────────────────────────

  it('partial shipment consumes reserved qty and closes unshipped remainder', async () => {
    const order = orders[0]

    await prisma.$transaction(async (tx) => {
      await consumeSupplierStockForShipment(tx, {
        tenantId,
        supplierId,
        purchaseOrderId: order.id,
        deliveryOrderId: `delivery-partial-${suffix}`,
        orderNo: `PO-LC-${suffix}-1`,
        userId,
        lines: [
          { purchaseOrderItemId: order.itemIdA, productId: productAId, quantity: 10, shippedQty: 7, productName: 'A' },
          { purchaseOrderItemId: order.itemIdB, productId: productBId, quantity: 6, shippedQty: 6, productName: 'B' },
        ],
      })
    })

    await assertMirrorConsistency(productAId, defaultWarehouseId)
    await assertMirrorConsistency(productBId, defaultWarehouseId)

    expect(await readProductStock(productAId)).toBe(43)
    expect(await readProductStock(productBId)).toBe(24)

    const reservations = await prisma.supplierStockReservation.findMany({
      where: { tenantId, purchaseOrderId: order.id },
      orderBy: { productId: 'asc' },
    })

    const resA = reservations.find(r => r.productId === productAId)!
    expect(resA.status).toBe('CONSUMED')
    expect(Number(resA.fulfilledQty)).toBe(7)

    const resB = reservations.find(r => r.productId === productBId)!
    expect(resB.status).toBe('CONSUMED')
    expect(Number(resB.fulfilledQty)).toBe(6)

    const outboundMovements = await prisma.supplierStockMovement.findMany({
      where: { tenantId, type: 'OUTBOUND_PO', sourceId: `delivery-partial-${suffix}` },
    })
    expect(outboundMovements).toHaveLength(2)
    for (const m of outboundMovements) {
      expect(m.warehouseId).toBe(defaultWarehouseId)
    }

    const allocations = await prisma.supplierStockBatchAllocation.findMany({
      where: { tenantId },
    })
    for (const a of allocations) {
      expect(a.warehouseId).toBe(defaultWarehouseId)
    }
  })

  it('partial shipment does not affect non-default warehouse stock or batches', async () => {
    expect(await readWarehouseStock(secondaryWarehouseId, productAId)).toBe(999)
    expect(await readWarehouseStock(secondaryWarehouseId, productBId)).toBe(888)

    const secondaryAllocations = await prisma.supplierStockBatchAllocation.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryAllocations).toBe(0)
  })

  // ── 4. 库存调整 ──────────────────────────────────────────────────────────

  it('stock adjustment sets both mirrors to target and records movement in default warehouse', async () => {
    const res = await app.inject({
      method: 'POST',
      url: stockWriteUrl('adjust'),
      headers: { 'content-type': 'application/json' },
      payload: { productId: productAId, newQty: 40, reason: '盘点调整' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.warehouseId).toBe(defaultWarehouseId)
    expect(body.balanceAfter).toBe(40)

    await assertMirrorConsistency(productAId, defaultWarehouseId)
    expect(await readProductStock(productAId)).toBe(40)

    const adjustment = await prisma.supplierStockMovement.findFirstOrThrow({
      where: { tenantId, type: 'ADJUSTMENT', productId: productAId },
    })
    expect(adjustment.warehouseId).toBe(defaultWarehouseId)
    expect(Number(adjustment.balanceAfter)).toBe(40)
  })

  // ── 5. 报损 ──────────────────────────────────────────────────────────────

  it('loss decreases both mirrors and records movement in default warehouse', async () => {
    const res = await app.inject({
      method: 'POST',
      url: stockWriteUrl('loss'),
      headers: { 'content-type': 'application/json' },
      payload: { productId: productBId, qty: 4, reason: '变质报损' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.warehouseId).toBe(defaultWarehouseId)
    expect(body.balanceAfter).toBe(20)

    await assertMirrorConsistency(productBId, defaultWarehouseId)
    expect(await readProductStock(productBId)).toBe(20)

    const loss = await prisma.supplierStockMovement.findFirstOrThrow({
      where: { tenantId, type: 'LOSS', productId: productBId },
    })
    expect(loss.warehouseId).toBe(defaultWarehouseId)
    expect(Number(loss.balanceAfter)).toBe(20)
  })

  // ── 6. 盘点快照导入 ──────────────────────────────────────────────────────

  it('snapshot import adjusts both mirrors to target values in default warehouse', async () => {
    const res = await app.inject({
      method: 'POST',
      url: stockWriteUrl('import-snapshot'),
      headers: { 'content-type': 'application/json' },
      payload: {
        items: [
          { name: '生命周期鲜菌A', qty: 35 },
          { name: '生命周期蔬菜B', qty: 18 },
        ],
        reason: '月末盘点快照',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.warehouseId).toBe(defaultWarehouseId)
    expect(body.summary.adjusted).toBe(2)

    await assertMirrorConsistency(productAId, defaultWarehouseId)
    await assertMirrorConsistency(productBId, defaultWarehouseId)
    expect(await readProductStock(productAId)).toBe(35)
    expect(await readProductStock(productBId)).toBe(18)

    const snapshotMovements = await prisma.supplierStockMovement.findMany({
      where: { tenantId, sourceType: 'Snapshot' },
    })
    expect(snapshotMovements).toHaveLength(2)
    for (const m of snapshotMovements) {
      expect(m.warehouseId).toBe(defaultWarehouseId)
    }
  })

  it('snapshot import does not read or write non-default warehouse data', async () => {
    expect(await readWarehouseStock(secondaryWarehouseId, productAId)).toBe(999)
    expect(await readWarehouseStock(secondaryWarehouseId, productBId)).toBe(888)
  })

  // ── 7. 漂移原子性 ────────────────────────────────────────────────────────

  it('rejects inbound with 409 when Product.stock and WarehouseStock.physicalQty drift, without new records', async () => {
    const stockBefore = await readProductStock(productAId)
    const wsBefore = await readWarehouseStock(defaultWarehouseId, productAId)
    const movementCountBefore = await prisma.supplierStockMovement.count({ where: { tenantId, productId: productAId } })
    const batchCountBefore = await prisma.supplierStockBatch.count({ where: { tenantId, productId: productAId } })

    await prisma.warehouseStock.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId: defaultWarehouseId, productId: productAId } },
      data: { physicalQty: dec(wsBefore + 5) },
    })

    const res = await app.inject({
      method: 'POST',
      url: stockWriteUrl('inbound'),
      headers: { 'content-type': 'application/json' },
      payload: { items: [{ productId: productAId, qty: 10 }] },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('不一致')

    const movementCountAfter = await prisma.supplierStockMovement.count({ where: { tenantId, productId: productAId } })
    const batchCountAfter = await prisma.supplierStockBatch.count({ where: { tenantId, productId: productAId } })
    expect(movementCountAfter).toBe(movementCountBefore)
    expect(batchCountAfter).toBe(batchCountBefore)

    expect(await readProductStock(productAId)).toBe(stockBefore)
    expect(await readWarehouseStock(defaultWarehouseId, productAId)).toBe(wsBefore + 5)

    await prisma.warehouseStock.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId: defaultWarehouseId, productId: productAId } },
      data: { physicalQty: dec(stockBefore) },
    })
    await assertMirrorConsistency(productAId, defaultWarehouseId)
  })

  it('rejects adjust with 409 on drift without new records', async () => {
    const stockBefore = await readProductStock(productBId)
    const wsBefore = await readWarehouseStock(defaultWarehouseId, productBId)
    const movementCountBefore = await prisma.supplierStockMovement.count({ where: { tenantId, productId: productBId } })

    await prisma.warehouseStock.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId: defaultWarehouseId, productId: productBId } },
      data: { physicalQty: dec(wsBefore + 3) },
    })

    const res = await app.inject({
      method: 'POST',
      url: stockWriteUrl('adjust'),
      headers: { 'content-type': 'application/json' },
      payload: { productId: productBId, newQty: 15, reason: '漂移测试' },
    })
    expect(res.statusCode).toBe(409)

    const movementCountAfter = await prisma.supplierStockMovement.count({ where: { tenantId, productId: productBId } })
    expect(movementCountAfter).toBe(movementCountBefore)

    await prisma.warehouseStock.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId: defaultWarehouseId, productId: productBId } },
      data: { physicalQty: dec(wsBefore) },
    })
    await assertMirrorConsistency(productBId, defaultWarehouseId)
  })

  it('rejects reservation with 409 on drift without new reservations', async () => {
    const stockBefore = await readProductStock(productAId)
    const wsBefore = await readWarehouseStock(defaultWarehouseId, productAId)
    const reservationCountBefore = await prisma.supplierStockReservation.count({ where: { tenantId } })

    await prisma.warehouseStock.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId: defaultWarehouseId, productId: productAId } },
      data: { physicalQty: dec(wsBefore + 2) },
    })

    const driftOrder = await prisma.purchaseOrder.create({
      data: {
        tenantId, no: `PO-DRIFT-${suffix}`, storeId, supplierId,
        expectedDate: new Date('2026-08-15'), totalAmount: 50,
        status: 'SUBMITTED', createdById: userId,
        items: { create: { productId: productAId, quantity: 5, unitPrice: 10, amount: 50 } },
      },
      include: { items: true },
    })

    await expect(prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.updateMany({
        where: { id: driftOrder.id, status: 'SUBMITTED' },
        data: { status: 'CONFIRMED', rowVersion: { increment: 1 } },
      })
      await reserveSupplierStockForOrder(tx, {
        tenantId, supplierId, purchaseOrderId: driftOrder.id,
        lines: driftOrder.items.map(item => ({
          purchaseOrderItemId: item.id, productId: item.productId,
          quantity: item.quantity, productName: 'drift',
        })),
      })
    })).rejects.toMatchObject({ statusCode: 409 })

    const reservationCountAfter = await prisma.supplierStockReservation.count({ where: { tenantId } })
    expect(reservationCountAfter).toBe(reservationCountBefore)

    await prisma.warehouseStock.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId: defaultWarehouseId, productId: productAId } },
      data: { physicalQty: dec(stockBefore) },
    })
    await assertMirrorConsistency(productAId, defaultWarehouseId)

    await prisma.purchaseOrder.update({
      where: { id: driftOrder.id },
      data: { status: 'CANCELLED' },
    })
  })

  // ── 8. 非默认仓隔离验证 ──────────────────────────────────────────────────

  it('all default-warehouse fact tables exclusively use the default warehouseId', async () => {
    const allMovements = await prisma.supplierStockMovement.findMany({ where: { tenantId } })
    expect(allMovements.length).toBeGreaterThan(0)
    for (const m of allMovements) {
      expect(m.warehouseId).toBe(defaultWarehouseId)
    }

    const allBatches = await prisma.supplierStockBatch.findMany({ where: { tenantId } })
    for (const b of allBatches) {
      expect(b.warehouseId).toBe(defaultWarehouseId)
    }

    const allAllocations = await prisma.supplierStockBatchAllocation.findMany({ where: { tenantId } })
    for (const a of allAllocations) {
      expect(a.warehouseId).toBe(defaultWarehouseId)
    }

    const allReservations = await prisma.supplierStockReservation.findMany({ where: { tenantId } })
    for (const r of allReservations) {
      expect(r.warehouseId).toBe(defaultWarehouseId)
    }
  })

  it('non-default warehouse pre-seeded balances remain intact throughout the lifecycle', async () => {
    expect(await readWarehouseStock(secondaryWarehouseId, productAId)).toBe(999)
    expect(await readWarehouseStock(secondaryWarehouseId, productBId)).toBe(888)

    const secondaryMovements = await prisma.supplierStockMovement.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryMovements).toBe(0)

    const secondaryBatches = await prisma.supplierStockBatch.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryBatches).toBe(0)

    const secondaryAllocations = await prisma.supplierStockBatchAllocation.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryAllocations).toBe(0)

    const secondaryReservations = await prisma.supplierStockReservation.count({
      where: { tenantId, warehouseId: secondaryWarehouseId },
    })
    expect(secondaryReservations).toBe(0)
  })
})
