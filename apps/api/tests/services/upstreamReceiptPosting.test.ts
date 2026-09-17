import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@dianjie/db'

const mocks = vi.hoisted(() => ({ applyMarkupReprice: vi.fn() }))

vi.mock('../../src/services/markupPricing', () => ({
  applyMarkupReprice: (...args: any[]) => mocks.applyMarkupReprice(...args),
}))

import { postUpstreamReceiptInTransaction } from '../../src/services/warehouseLedger'

describe('upstream receipt warehouse posting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.applyMarkupReprice.mockResolvedValue(null)
  })

  it('uses frozen receipt values and links one immutable upstream movement and lot', async () => {
    const movementCreate = vi.fn().mockResolvedValue({ id: 'movement-1' })
    const balanceUpdate = vi.fn().mockResolvedValue({})
    const lotCreate = vi.fn().mockResolvedValue({ id: 'lot-1', batchNo: 'BATCH-001' })
    const receiptLineUpdate = vi.fn().mockResolvedValue({})
    const opLogCreate = vi.fn().mockResolvedValue({})
    const tx: any = {
      warehouseLedgerMovement: {
        findMany: vi.fn().mockResolvedValue([]),
        create: movementCreate,
      },
      warehouseLedgerBalance: {
        upsert: vi.fn().mockResolvedValue({}),
        update: balanceUpdate,
      },
      warehouseLedgerLot: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: lotCreate,
      },
      upstreamReceiptLine: { update: receiptLineUpdate },
      opLog: { create: opLogCreate },
      $queryRaw: vi.fn().mockResolvedValue([{
        id: 'balance-1',
        productId: 'product-1',
        inventoryUnit: '瓶',
        physicalQty: new Prisma.Decimal(10),
        reservedQty: new Prisma.Decimal(2),
        inventoryValue: new Prisma.Decimal(50),
        averageUnitCost: new Prisma.Decimal(5),
      }]),
    }

    const result = await postUpstreamReceiptInTransaction(tx, {
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      supplierId: 'supplier-1',
      supplierName: '测试上游供应商',
      receiptId: 'receipt-1',
      receiptNo: 'URC202609000001',
      userId: 'receiver-1',
      effectiveAt: new Date('2026-09-16T03:00:00.000Z'),
      lines: [{
        receiptLineId: 'receipt-line-1',
        productId: 'product-1',
        productName: '矿泉水',
        purchaseQuantity: 2,
        purchaseUnit: '箱',
        conversionFactor: 12,
        inventoryQuantity: 24,
        inventoryUnit: '瓶',
        totalAmount: 120,
        batchNo: 'BATCH-001',
      }],
    })

    expect(result.replayed).toBe(false)
    expect(movementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'UPSTREAM_RECEIPT',
        sourceType: 'UpstreamReceipt',
        sourceId: 'receipt-1',
        sourceLineId: 'receipt-line-1',
        originalQuantity: new Prisma.Decimal(2),
        conversionFactor: new Prisma.Decimal(12),
        inventoryQuantity: new Prisma.Decimal(24),
        valueDelta: new Prisma.Decimal(120),
        supplierId: 'supplier-1',
      }),
    })
    expect(balanceUpdate).toHaveBeenCalledWith({
      where: { id: 'balance-1' },
      data: expect.objectContaining({
        physicalQty: new Prisma.Decimal(34),
        inventoryValue: new Prisma.Decimal(170),
        averageUnitCost: new Prisma.Decimal(5),
      }),
    })
    expect(lotCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'UPSTREAM_RECEIPT',
        batchNo: 'BATCH-001',
        initialQty: new Prisma.Decimal(24),
        sourceMovementId: 'movement-1',
      }),
    })
    expect(receiptLineUpdate).toHaveBeenCalledWith({
      where: { id: 'receipt-line-1' },
      data: { ledgerMovementId: 'movement-1' },
    })
  })

  it('rejects a frozen conversion mismatch before writing inventory', async () => {
    const tx: any = {}
    await expect(postUpstreamReceiptInTransaction(tx, {
      tenantId: 'tenant-1',
      warehouseId: 'warehouse-1',
      supplierId: 'supplier-1',
      supplierName: '测试供应商',
      receiptId: 'receipt-1',
      receiptNo: 'URC202609000001',
      userId: 'receiver-1',
      effectiveAt: new Date(),
      lines: [{
        receiptLineId: 'line-1',
        productId: 'product-1',
        productName: '矿泉水',
        purchaseQuantity: 2,
        purchaseUnit: '箱',
        conversionFactor: 12,
        inventoryQuantity: 23,
        inventoryUnit: '瓶',
        totalAmount: 120,
      }],
    })).rejects.toThrow('冻结换算结果不一致')
  })
})
