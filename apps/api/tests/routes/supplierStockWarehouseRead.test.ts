import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { supplierStockRoutes } from '../../src/routes/supplierStock'

const actor = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  supplierId: 'supplier-a',
  role: 'SUPPLIER_OWNER',
}

const warehouses = [
  { id: 'wh-a-default', tenantId: 'tenant-a', isDefault: true, isActive: true },
  { id: 'wh-a-active', tenantId: 'tenant-a', isDefault: false, isActive: true },
  { id: 'wh-a-disabled', tenantId: 'tenant-a', isDefault: false, isActive: false },
  { id: 'wh-b-default', tenantId: 'tenant-b', isDefault: true, isActive: true },
]

function mockWarehouseFindFirst(rows: typeof warehouses) {
  return vi.spyOn(prisma.warehouse, 'findFirst').mockImplementation(async (args: any) => {
    const where = args.where || {}
    const candidate = rows.find(row => {
      if (row.tenantId !== where.tenantId) return false
      if ('isDefault' in where && row.isDefault !== where.isDefault) return false
      if ('id' in where && row.id !== where.id) return false
      if ('isActive' in where && row.isActive !== where.isActive) return false
      return true
    })
    return candidate ? { id: candidate.id } : null
  })
}

async function buildApp() {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = actor
  })
  await app.register(supplierStockRoutes, { prefix: '/api/supplier/stock' })
  await app.ready()
  return app
}

describe('supplier stock warehouse-scoped read endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('GET /api/supplier/stock/reservations', () => {
    it('resolves the default alias to the real default warehouse and triple-scopes the query', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockReservation, 'findMany').mockResolvedValue([])

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/reservations' })

        expect(res.statusCode).toBe(200)
        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-default',
          status: 'ACTIVE',
        })
      } finally {
        await app.close()
      }
    })

    it('resolves an explicit enabled warehouse and returns the real warehouseId', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const row = {
          id: 'r1',
          quantity: 10,
          fulfilledQty: 2,
          createdAt: new Date(),
          product: { id: 'p1', code: 'C001', name: '香菇', unit: '斤' },
          purchaseOrder: {
            id: 'po1',
            no: 'PO001',
            status: 'PENDING',
            expectedDate: new Date(),
            createdAt: new Date(),
            store: { id: 's1', name: '一店' },
          },
        }
        vi.spyOn(prisma.supplierStockReservation, 'findMany').mockResolvedValue([row as any])

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/reservations?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        const json = res.json()
        expect(json).toHaveLength(1)
        expect(json[0].warehouseId).toBe('wh-a-active')
      } finally {
        await app.close()
      }
    })

    it.each([
      { id: 'wh-a-disabled', label: 'disabled warehouse' },
      { id: 'wh-b-default', label: 'warehouse in another tenant' },
      { id: 'unknown-wh', label: 'unknown warehouse' },
    ])('fails closed for $label', async ({ id }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockReservation, 'findMany').mockResolvedValue([])

        const res = await app.inject({
          method: 'GET',
          url: `/api/supplier/stock/reservations?warehouseId=${id}`,
        })

        expect(res.statusCode).toBe(404)
        expect(findMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('GET /api/supplier/stock/batches', () => {
    it('resolves the default alias to the real default warehouse and triple-scopes the query', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockBatch, 'findMany').mockResolvedValue([])

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/batches' })

        expect(res.statusCode).toBe(200)
        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-default',
          remainingQty: { gt: 0 },
        })
      } finally {
        await app.close()
      }
    })

    it('resolves an explicit enabled warehouse and returns the real warehouseId', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const row = {
          id: 'b1',
          batchNo: 'B001',
          kind: 'INBOUND',
          initialQty: 100,
          remainingQty: 80,
          manufactureDate: null,
          expiryDate: null,
          depletedAt: null,
          createdAt: new Date(),
          product: { id: 'p1', code: 'C001', name: '香菇', unit: '斤', spec: '一级' },
          sourceMovement: { id: 'm1', type: 'INBOUND_MANUAL', reason: null, sourceType: 'Manual', sourceId: null },
        }
        vi.spyOn(prisma.supplierStockBatch, 'findMany').mockResolvedValue([row as any])

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/batches?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        const json = res.json()
        expect(json).toHaveLength(1)
        expect(json[0].warehouseId).toBe('wh-a-active')
      } finally {
        await app.close()
      }
    })

    it.each([
      { id: 'wh-a-disabled', label: 'disabled warehouse' },
      { id: 'wh-b-default', label: 'warehouse in another tenant' },
      { id: 'unknown-wh', label: 'unknown warehouse' },
    ])('fails closed for $label', async ({ id }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockBatch, 'findMany').mockResolvedValue([])

        const res = await app.inject({
          method: 'GET',
          url: `/api/supplier/stock/batches?warehouseId=${id}`,
        })

        expect(res.statusCode).toBe(404)
        expect(findMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('GET /api/supplier/stock/movements', () => {
    it('resolves the default alias to the real default warehouse and triple-scopes the query', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockMovement, 'findMany').mockResolvedValue([])

        const res = await app.inject({ method: 'GET', url: '/api/supplier/stock/movements' })

        expect(res.statusCode).toBe(200)
        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany.mock.calls[0][0].where).toMatchObject({
          tenantId: actor.tenantId,
          supplierId: actor.supplierId,
          warehouseId: 'wh-a-default',
        })
      } finally {
        await app.close()
      }
    })

    it('resolves an explicit enabled warehouse and returns the real warehouseId', async () => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const row = {
          id: 'm1',
          type: 'INBOUND_MANUAL',
          delta: 50,
          balanceAfter: 150,
          reason: null,
          sourceType: 'Manual',
          sourceId: null,
          manufactureDate: null,
          expiryDate: null,
          createdAt: new Date(),
          product: { name: '香菇', code: 'C001', unit: '斤', spec: '一级' },
          createdBy: { name: '操作员' },
        }
        vi.spyOn(prisma.supplierStockMovement, 'findMany').mockResolvedValue([row as any])

        const res = await app.inject({
          method: 'GET',
          url: '/api/supplier/stock/movements?warehouseId=wh-a-active',
        })

        expect(res.statusCode).toBe(200)
        const json = res.json()
        expect(json).toHaveLength(1)
        expect(json[0].warehouseId).toBe('wh-a-active')
      } finally {
        await app.close()
      }
    })

    it.each([
      { id: 'wh-a-disabled', label: 'disabled warehouse' },
      { id: 'wh-b-default', label: 'warehouse in another tenant' },
      { id: 'unknown-wh', label: 'unknown warehouse' },
    ])('fails closed for $label', async ({ id }) => {
      const app = await buildApp()
      try {
        mockWarehouseFindFirst(warehouses)
        const findMany = vi.spyOn(prisma.supplierStockMovement, 'findMany').mockResolvedValue([])

        const res = await app.inject({
          method: 'GET',
          url: `/api/supplier/stock/movements?warehouseId=${id}`,
        })

        expect(res.statusCode).toBe(404)
        expect(findMany).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    })
  })

  describe('unswitched endpoints still reject a real non-default warehouse', () => {
    const lockedEndpoints: Array<{ method: 'GET' | 'POST'; url: string; payload?: any }> = [
      { method: 'GET', url: '/api/supplier/stock?warehouseId=wh-a-active' },
      { method: 'GET', url: '/api/supplier/stock/summary?warehouseId=wh-a-active' },
      { method: 'POST', url: '/api/supplier/stock/inbound?warehouseId=wh-a-active', payload: { items: [{ productId: 'p1', qty: 1 }] } },
      { method: 'POST', url: '/api/supplier/stock/adjust?warehouseId=wh-a-active', payload: { productId: 'p1', newQty: 1, reason: '盘点' } },
      { method: 'POST', url: '/api/supplier/stock/loss?warehouseId=wh-a-active', payload: { productId: 'p1', qty: 1, reason: '报损' } },
      { method: 'POST', url: '/api/supplier/stock/import-snapshot?warehouseId=wh-a-active', payload: { items: [{ name: 'x', qty: 1 }] } },
    ]

    it.each(lockedEndpoints)('rejects real non-default warehouse on $method $url', async ({ method, url, payload }) => {
      const app = await buildApp()
      try {
        const res = await app.inject({ method, url, payload })
        expect(res.statusCode).toBe(400)
        expect(res.json().error).toContain('未知仓库')
      } finally {
        await app.close()
      }
    })
  })
})
