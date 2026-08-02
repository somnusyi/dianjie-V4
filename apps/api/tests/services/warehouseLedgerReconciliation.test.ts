import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  opLogCreate: vi.fn(),
  getMode: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  shipment: vi.fn(),
}))

vi.mock('@dianjie/db', () => ({
  prisma: {
    purchaseOrder: { findMany: mocks.findMany },
    opLog: { create: mocks.opLogCreate },
  },
}))

vi.mock('../../src/services/warehouseLedger', () => ({
  getWarehouseLedgerMode: mocks.getMode,
  postWarehouseReservationForOrder: mocks.reserve,
  postWarehouseReleaseForOrder: mocks.release,
  postWarehouseShipment: mocks.shipment,
}))

import { reconcileWarehouseShadowLedger } from '../../src/services/warehouseLedgerReconciliation'

function order(id: string, status: string, shipped = false) {
  return {
    id,
    no: `PO-${id}`,
    status,
    shippedAt: shipped ? new Date('2026-08-02T02:00:00.000Z') : null,
    items: [{
      id: `item-${id}`,
      productId: 'product-1',
      quantity: 2,
      shippedQty: shipped ? 1 : null,
      orderUnitSnapshot: '箱',
      inventoryUnitSnapshot: '袋',
      inventoryUnitsPerOrderUnitSnapshot: 8,
      product: { name: '菌菇酱', unit: '箱' },
    }],
    deliveries: shipped ? [{ id: `delivery-${id}`, shippedAt: new Date('2026-08-02T02:00:00.000Z') }] : [],
  }
}

describe('warehouse shadow ledger reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMode.mockResolvedValue({ warehouseId: 'warehouse-1', inventoryMode: 'SHADOW' })
    mocks.opLogCreate.mockResolvedValue({ id: 'log-1' })
    mocks.reserve.mockResolvedValue(undefined)
    mocks.release.mockResolvedValue(undefined)
    mocks.shipment.mockResolvedValue(undefined)
  })

  it('fails closed unless the warehouse is explicitly in SHADOW', async () => {
    mocks.getMode.mockResolvedValue({ warehouseId: 'warehouse-1', inventoryMode: 'OFF' })

    await expect(reconcileWarehouseShadowLedger({ tenantId: 'tenant-1', userId: 'user-1' }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('returns a stable cursor and applies only the current order state', async () => {
    mocks.findMany.mockResolvedValue([
      order('001', 'CONFIRMED'),
      order('002', 'CANCELLED'),
      order('003', 'DELIVERING', true),
    ])

    const result = await reconcileWarehouseShadowLedger({
      tenantId: 'tenant-1', userId: 'user-1', limit: 2,
    })

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }))
    expect(mocks.reserve).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.shipment).not.toHaveBeenCalled()
    expect(result).toMatchObject({ scanned: 2, reserved: 1, released: 1, shipped: 0, nextCursor: '002' })
  })

  it('continues after a cursor and rebuilds shipment from durable delivery facts', async () => {
    mocks.findMany.mockResolvedValue([order('003', 'DELIVERING', true)])

    const result = await reconcileWarehouseShadowLedger({
      tenantId: 'tenant-1', userId: 'user-1', limit: 2, cursor: '002',
    })

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { id: '002' }, skip: 1, take: 3,
    }))
    expect(mocks.shipment).toHaveBeenCalledWith(expect.objectContaining({
      purchaseOrderId: '003', deliveryOrderId: 'delivery-003',
      lines: [expect.objectContaining({ shippedQty: 1, inventoryUnitsPerOrderUnitSnapshot: 8 })],
    }))
    expect(result).toMatchObject({ scanned: 1, shipped: 1, nextCursor: null, failures: [] })
  })

  it('isolates one bad historical order and continues the page', async () => {
    mocks.findMany.mockResolvedValue([order('001', 'CONFIRMED'), order('002', 'CANCELLED')])
    mocks.reserve.mockRejectedValueOnce(new Error('缺少冻结单位'))

    const result = await reconcileWarehouseShadowLedger({
      tenantId: 'tenant-1', userId: 'user-1', limit: 10,
    })

    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(result.failures).toEqual([{ purchaseOrderId: '001', orderNo: 'PO-001', error: '缺少冻结单位' }])
    expect(mocks.opLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entityType: 'WarehouseLedgerShadowReconcile' }),
    }))
  })
})
