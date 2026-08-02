import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import {
  postWarehouseReservationForOrder,
  postWarehouseShipment,
  recordManualWarehouseInbound,
  reverseManualWarehouseInbound,
} from '../../src/services/warehouseLedger'
import { resolveTenantWarehouseId } from '../../src/services/defaultWarehouse'

const suffix = `warehouse-ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let storeId = ''
let userId = ''
let productId = ''
let warehouseId = ''
let inboundMovementId = ''
let orderId = ''
let orderItemId = ''

function frozenLine(quantity: number, shippedQty?: number) {
  return {
    purchaseOrderItemId: orderItemId,
    productId,
    quantity,
    shippedQty,
    productName: '总仓测试菌菇',
    productUnit: '箱',
    orderUnitSnapshot: '箱',
    inventoryUnitSnapshot: '袋',
    inventoryUnitsPerOrderUnitSnapshot: 8,
  }
}

describe('central warehouse ledger (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `总仓账测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({
      data: {
        tenantId,
        no: `WH-${suffix}`,
        name: '中央仓测试主体',
        sourceType: 'HEADQ_WAREHOUSE',
      },
    })
    supplierId = supplier.id
    const store = await prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '总仓账测试门店' } })
    storeId = store.id
    const user = await prisma.user.create({
      data: {
        tenantId,
        name: '总仓账测试管理员',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'ADMIN',
      },
    })
    userId = user.id
    const product = await prisma.product.create({
      data: {
        tenantId,
        supplierId,
        code: `P-${suffix}`,
        name: '总仓测试菌菇',
        category: '菌菇',
        unit: '箱',
        price: 80,
        purchaseUnit: '箱',
        orderUnit: '箱',
        costUnit: '袋',
        inventoryUnit: '袋',
        inventoryUnitsPerPurchaseUnit: 8,
        inventoryUnitsPerOrderUnit: 8,
        inventoryUnitsPerCostUnit: 1,
        unitConversionStatus: 'VERIFIED',
        stock: 0,
      },
    })
    productId = product.id
    warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)

    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        no: `PO-${suffix}`,
        storeId,
        supplierId,
        expectedDate: new Date('2026-08-03'),
        totalAmount: 80,
        status: 'CONFIRMED',
        createdById: userId,
        items: {
          create: {
            productId,
            quantity: 1,
            originalQuantity: 1,
            unitPrice: 80,
            amount: 80,
            purchaseUnitSnapshot: '箱',
            orderUnitSnapshot: '箱',
            costUnitSnapshot: '袋',
            inventoryUnitSnapshot: '袋',
            inventoryUnitsPerPurchaseUnitSnapshot: 8,
            inventoryUnitsPerOrderUnitSnapshot: 8,
            inventoryUnitsPerCostUnitSnapshot: 1,
            unitConversionStatusSnapshot: 'VERIFIED',
          },
        },
      },
      include: { items: true },
    })
    orderId = order.id
    orderItemId = order.items[0].id
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerReservation.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
    await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.warehouse.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('serializes concurrent identical inbound requests without duplicate stock', async () => {
    const input = {
      tenantId,
      userId,
      productId,
      purchaseQuantity: 2,
      totalAmount: 160,
      effectiveAt: new Date('2026-08-02T08:00:00+08:00'),
      idempotencyKey: `inbound-${suffix}`,
      sourceName: '集成测试采购',
      batchNo: `BATCH-${suffix}`,
    }
    const results = await Promise.all([
      recordManualWarehouseInbound(input),
      recordManualWarehouseInbound(input),
    ])
    expect(results.map(result => result.replayed).sort()).toEqual([false, true])
    inboundMovementId = results[0].movement.id

    const balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(Number(balance.physicalQty)).toBe(16)
    expect(Number(balance.inventoryValue)).toBe(160)
    expect(Number(balance.averageUnitCost)).toBe(10)
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, warehouseId, productId, type: 'MANUAL_INBOUND' },
    })).toBe(1)
    expect(await prisma.warehouseLedgerLot.count({ where: { tenantId, warehouseId, productId } })).toBe(1)
  })

  it('reserves order units and deducts only the actual shipped quantity once', async () => {
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { inventoryMode: 'STRICT', inventoryActivatedAt: new Date() },
    })
    await postWarehouseReservationForOrder({
      tenantId,
      purchaseOrderId: orderId,
      userId,
      lines: [frozenLine(1)],
    })

    let balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(Number(balance.physicalQty)).toBe(16)
    expect(Number(balance.reservedQty)).toBe(8)

    const shipment = {
      tenantId,
      purchaseOrderId: orderId,
      deliveryOrderId: `DO-${suffix}`,
      orderNo: `PO-${suffix}`,
      userId,
      effectiveAt: new Date('2026-08-02T10:00:00+08:00'),
      lines: [frozenLine(1, 0.5)],
    }
    await postWarehouseShipment(shipment)
    await postWarehouseShipment(shipment)

    balance = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
    })
    expect(Number(balance.physicalQty)).toBe(12)
    expect(Number(balance.reservedQty)).toBe(0)
    expect(Number(balance.inventoryValue)).toBe(120)
    expect(await prisma.warehouseLedgerMovement.count({
      where: { tenantId, warehouseId, sourceId: `DO-${suffix}`, type: 'ORDER_OUTBOUND' },
    })).toBe(1)
    const reservation = await prisma.warehouseLedgerReservation.findUniqueOrThrow({ where: { purchaseOrderItemId: orderItemId } })
    expect(reservation.status).toBe('CONSUMED')
    expect(Number(reservation.fulfilledInventoryQty)).toBe(4)
    const lot = await prisma.warehouseLedgerLot.findFirstOrThrow({ where: { tenantId, warehouseId, productId } })
    expect(Number(lot.remainingQty)).toBe(12)
  })

  it('blocks over-reservation and refuses to reverse an inbound batch after consumption', async () => {
    const oversized = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        no: `PO-OVER-${suffix}`,
        storeId,
        supplierId,
        expectedDate: new Date('2026-08-03'),
        totalAmount: 160,
        status: 'CONFIRMED',
        createdById: userId,
        items: {
          create: {
            productId,
            quantity: 2,
            unitPrice: 80,
            amount: 160,
            orderUnitSnapshot: '箱',
            inventoryUnitSnapshot: '袋',
            inventoryUnitsPerOrderUnitSnapshot: 8,
          },
        },
      },
      include: { items: true },
    })
    await expect(postWarehouseReservationForOrder({
      tenantId,
      purchaseOrderId: oversized.id,
      userId,
      lines: [{ ...frozenLine(2), purchaseOrderItemId: oversized.items[0].id }],
    })).rejects.toMatchObject({ statusCode: 409 })

    await expect(reverseManualWarehouseInbound({
      tenantId,
      userId,
      movementId: inboundMovementId,
      reason: '验证已消耗批次不可整笔冲销',
      idempotencyKey: `reverse-${suffix}`,
    })).rejects.toMatchObject({ statusCode: 409 })
  })
})
