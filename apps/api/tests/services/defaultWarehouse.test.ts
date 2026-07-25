import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAREHOUSE_ID,
  DEFAULT_WAREHOUSE_META,
  DEFAULT_WAREHOUSE_NAME,
  resolveWarehouseId,
} from '../../src/services/defaultWarehouse'
import { supplierStockRoutes } from '../../src/routes/supplierStock'

describe('defaultWarehouse helper', () => {
  it('exports stable default warehouse constants', () => {
    expect(DEFAULT_WAREHOUSE_ID).toBe('default')
    expect(DEFAULT_WAREHOUSE_NAME).toBe('默认仓')
    expect(DEFAULT_WAREHOUSE_META).toEqual({ id: 'default', name: '默认仓' })
    expect(Object.isFrozen(DEFAULT_WAREHOUSE_META)).toBe(true)
  })

  describe('resolveWarehouseId', () => {
    it('resolves undefined to default', () => {
      expect(resolveWarehouseId(undefined)).toBe('default')
    })

    it('resolves null to default', () => {
      expect(resolveWarehouseId(null)).toBe('default')
    })

    it('resolves empty string to default', () => {
      expect(resolveWarehouseId('')).toBe('default')
    })

    it('resolves whitespace-only string to default', () => {
      expect(resolveWarehouseId('   ')).toBe('default')
    })

    it('resolves explicit "default" to default', () => {
      expect(resolveWarehouseId('default')).toBe('default')
    })

    it('resolves "default" with surrounding whitespace to default', () => {
      expect(resolveWarehouseId('  default  ')).toBe('default')
    })

    it('throws 400 for unknown warehouse id', () => {
      expect(() => resolveWarehouseId('warehouse-2')).toThrow('未知仓库')
      try {
        resolveWarehouseId('warehouse-2')
      } catch (error: any) {
        expect(error.statusCode).toBe(400)
      }
    })

    it('throws 400 for overly long warehouse id', () => {
      const longId = 'x'.repeat(200)
      expect(() => resolveWarehouseId(longId)).toThrow('未知仓库')
      try {
        resolveWarehouseId(longId)
      } catch (error: any) {
        expect(error.statusCode).toBe(400)
      }
    })

    it('throws 400 for numeric non-default value', () => {
      expect(() => resolveWarehouseId(42)).toThrow('未知仓库')
    })

    it('throws 400 for boolean value', () => {
      expect(() => resolveWarehouseId(true)).toThrow('未知仓库')
    })
  })
})

describe('defaultWarehouse route integration — pre-rejection without DB', () => {
  async function buildApp() {
    const app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'test-tenant',
        supplierId: 'test-supplier',
        userId: 'test-user',
        role: 'SUPPLIER_OWNER',
      }
    })
    await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
    await app.ready()
    return app
  }

  const endpoints: Array<{ method: 'GET' | 'POST'; url: string; label: string }> = [
    { method: 'GET', url: '/api/supplier/stock', label: 'list' },
    { method: 'GET', url: '/api/supplier/stock/summary', label: 'summary' },
    { method: 'GET', url: '/api/supplier/stock/reservations', label: 'reservations' },
    { method: 'GET', url: '/api/supplier/stock/batches', label: 'batches' },
    { method: 'GET', url: '/api/supplier/stock/movements', label: 'movements' },
    { method: 'POST', url: '/api/supplier/stock/inbound', label: 'inbound' },
    { method: 'POST', url: '/api/supplier/stock/adjust', label: 'adjust' },
    { method: 'POST', url: '/api/supplier/stock/loss', label: 'loss' },
    { method: 'POST', url: '/api/supplier/stock/import-snapshot', label: 'import-snapshot' },
  ]

  it.each(endpoints)('rejects unknown warehouseId in query with 400 on $label', async ({ method, url }) => {
    const app = await buildApp()
    try {
      const separator = url.includes('?') ? '&' : '?'
      const res = await app.inject({
        method,
        url: `${url}${separator}warehouseId=unknown-wh`,
        ...(method === 'POST' ? { payload: { items: [{ name: 'x', qty: 1 }] } } : {}),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toContain('未知仓库')
    } finally {
      await app.close()
    }
  })

  it.each(endpoints.filter(e => e.method === 'POST'))(
    'rejects unknown warehouseId in body with 400 on $label',
    async ({ url }) => {
      const app = await buildApp()
      try {
        const res = await app.inject({
          method: 'POST',
          url,
          payload: { warehouseId: 'rogue-warehouse', items: [{ name: 'x', qty: 1 }] },
        })
        expect(res.statusCode).toBe(400)
        expect(res.json().error).toContain('未知仓库')
      } finally {
        await app.close()
      }
    },
  )

})
