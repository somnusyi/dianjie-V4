import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  supplierFindMany: vi.fn(),
  warehouseFindFirst: vi.fn(),
  balanceFindMany: vi.fn(),
  resolveWarehouseId: vi.fn(),
  getSupplierReservedStock: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      product: { findMany: (...args: any[]) => mocks.productFindMany(...args) },
      supplier: { findMany: (...args: any[]) => mocks.supplierFindMany(...args) },
      warehouse: { findFirst: (...args: any[]) => mocks.warehouseFindFirst(...args) },
      warehouseLedgerBalance: { findMany: (...args: any[]) => mocks.balanceFindMany(...args) },
    },
  }
})

vi.mock('../../src/lib/cache', () => ({
  cached: (_key: string, _ttl: number, loader: () => unknown) => loader(),
  invalidatePattern: vi.fn(),
}))

vi.mock('../../src/services/defaultWarehouse', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/defaultWarehouse')>()
  return {
    ...actual,
    resolveTenantWarehouseId: (...args: any[]) => mocks.resolveWarehouseId(...args),
  }
})

vi.mock('../../src/services/supplierStockReservation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/supplierStockReservation')>()
  return {
    ...actual,
    getSupplierReservedStock: (...args: any[]) => mocks.getSupplierReservedStock(...args),
  }
})

vi.mock('../../src/routes/upload', () => ({ signOssKey: () => null }))

import { buildProductListWhere, productRoutes, projectCatalogAvailability } from '../../src/routes/products'

function buildApp() {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => {
    req.user = { tenantId: 'tenant-1', userId: 'store-user', role: 'KITCHEN_LEAD', supplierId: null }
  })
  app.register(productRoutes)
  return app
}

const warehouseProduct = {
  id: 'product-1', supplierId: 'supplier-headq', stock: 999,
  imageKey: null, supplier: { id: 'supplier-headq', name: '总仓', sourceType: 'HEADQ_WAREHOUSE' },
}

describe('store catalog production boundaries', () => {
  beforeEach(() => {
    mocks.productFindMany.mockReset()
    mocks.productFindMany.mockResolvedValue([warehouseProduct])
    mocks.supplierFindMany.mockReset()
    mocks.supplierFindMany.mockResolvedValue([
      { id: 'supplier-headq', sourceType: 'HEADQ_WAREHOUSE', inventoryMode: 'NOT_TRACKED' },
    ])
    mocks.warehouseFindFirst.mockReset()
    mocks.balanceFindMany.mockReset()
    mocks.balanceFindMany.mockResolvedValue([])
    mocks.resolveWarehouseId.mockReset()
    mocks.resolveWarehouseId.mockResolvedValue('warehouse-1')
    mocks.getSupplierReservedStock.mockReset()
    mocks.getSupplierReservedStock.mockResolvedValue(new Map())
  })

  it('limits store products to enabled store-fulfillment suppliers', async () => {
    const result = await buildProductListWhere({
      query: { supplierId: 'supplier-1' },
      user: { tenantId: 'tenant-1', role: 'KITCHEN_LEAD', supplierId: null },
    })
    expect(result.error).toBeUndefined()
    expect(result.where).toEqual({
      tenantId: 'tenant-1',
      status: 'ENABLED',
      supplierId: 'supplier-1',
      supplier: {
        is: {
          status: 'ENABLED',
          businessScopes: { hasSome: ['STORE_FULFILLER', 'DIRECT_STORE_VENDOR'] },
        },
      },
    })
  })

  it('uses the active warehouse ledger instead of legacy product stock for internal fulfillment', () => {
    expect(projectCatalogAvailability({
      product: { stock: 999 },
      supplierReserved: 100,
      warehouseBalance: { physicalQty: 20, reservedQty: 3 },
      warehouseLedgerActive: true,
    })).toEqual({ physicalStock: 20, reservedStock: 3, availableStock: 17 })
  })

  it('treats a missing strict-ledger balance as zero instead of falling back to legacy stock', () => {
    expect(projectCatalogAvailability({
      product: { stock: 999 },
      supplierReserved: 0,
      warehouseBalance: null,
      warehouseLedgerActive: true,
    })).toEqual({ physicalStock: 0, reservedStock: 0, availableStock: 0 })
  })

  it('keeps the legacy supplier-stock projection while the warehouse ledger is off', () => {
    expect(projectCatalogAvailability({
      product: { stock: 12 },
      supplierReserved: 2,
      warehouseBalance: { physicalQty: 20, reservedQty: 3 },
      warehouseLedgerActive: false,
    })).toEqual({ physicalStock: 12, reservedStock: 2, availableStock: 10 })
  })

  it.each([
    {
      label: 'SHADOW reminder-only', inventoryMode: 'SHADOW', blockZeroStockAtOrderEntry: false,
      expected: { inventoryTracked: true, inventoryEnforced: false, availableStock: 0 },
    },
    {
      label: 'STRICT blocking', inventoryMode: 'STRICT', blockZeroStockAtOrderEntry: true,
      expected: { inventoryTracked: true, inventoryEnforced: true, availableStock: 0 },
    },
    {
      label: 'OFF', inventoryMode: 'OFF', blockZeroStockAtOrderEntry: false,
      expected: { inventoryTracked: false, inventoryEnforced: false, availableStock: 999 },
    },
  ])('separates tracked and enforced catalog signals for $label', async ({
    inventoryMode, blockZeroStockAtOrderEntry, expected,
  }) => {
    mocks.warehouseFindFirst.mockResolvedValue({ inventoryMode, blockZeroStockAtOrderEntry })
    const app = buildApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject(expected)
    expect(mocks.warehouseFindFirst).toHaveBeenCalledWith({
      where: { id: 'warehouse-1', tenantId: 'tenant-1', isActive: true },
      select: { inventoryMode: true, blockZeroStockAtOrderEntry: true },
    })
    await app.close()
  })

  it('never projects an external STRICT supplier as order-entry enforced', async () => {
    mocks.productFindMany.mockResolvedValue([{
      ...warehouseProduct,
      supplierId: 'supplier-external',
      stock: 0,
      supplier: { id: 'supplier-external', name: '外部供应商', sourceType: null },
    }])
    mocks.supplierFindMany.mockResolvedValue([{
      id: 'supplier-external', sourceType: null, inventoryMode: 'STRICT',
    }])
    mocks.getSupplierReservedStock.mockResolvedValue(new Map([['product-1', 0]]))
    const app = buildApp()
    const response = await app.inject({ method: 'GET', url: '/' })

    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject({
      availableStock: 0,
      inventoryTracked: true,
      inventoryEnforced: false,
    })
    expect(mocks.getSupplierReservedStock).toHaveBeenCalledWith({
      tenantId: 'tenant-1', productIds: ['product-1'],
    })
    expect(mocks.resolveWarehouseId).not.toHaveBeenCalled()
    expect(mocks.warehouseFindFirst).not.toHaveBeenCalled()
    expect(mocks.balanceFindMany).not.toHaveBeenCalled()
    await app.close()
  })
})
