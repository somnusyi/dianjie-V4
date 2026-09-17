import { describe, expect, it } from 'vitest'
import { buildProductListWhere, projectCatalogAvailability } from '../../src/routes/products'

describe('store catalog production boundaries', () => {
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

  it('keeps the legacy supplier-stock projection while the warehouse ledger is off', () => {
    expect(projectCatalogAvailability({
      product: { stock: 12 },
      supplierReserved: 2,
      warehouseBalance: { physicalQty: 20, reservedQty: 3 },
      warehouseLedgerActive: false,
    })).toEqual({ physicalStock: 12, reservedStock: 2, availableStock: 10 })
  })
})
