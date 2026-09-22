import { Prisma } from '@dianjie/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  supplierFindFirst: vi.fn(),
  balanceFindMany: vi.fn(),
  getWarehouseLedgerMode: vi.fn(),
  getSupplierReservedStock: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      product: { findMany: (...args: any[]) => mocks.productFindMany(...args) },
      supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
      warehouseLedgerBalance: { findMany: (...args: any[]) => mocks.balanceFindMany(...args) },
    },
  }
})

vi.mock('../../src/services/warehouseLedger', () => ({
  getWarehouseLedgerMode: (...args: any[]) => mocks.getWarehouseLedgerMode(...args),
}))

vi.mock('../../src/services/supplierStockReservation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/supplierStockReservation')>()
  return {
    ...actual,
    getSupplierReservedStock: (...args: any[]) => mocks.getSupplierReservedStock(...args),
  }
})

import {
  enforceWarehouseOrderEntryPolicyInTransaction,
  loadOrderDraftProducts,
  validateOrderDraftLines,
  type OrderDraftProduct,
} from '../../src/services/orderDraftValidation'

function product(overrides: Partial<OrderDraftProduct> = {}): OrderDraftProduct {
  return {
    id: 'product-1',
    name: '乌苏罐装',
    unit: '罐',
    minOrderQty: new Prisma.Decimal(2),
    stepQty: new Prisma.Decimal(2),
    price: new Prisma.Decimal(5),
    purchaseUnit: '箱',
    inventoryUnit: '罐',
    orderUnit: '罐',
    costUnit: '罐',
    inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(6),
    inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
    inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
    unitConversionStatus: 'VERIFIED',
    stock: new Prisma.Decimal(8),
    availableStock: 8,
    inventoryEnforced: false,
    ...overrides,
  }
}

describe('shared order draft validation', () => {
  beforeEach(() => {
    mocks.productFindMany.mockReset()
    mocks.supplierFindFirst.mockReset()
    mocks.balanceFindMany.mockReset()
    mocks.getWarehouseLedgerMode.mockReset()
    mocks.getSupplierReservedStock.mockReset()
    mocks.getSupplierReservedStock.mockResolvedValue(new Map())
  })

  it('builds authoritative priced lines for a valid draft', () => {
    const result = validateOrderDraftLines([product()], [{ productId: 'product-1', quantity: 4 }])

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.totalAmount?.toFixed(2)).toBe('20.00')
    expect(result.lines[0]).toMatchObject({
      productId: 'product-1',
      quantity: 4,
      orderUnitSnapshot: '罐',
    })
  })

  it('applies the same duplicate, availability, minimum and step blockers used by real creation', () => {
    const duplicate = validateOrderDraftLines([product()], [
      { productId: 'product-1', quantity: 2 },
      { productId: 'product-1', quantity: 2 },
    ])
    const missing = validateOrderDraftLines([], [{ productId: 'missing', quantity: 1 }])
    const minimum = validateOrderDraftLines([product()], [{ productId: 'product-1', quantity: 1 }])
    const step = validateOrderDraftLines([product()], [{ productId: 'product-1', quantity: 3 }])

    expect(duplicate.issues.some(issue => issue.code === 'DUPLICATE_PRODUCT')).toBe(true)
    expect(missing.issues[0].code).toBe('PRODUCT_UNAVAILABLE')
    expect(minimum.issues[0].code).toBe('BELOW_MINIMUM')
    expect(step.issues[0].code).toBe('INVALID_STEP')
  })

  it('blocks a pending four-unit contract instead of inventing a price', () => {
    const result = validateOrderDraftLines(
      [product({ unitConversionStatus: 'PENDING' })],
      [{ productId: 'product-1', quantity: 2 }],
    )

    expect(result.ok).toBe(false)
    expect(result.issues[0].code).toBe('PRICE_UNAVAILABLE')
    expect(result.lines).toEqual([])
  })

  it('blocks zero available stock only when the explicit order-entry policy is enforced', () => {
    const blocked = validateOrderDraftLines(
      [product({ availableStock: 0, inventoryEnforced: true })],
      [{ productId: 'product-1', quantity: 2 }],
    )
    const reminderOnly = validateOrderDraftLines(
      [product({ availableStock: 0, inventoryEnforced: false })],
      [{ productId: 'product-1', quantity: 2 }],
    )

    expect(blocked.ok).toBe(false)
    expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'OUT_OF_STOCK', productId: 'product-1' }))
    expect(reminderOnly.ok).toBe(true)
    expect(reminderOnly.issues).toEqual([])
  })

  it('uses blockZeroStockAtOrderEntry independently from warehouse inventoryMode', async () => {
    const { availableStock: _availableStock, inventoryEnforced: _inventoryEnforced, ...dbProduct } = product()
    mocks.productFindMany.mockResolvedValue([dbProduct])
    mocks.supplierFindFirst.mockResolvedValue({ sourceType: 'HEADQ_WAREHOUSE', inventoryMode: 'NOT_TRACKED' })

    mocks.getWarehouseLedgerMode.mockResolvedValueOnce({
      warehouseId: 'warehouse-1', inventoryMode: 'STRICT', blockZeroStockAtOrderEntry: false,
    })
    const reminderOnly = await loadOrderDraftProducts({
      tenantId: 'tenant-1', supplierId: 'supplier-headq', productIds: ['product-1'],
    })
    expect(reminderOnly[0]).toMatchObject({ inventoryEnforced: false, availableStock: 8 })
    expect(mocks.balanceFindMany).not.toHaveBeenCalled()

    mocks.getWarehouseLedgerMode.mockResolvedValueOnce({
      warehouseId: 'warehouse-1', inventoryMode: 'SHADOW', blockZeroStockAtOrderEntry: true,
    })
    mocks.balanceFindMany.mockResolvedValueOnce([
      { productId: 'product-1', physicalQty: new Prisma.Decimal(0), reservedQty: new Prisma.Decimal(0) },
    ])
    const blocking = await loadOrderDraftProducts({
      tenantId: 'tenant-1', supplierId: 'supplier-headq', productIds: ['product-1'],
    })
    expect(blocking[0]).toMatchObject({ inventoryEnforced: true, availableStock: 0 })
    expect(mocks.balanceFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', warehouseId: 'warehouse-1', productId: { in: ['product-1'] } },
      select: { productId: true, physicalQty: true, reservedQty: true },
    })
  })

  it('keeps an external STRICT supplier as zero-stock reminder-only at order entry', async () => {
    const { availableStock: _availableStock, inventoryEnforced: _inventoryEnforced, ...dbProduct } = product({
      stock: new Prisma.Decimal(0),
    })
    mocks.productFindMany.mockResolvedValue([dbProduct])
    mocks.supplierFindFirst.mockResolvedValue({ sourceType: null, inventoryMode: 'STRICT' })
    mocks.getSupplierReservedStock.mockResolvedValue(new Map([['product-1', 0]]))

    const products = await loadOrderDraftProducts({
      tenantId: 'tenant-1', supplierId: 'supplier-external', productIds: ['product-1'],
    })
    const result = validateOrderDraftLines(products, [{ productId: 'product-1', quantity: 2 }])

    expect(products[0]).toMatchObject({
      availableStock: 0,
      inventoryEnforced: false,
      warehouseOrderEntryPolicyApplies: false,
    })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(mocks.getWarehouseLedgerMode).not.toHaveBeenCalled()
    expect(mocks.balanceFindMany).not.toHaveBeenCalled()
  })

  it('rechecks the supplier and tenant warehouse under shared row locks', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ sourceType: 'HEADQ_WAREHOUSE' }])
      .mockResolvedValueOnce([{
        id: 'warehouse-1',
        blockZeroStockAtOrderEntry: true,
      }])
    const balanceFindMany = vi.fn().mockResolvedValue([
      { productId: 'product-1', physicalQty: new Prisma.Decimal(3), reservedQty: new Prisma.Decimal(3) },
    ])
    const tx = {
      warehouseLedgerBalance: { findMany: balanceFindMany },
      $queryRaw: queryRaw,
    } as any

    await expect(enforceWarehouseOrderEntryPolicyInTransaction(tx, {
      tenantId: 'tenant-1',
      supplierId: 'supplier-headq',
      items: [{ productId: 'product-1', productName: '乌苏罐装' }],
    })).rejects.toMatchObject({ statusCode: 400, message: '乌苏罐装 当前可用库存为 0，不能提交订单' })

    expect(queryRaw).toHaveBeenCalledTimes(2)
    const [supplierQuery, supplierId, supplierTenantId] = queryRaw.mock.calls[0]
    expect(supplierQuery.join(' ')).toContain('FROM "suppliers"')
    expect(supplierQuery.join(' ')).toContain('FOR SHARE')
    expect([supplierId, supplierTenantId]).toEqual(['supplier-headq', 'tenant-1'])
    const [warehouseQuery, warehouseTenantId] = queryRaw.mock.calls[1]
    expect(warehouseQuery.join(' ')).toContain('FROM "warehouses"')
    expect(warehouseQuery.join(' ')).toContain('FOR SHARE')
    expect(warehouseTenantId).toBe('tenant-1')
    expect(balanceFindMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', warehouseId: 'warehouse-1', productId: { in: ['product-1'] } },
      select: { productId: true, physicalQty: true, reservedQty: true },
    })
  })

  it('does not read balances when the transaction re-read finds reminder-only policy', async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ sourceType: 'HEADQ_WAREHOUSE' }])
      .mockResolvedValueOnce([{ id: 'warehouse-1', blockZeroStockAtOrderEntry: false }])
    const balanceFindMany = vi.fn()
    const tx = {
      warehouseLedgerBalance: { findMany: balanceFindMany },
      $queryRaw: queryRaw,
    } as any

    await expect(enforceWarehouseOrderEntryPolicyInTransaction(tx, {
      tenantId: 'tenant-1', supplierId: 'supplier-headq',
      items: [{ productId: 'product-1', productName: '乌苏罐装' }],
    })).resolves.toBeUndefined()

    expect(queryRaw).toHaveBeenCalledTimes(2)
    expect(balanceFindMany).not.toHaveBeenCalled()
  })

  it('returns after the supplier lock when the supplier is external, even if its legacy mode is STRICT', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{ sourceType: null }])
    const balanceFindMany = vi.fn()
    const tx = {
      warehouseLedgerBalance: { findMany: balanceFindMany },
      $queryRaw: queryRaw,
    } as any

    await expect(enforceWarehouseOrderEntryPolicyInTransaction(tx, {
      tenantId: 'tenant-1', supplierId: 'supplier-external',
      items: [{ productId: 'product-1', productName: '乌苏罐装' }],
    })).resolves.toBeUndefined()

    expect(queryRaw).toHaveBeenCalledOnce()
    expect(queryRaw.mock.calls[0]?.[0].join(' ')).toContain('FOR SHARE')
    expect(balanceFindMany).not.toHaveBeenCalled()
  })
})
