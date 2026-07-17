import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import {
  consumeSupplierStockForShipment,
  getSupplierReservedStock,
  releaseSupplierStockForOrder,
  reserveSupplierStockForOrder,
  stockAvailability,
} from '../../src/services/supplierStockReservation'

const suffix = `stock-reservation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let userId = ''
let productId = ''
const orders: Array<{ id: string; itemId: string }> = []

describe('supplier stock reservation (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `库存预占测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '库存预占测试供应商' } })
    supplierId = supplier.id
    const store = await prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '库存预占测试门店' } })
    storeId = store.id
    const user = await prisma.user.create({
      data: {
        tenantId,
        supplierId,
        name: '库存预占测试账号',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'SUPPLIER_OWNER',
      },
    })
    userId = user.id
    const product = await prisma.product.create({
      data: { tenantId, supplierId, code: `${suffix}-P`, name: '测试鲜菌', category: '菌菇', price: 10, stock: 10 },
    })
    productId = product.id
    await prisma.supplierStockBatch.create({
      data: {
        tenantId, supplierId, productId, batchNo: `OPENING-${suffix}`, kind: 'OPENING',
        initialQty: 10, remainingQty: 10, createdById: userId,
      },
    })

    for (let index = 1; index <= 3; index++) {
      const order = await prisma.purchaseOrder.create({
        data: {
          tenantId,
          no: `PO-${suffix}-${index}`,
          storeId,
          supplierId,
          expectedDate: new Date('2026-07-20'),
          totalAmount: 60,
          status: 'SUBMITTED',
          createdById: userId,
          items: {
            create: { productId, quantity: 6, unitPrice: 10, amount: 60 },
          },
        },
        include: { items: true },
      })
      orders.push({ id: order.id, itemId: order.items[0].id })
    }
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
    await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
    await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  const reserve = (order: { id: string; itemId: string }, quantity: number) => prisma.$transaction(tx =>
    reserveSupplierStockForOrder(tx, {
      tenantId,
      supplierId,
      purchaseOrderId: order.id,
      lines: [{ purchaseOrderItemId: order.itemId, productId, quantity, productName: '测试鲜菌' }],
    }),
  )

  it('serializes concurrent confirmations and prevents over-reservation', async () => {
    const attempts = await Promise.allSettled([
      reserve(orders[0], 6),
      reserve(orders[1], 6),
    ])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)

    const active = await prisma.supplierStockReservation.findMany({ where: { tenantId, status: 'ACTIVE' } })
    expect(active).toHaveLength(1)
    expect(Number(active[0].quantity)).toBe(6)
    const reserved = await getSupplierReservedStock({ tenantId, supplierId, productIds: [productId] })
    expect(stockAvailability(10, reserved.get(productId) || 0)).toEqual({
      physicalStock: 10,
      reservedStock: 6,
      availableStock: 4,
    })

    await prisma.$transaction(tx => releaseSupplierStockForOrder(tx, active[0].purchaseOrderId))
    // 下一用例使用同一批测试订单；生产代码从不删除预占审计记录。
    await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
  })

  it('protects other confirmed orders during shipment and consumes only this order reservation', async () => {
    await reserve(orders[0], 6)
    await reserve(orders[1], 4)

    await expect(prisma.$transaction(tx => consumeSupplierStockForShipment(tx, {
      tenantId,
      supplierId,
      purchaseOrderId: orders[0].id,
      deliveryOrderId: `delivery-failed-${suffix}`,
      orderNo: `PO-${suffix}-1`,
      userId,
      lines: [{
        purchaseOrderItemId: orders[0].itemId,
        productId,
        quantity: 6,
        shippedQty: 7,
        productName: '测试鲜菌',
      }],
    }))).rejects.toMatchObject({ statusCode: 409 })
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(10)

    await prisma.$transaction(tx => consumeSupplierStockForShipment(tx, {
      tenantId,
      supplierId,
      purchaseOrderId: orders[0].id,
      deliveryOrderId: `delivery-success-${suffix}`,
      orderNo: `PO-${suffix}-1`,
      userId,
      lines: [{
        purchaseOrderItemId: orders[0].itemId,
        productId,
        quantity: 6,
        shippedQty: 6,
        productName: '测试鲜菌',
      }],
    }))

    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock)).toBe(4)
    const reservations = await prisma.supplierStockReservation.findMany({
      where: { purchaseOrderId: { in: [orders[0].id, orders[1].id] } },
      orderBy: { purchaseOrderId: 'asc' },
    })
    expect(reservations.find(row => row.purchaseOrderId === orders[0].id)).toMatchObject({ status: 'CONSUMED' })
    expect(Number(reservations.find(row => row.purchaseOrderId === orders[0].id)?.fulfilledQty)).toBe(6)
    expect(reservations.find(row => row.purchaseOrderId === orders[1].id)).toMatchObject({ status: 'ACTIVE' })
    expect(await prisma.supplierStockMovement.count({
      where: { tenantId, sourceId: `delivery-success-${suffix}`, type: 'OUTBOUND_PO' },
    })).toBe(1)
    const batch = await prisma.supplierStockBatch.findFirstOrThrow({ where: { tenantId, productId } })
    expect(Number(batch.remainingQty)).toBe(4)
    expect(await prisma.supplierStockBatchAllocation.count({ where: { tenantId, productId } })).toBe(1)

    await prisma.$transaction(tx => releaseSupplierStockForOrder(tx, orders[1].id))
  })
})
