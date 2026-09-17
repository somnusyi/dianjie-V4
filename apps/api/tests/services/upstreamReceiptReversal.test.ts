import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@dianjie/db'

const mocks = vi.hoisted(() => ({ applyMarkupReprice: vi.fn() }))

vi.mock('../../src/services/markupPricing', () => ({
  applyMarkupReprice: (...args: any[]) => mocks.applyMarkupReprice(...args),
}))

import { reverseUpstreamReceiptInTransaction } from '../../src/services/warehouseLedger'

function originalMovement(remainingQty = 24) {
  return {
    id: 'movement-in-1',
    tenantId: 'tenant-1',
    warehouseId: 'warehouse-1',
    productId: 'product-1',
    physicalDelta: new Prisma.Decimal(24),
    valueDelta: new Prisma.Decimal(120),
    originalQuantity: new Prisma.Decimal(2),
    originalUnit: '箱',
    conversionFactor: new Prisma.Decimal(12),
    inventoryQuantity: new Prisma.Decimal(24),
    inventoryUnit: '瓶',
    inventoryUnitCost: new Prisma.Decimal(5),
    sourceName: '测试上游供应商',
    supplierId: 'supplier-1',
    reversal: null,
    product: { name: '矿泉水' },
    createdLot: {
      id: 'lot-1',
      initialQty: new Prisma.Decimal(24),
      remainingQty: new Prisma.Decimal(remainingQty),
      inventoryUnitCost: new Prisma.Decimal(5),
    },
  }
}

describe('upstream receipt reversal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.applyMarkupReprice.mockResolvedValue(null)
  })

  it('appends a reversal, restores the balance, and depletes the original lot', async () => {
    const original = originalMovement()
    const movementFindMany = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([original])
    const movementCreate = vi.fn().mockResolvedValue({ id: 'movement-reversal-1' })
    const balanceUpdate = vi.fn().mockResolvedValue({})
    const lotUpdate = vi.fn().mockResolvedValue({})
    const allocationCreate = vi.fn().mockResolvedValue({})
    const tx: any = {
      warehouseLedgerMovement: { findMany: movementFindMany, create: movementCreate },
      warehouseLedgerBalance: { upsert: vi.fn().mockResolvedValue({}), update: balanceUpdate },
      warehouseLedgerLot: { update: lotUpdate },
      warehouseLedgerLotAllocation: { create: allocationCreate },
      opLog: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([{
        id: 'balance-1',
        productId: 'product-1',
        inventoryUnit: '瓶',
        physicalQty: new Prisma.Decimal(34),
        reservedQty: new Prisma.Decimal(2),
        inventoryValue: new Prisma.Decimal(170),
        averageUnitCost: new Prisma.Decimal(5),
      }]),
    }

    const result = await reverseUpstreamReceiptInTransaction(tx, {
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      receiptId: 'receipt-1',
      receiptNo: 'URC202609000001',
      userId: 'operator-1',
      reason: '重复收货',
    })

    expect(result.replayed).toBe(false)
    expect(movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'REVERSAL',
        physicalDelta: new Prisma.Decimal(-24),
        valueDelta: new Prisma.Decimal(-120),
        physicalAfter: new Prisma.Decimal(10),
        valueAfter: new Prisma.Decimal(50),
        sourceType: 'UpstreamReceiptReversal',
        sourceId: 'receipt-1',
        sourceLineId: 'movement-in-1',
        reversalOfId: 'movement-in-1',
      }),
    })
    expect(balanceUpdate).toHaveBeenCalledWith({
      where: { id: 'balance-1' },
      data: expect.objectContaining({
        physicalQty: new Prisma.Decimal(10),
        inventoryValue: new Prisma.Decimal(50),
        averageUnitCost: new Prisma.Decimal(5),
      }),
    })
    expect(lotUpdate).toHaveBeenCalledWith({
      where: { id: 'lot-1' },
      data: { remainingQty: new Prisma.Decimal(0), depletedAt: expect.any(Date) },
    })
    expect(allocationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lotId: 'lot-1',
        movementId: 'movement-reversal-1',
        quantity: new Prisma.Decimal(24),
        value: new Prisma.Decimal(120),
      }),
    })
  })

  it('rejects an entire receipt reversal once any original lot has been consumed', async () => {
    const tx: any = {
      warehouseLedgerMovement: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([originalMovement(23)]),
      },
    }

    await expect(reverseUpstreamReceiptInTransaction(tx, {
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      receiptId: 'receipt-1',
      receiptNo: 'URC202609000001',
      userId: 'operator-1',
      reason: '录入错误',
    })).rejects.toThrow('已被发货、报损或调整')
  })
})
