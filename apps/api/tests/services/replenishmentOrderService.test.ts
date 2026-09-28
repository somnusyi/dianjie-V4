import { describe, expect, it, vi } from 'vitest'
import { acceptReplenishmentInTransaction } from '../../src/services/replenishmentOrderService'

function fakeTransaction(options: { casCount?: number; replay?: boolean } = {}) {
  const product = {
    id: 'product-1', code: 'P001', name: '菌菇', spec: '1kg', unit: 'kg',
    purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
    unitConversionStatus: 'VERIFIED', inventoryUnitsPerPurchaseUnit: '1',
    inventoryUnitsPerOrderUnit: '1', inventoryUnitsPerCostUnit: '1',
  }
  const replenishment = {
    id: 'replenishment-1', tenantId: 'tenant-a', no: 'RO202609000001',
    storeId: 'store-a', supplierId: 'supplier-a', expectedDate: new Date('2026-09-30'),
    totalAmount: '100.00', status: 'SUBMITTED', note: '加急', submittedAt: new Date('2026-09-28'),
    createdById: 'creator-a', rowVersion: 1, fulfillment: null,
    store: { id: 'store-a', name: '门店A' },
    supplier: { id: 'supplier-a', name: '供应商A', sourceType: null, inventoryMode: 'NOT_TRACKED' },
    createdBy: { id: 'creator-a', name: '供应链A', role: 'SUPPLY_CHAIN' },
    items: [{
      id: 'replenishment-item-1', productId: product.id, quantity: '10', unitPrice: '10', amount: '100',
      productNameSnapshot: product.name, purchaseUnitSnapshot: 'kg', inventoryUnitSnapshot: 'kg',
      orderUnitSnapshot: 'kg', costUnitSnapshot: 'kg', unitConversionStatusSnapshot: 'VERIFIED',
      inventoryUnitsPerPurchaseUnitSnapshot: '1', inventoryUnitsPerOrderUnitSnapshot: '1',
      inventoryUnitsPerCostUnitSnapshot: '1', createdAt: new Date(), product,
    }],
  }
  const createdPurchaseOrder = {
    id: 'purchase-order-1', tenantId: 'tenant-a', no: 'PO202609000001',
    storeId: 'store-a', supplierId: 'supplier-a', expectedDate: replenishment.expectedDate,
    totalAmount: '100', originalTotalAmount: '100', currentOrderAmount: '100',
    status: 'CONFIRMED', note: '加急', submittedAt: replenishment.submittedAt,
    createdAt: new Date(), currentRevisionNo: 0,
    store: replenishment.store, supplier: replenishment.supplier, createdBy: replenishment.createdBy,
    items: [{
      id: 'purchase-item-1', productId: product.id, quantity: '10', originalQuantity: '10',
      unitPrice: '10', originalUnitPrice: '10', amount: '100', originalAmount: '100',
      lineOrigin: 'ORIGINAL', isActive: true, product,
      purchaseUnitSnapshot: 'kg', inventoryUnitSnapshot: 'kg', orderUnitSnapshot: 'kg', costUnitSnapshot: 'kg',
      unitConversionStatusSnapshot: 'VERIFIED', inventoryUnitsPerPurchaseUnitSnapshot: '1',
      inventoryUnitsPerOrderUnitSnapshot: '1', inventoryUnitsPerCostUnitSnapshot: '1',
    }],
  }
  const link = { id: 'link-1', tenantId: 'tenant-a', replenishmentOrderId: replenishment.id, purchaseOrderId: createdPurchaseOrder.id }
  const tx: any = {
    replenishmentOrderEvent: {
      findFirst: vi.fn().mockResolvedValue(options.replay ? { replenishmentOrderId: replenishment.id } : null),
      create: vi.fn().mockResolvedValue({}),
    },
    replenishmentFulfillmentLink: {
      findUnique: vi.fn().mockResolvedValue(options.replay ? { ...link, purchaseOrder: createdPurchaseOrder } : null),
      create: vi.fn().mockResolvedValue(link),
    },
    replenishmentOrder: {
      findFirst: vi.fn().mockResolvedValue(replenishment),
      updateMany: vi.fn().mockResolvedValue({ count: options.casCount ?? 1 }),
    },
    purchaseOrder: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(createdPurchaseOrder),
      update: vi.fn().mockResolvedValue(createdPurchaseOrder),
    },
    purchaseOrderEvent: { createMany: vi.fn().mockResolvedValue({ count: 3 }) },
    businessSequence: { upsert: vi.fn().mockResolvedValue({ value: 1 }), updateMany: vi.fn() },
    opLog: { create: vi.fn().mockResolvedValue({}) },
    warehouse: { findFirst: vi.fn() },
    supplier: { findFirst: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([{ sourceType: 'STORE_FULFILLER' }]),
  }
  return { tx, replenishment, createdPurchaseOrder }
}

const input = {
  tenantId: 'tenant-a', replenishmentOrderId: 'replenishment-1', actorId: 'supply-user',
  actorRole: 'SUPPLY_CHAIN', requestId: 'request-1', requestKey: 'accept-key-001', ip: '127.0.0.1',
}

describe('replenishment acceptance transaction', () => {
  it('atomically CASes the request and creates one formal confirmed PO, link and audit event', async () => {
    const { tx } = fakeTransaction()
    const result = await acceptReplenishmentInTransaction(tx, input)

    expect(result).toMatchObject({ replayed: false, purchaseOrder: { id: 'purchase-order-1', status: 'CONFIRMED' } })
    expect(tx.replenishmentOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-a', status: 'SUBMITTED', rowVersion: 1 }),
      data: expect.objectContaining({ status: 'ACCEPTED', acceptedById: 'supply-user' }),
    }))
    expect(tx.purchaseOrder.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CONFIRMED', storeId: 'store-a', supplierId: 'supplier-a' }),
    }))
    expect(tx.replenishmentFulfillmentLink.create).toHaveBeenCalledTimes(1)
    expect(tx.replenishmentOrderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'ACCEPTED', requestKey: 'accept-key-001' }),
    }))
    expect(tx.purchaseOrderEvent.createMany.mock.calls[0][0].data.map((event: any) => event.eventType)).toEqual([
      'CREATED', 'SUBMITTED', 'ACCEPTED',
    ])
  })

  it('returns the original linked PO for an idempotent replay without creating anything', async () => {
    const { tx } = fakeTransaction({ replay: true })
    const result = await acceptReplenishmentInTransaction(tx, input)
    expect(result).toMatchObject({ replayed: true, purchaseOrder: { id: 'purchase-order-1' } })
    expect(tx.replenishmentOrder.findFirst).not.toHaveBeenCalled()
    expect(tx.purchaseOrder.create).not.toHaveBeenCalled()
  })

  it('rejects a concurrent loser when the submitted rowVersion CAS no longer wins', async () => {
    const { tx } = fakeTransaction({ casCount: 0 })
    await expect(acceptReplenishmentInTransaction(tx, input)).rejects.toMatchObject({ statusCode: 409 })
    expect(tx.purchaseOrder.create).not.toHaveBeenCalled()
    expect(tx.replenishmentFulfillmentLink.create).not.toHaveBeenCalled()
  })

  it('rejects reuse of an acceptance idempotency key for another replenishment order', async () => {
    const { tx } = fakeTransaction({ replay: true })
    tx.replenishmentOrderEvent.findFirst.mockResolvedValue({ replenishmentOrderId: 'another-order' })
    await expect(acceptReplenishmentInTransaction(tx, input)).rejects.toMatchObject({ statusCode: 409 })
    expect(tx.replenishmentFulfillmentLink.findUnique).not.toHaveBeenCalled()
  })
})
