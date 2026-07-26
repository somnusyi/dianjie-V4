import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WAREHOUSE_ID,
  DEFAULT_WAREHOUSE_META,
  DEFAULT_WAREHOUSE_NAME,
  resolveWarehouseId,
  resolveTenantWarehouseId,
} from '../../src/services/defaultWarehouse'
import { supplierStockRoutes } from '../../src/routes/supplierStock'

type WarehouseRow = {
  id: string
  tenantId: string
  isDefault: boolean
  isActive: boolean
}

function warehouseDb(rows: WarehouseRow[]) {
  const findFirst = vi.fn(async (args: {
    where: Partial<WarehouseRow>
    select: { id: true }
  }) => {
    const row = rows.find(candidate => (
      Object.entries(args.where).every(([key, value]) => (
        candidate[key as keyof WarehouseRow] === value
      ))
    ))
    return row ? { id: row.id } : null
  })

  return {
    db: { warehouse: { findFirst } } as unknown as Parameters<typeof resolveTenantWarehouseId>[0],
    findFirst,
  }
}

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

describe('resolveTenantWarehouseId', () => {
  const rows: WarehouseRow[] = [
    { id: 'wh-tenant-a-default', tenantId: 'tenant-a', isDefault: true, isActive: true },
    { id: 'wh-tenant-a-secondary', tenantId: 'tenant-a', isDefault: false, isActive: true },
    { id: 'wh-tenant-a-disabled', tenantId: 'tenant-a', isDefault: false, isActive: false },
    { id: 'wh-tenant-b-default', tenantId: 'tenant-b', isDefault: true, isActive: true },
  ]

  it.each([undefined, null, '', '   ', 'default', '  default  '])(
    'resolves the API default alias %j to the authenticated tenant default',
    async rawWarehouseId => {
      const { db, findFirst } = warehouseDb(rows)

      await expect(resolveTenantWarehouseId(db, 'tenant-a', rawWarehouseId))
        .resolves.toBe('wh-tenant-a-default')
      expect(findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', isDefault: true, isActive: true },
        select: { id: true },
      })
    },
  )

  it('resolves an enabled real warehouse ID in the authenticated tenant', async () => {
    const { db, findFirst } = warehouseDb(rows)

    await expect(resolveTenantWarehouseId(db, 'tenant-a', '  wh-tenant-a-secondary  '))
      .resolves.toBe('wh-tenant-a-secondary')
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        id: 'wh-tenant-a-secondary',
        isActive: true,
      },
      select: { id: true },
    })
  })

  it('fails closed for a warehouse in another tenant', async () => {
    const { db, findFirst } = warehouseDb(rows)

    await expect(resolveTenantWarehouseId(db, 'tenant-a', 'wh-tenant-b-default'))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        id: 'wh-tenant-b-default',
        isActive: true,
      },
      select: { id: true },
    })
  })

  it('fails closed for a disabled warehouse', async () => {
    const { db, findFirst } = warehouseDb(rows)

    await expect(resolveTenantWarehouseId(db, 'tenant-a', 'wh-tenant-a-disabled'))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        id: 'wh-tenant-a-disabled',
        isActive: true,
      },
      select: { id: true },
    })
  })

  it('fails closed for an unknown real warehouse ID', async () => {
    const { db } = warehouseDb(rows)

    await expect(resolveTenantWarehouseId(db, 'tenant-a', 'wh-missing'))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('fails closed when the authenticated tenant has no enabled default', async () => {
    const { db, findFirst } = warehouseDb(rows.filter(row => row.tenantId === 'tenant-b'))

    await expect(resolveTenantWarehouseId(db, 'tenant-a', 'default'))
      .rejects.toMatchObject({
        statusCode: 404,
        message: '当前租户不存在启用的默认仓',
      })
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', isDefault: true, isActive: true },
      select: { id: true },
    })
  })

  it('uses only the authenticated tenantId even when raw input carries another tenant', async () => {
    const { db, findFirst } = warehouseDb(rows)
    const forgedInput = {
      tenantId: 'tenant-b',
      warehouseId: 'wh-tenant-b-default',
      toString: () => 'wh-tenant-b-default',
    }

    await expect(resolveTenantWarehouseId(db, 'tenant-a', forgedInput))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        id: 'wh-tenant-b-default',
        isActive: true,
      },
      select: { id: true },
    })
  })

  it('accepts a transaction-shaped Prisma client without using global Prisma', async () => {
    const { db, findFirst } = warehouseDb(rows)

    await expect(resolveTenantWarehouseId(db, 'tenant-a', 'wh-tenant-a-secondary'))
      .resolves.toBe('wh-tenant-a-secondary')
    expect(findFirst).toHaveBeenCalledTimes(1)
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
