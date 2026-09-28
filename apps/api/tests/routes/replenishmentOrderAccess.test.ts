import Fastify from 'fastify'
import { prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { replenishmentOrderRoutes } from '../../src/routes/replenishmentOrders'

async function appFor(user: Record<string, unknown>) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = user })
  await app.register(replenishmentOrderRoutes, { prefix: '/api/replenishment-orders' })
  await app.ready()
  return app
}

describe('replenishment route access and tenant scope', () => {
  const apps: any[] = []
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
    vi.restoreAllMocks()
  })

  it('scopes internal list reads to the authenticated tenant', async () => {
    const findMany = vi.spyOn(prisma.replenishmentOrder, 'findMany').mockResolvedValue([])
    const count = vi.spyOn(prisma.replenishmentOrder, 'count').mockResolvedValue(0)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supply-a', role: 'SUPPLY_CHAIN' }); apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/replenishment-orders' })
    expect(response.statusCode).toBe(200)
    expect((findMany.mock.calls[0][0] as any).where).toEqual({ tenantId: 'tenant-a' })
    expect((count.mock.calls[0][0] as any).where).toEqual({ tenantId: 'tenant-a' })
    const select = (findMany.mock.calls[0][0] as any).select
    expect(select.supplier).toEqual({ select: { id: true, no: true, name: true } })
    expect(select.store).toEqual({ select: { id: true, no: true, name: true } })
    expect(select.fulfillment.select.purchaseOrder.select).toEqual({ id: true, no: true, status: true, expectedDate: true })
    expect(select).not.toHaveProperty('requestFingerprint')
  })

  it('limits a store role to its own assigned stores', async () => {
    const findMany = vi.spyOn(prisma.replenishmentOrder, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.replenishmentOrder, 'count').mockResolvedValue(0)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'store-user', role: 'KITCHEN_LEAD', storeIds: ['store-a'] }); apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/replenishment-orders' })
    expect(response.statusCode).toBe(200)
    expect((findMany.mock.calls[0][0] as any).where).toEqual({
      tenantId: 'tenant-a', storeId: { in: ['store-a'] }, AND: [{ status: { not: 'DRAFT' } }],
    })
  })

  it('keeps internal drafts out of store list and direct-detail scope', async () => {
    const findMany = vi.spyOn(prisma.replenishmentOrder, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.replenishmentOrder, 'count').mockResolvedValue(0)
    const findFirst = vi.spyOn(prisma.replenishmentOrder, 'findFirst').mockResolvedValue(null)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'store-user', role: 'KITCHEN_LEAD', storeIds: ['store-a'] }); apps.push(app)
    const list = await app.inject({ method: 'GET', url: '/api/replenishment-orders' })
    const detail = await app.inject({ method: 'GET', url: '/api/replenishment-orders/draft-1' })
    expect(list.statusCode).toBe(200)
    expect((findMany.mock.calls[0][0] as any).where).toMatchObject({
      tenantId: 'tenant-a', storeId: { in: ['store-a'] }, AND: [{ status: { not: 'DRAFT' } }],
    })
    expect(detail.statusCode).toBe(404)
    expect((findFirst.mock.calls[0][0] as any).where).toMatchObject({
      id: 'draft-1', tenantId: 'tenant-a', storeId: { in: ['store-a'] }, AND: [{ status: { not: 'DRAFT' } }],
    })
  })

  it('limits a supplier role to its own supplier and never accepts a cross-supplier filter', async () => {
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supplier-user', role: 'SUPPLIER_OWNER', supplierId: 'supplier-a' }); apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/replenishment-orders?supplierId=supplier-b' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '无权查看该供应商补货单' })
  })

  it('keeps internal drafts out of supplier list and direct-detail scope', async () => {
    const findMany = vi.spyOn(prisma.replenishmentOrder, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.replenishmentOrder, 'count').mockResolvedValue(0)
    const findFirst = vi.spyOn(prisma.replenishmentOrder, 'findFirst').mockResolvedValue(null)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supplier-user', role: 'SUPPLIER_OWNER', supplierId: 'supplier-a' }); apps.push(app)
    const list = await app.inject({ method: 'GET', url: '/api/replenishment-orders' })
    const detail = await app.inject({ method: 'GET', url: '/api/replenishment-orders/draft-1' })
    expect(list.statusCode).toBe(200)
    expect((findMany.mock.calls[0][0] as any).where).toMatchObject({
      tenantId: 'tenant-a', supplierId: 'supplier-a', AND: [{ status: { not: 'DRAFT' } }],
    })
    expect(detail.statusCode).toBe(404)
    expect((findFirst.mock.calls[0][0] as any).where).toMatchObject({
      id: 'draft-1', tenantId: 'tenant-a', supplierId: 'supplier-a', AND: [{ status: { not: 'DRAFT' } }],
    })
  })

  it('rejects store creation before any database write', async () => {
    const create = vi.spyOn(prisma.replenishmentOrder, 'create')
    const app = await appFor({ tenantId: 'tenant-a', userId: 'store-user', role: 'KITCHEN_LEAD', storeIds: ['store-a'] }); apps.push(app)
    const response = await app.inject({ method: 'POST', url: '/api/replenishment-orders', payload: {} })
    expect(response.statusCode).toBe(403)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects an idempotency-key replay whose request fingerprint changed', async () => {
    vi.spyOn(prisma.replenishmentOrder, 'findFirst').mockResolvedValue({ requestFingerprint: 'different' } as any)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supply-a', role: 'SUPPLY_CHAIN' }); apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/replenishment-orders',
      payload: {
        storeId: 'store-a', supplierId: 'supplier-a', expectedDate: '2026-09-30',
        idempotencyKey: 'draft-key-001', items: [{ productId: 'product-1', quantity: 1 }],
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: '同一幂等键不能用于不同的补货请求' })
  })

  it('turns a concurrent unique/serialization loser into the committed acceptance replay', async () => {
    vi.spyOn(prisma, '$transaction').mockRejectedValue({ code: 'P2002' })
    vi.spyOn(prisma.replenishmentOrderEvent, 'findFirst').mockResolvedValue({ replenishmentOrderId: 'replenishment-1' } as any)
    vi.spyOn(prisma.replenishmentFulfillmentLink, 'findUnique').mockResolvedValue({
      replenishmentOrderId: 'replenishment-1',
      purchaseOrder: { id: 'purchase-order-1', no: 'PO202609000001' },
    } as any)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supply-a', role: 'SUPPLY_CHAIN' }); apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/replenishment-orders/replenishment-1/accept',
      payload: { requestKey: 'accept-key-001' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      replayed: true,
      replenishmentOrderId: 'replenishment-1',
      purchaseOrderId: 'purchase-order-1',
      purchaseOrderNo: 'PO202609000001',
    })
  })

  it('filters and counts a derived fulfillment status with the same database predicate', async () => {
    const findMany = vi.spyOn(prisma.replenishmentOrder, 'findMany').mockResolvedValue([])
    const count = vi.spyOn(prisma.replenishmentOrder, 'count').mockResolvedValue(0)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supply-a', role: 'SUPPLY_CHAIN' }); apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/replenishment-orders?status=FULFILLING' })
    expect(response.statusCode).toBe(200)
    const expected = {
      tenantId: 'tenant-a',
      status: 'ACCEPTED',
      fulfillment: { is: { purchaseOrder: { status: { in: ['DELIVERING', 'PENDING_CONFIRM', 'RECEIVED'] } } } },
    }
    expect((findMany.mock.calls[0][0] as any).where).toEqual(expected)
    expect((count.mock.calls[0][0] as any).where).toEqual(expected)
  })

  it('rejects edit and cancel idempotency replays when the frozen request content differs', async () => {
    vi.spyOn(prisma.replenishmentOrderEvent, 'findFirst')
      .mockResolvedValueOnce({
        replenishmentOrderId: 'replenishment-1', eventType: 'EDITED', metadata: { fingerprint: 'different' },
      } as any)
      .mockResolvedValueOnce({
        replenishmentOrderId: 'replenishment-1', eventType: 'CANCELLED', metadata: { fingerprint: 'different' },
      } as any)
    const app = await appFor({ tenantId: 'tenant-a', userId: 'supply-a', role: 'SUPPLY_CHAIN' }); apps.push(app)
    const edit = await app.inject({
      method: 'PATCH', url: '/api/replenishment-orders/replenishment-1',
      payload: {
        storeId: 'store-a', supplierId: 'supplier-a', expectedDate: '2026-09-30',
        rowVersion: 0, requestKey: 'same-edit-key', items: [{ productId: 'product-1', quantity: 1 }],
      },
    })
    expect(edit.statusCode).toBe(409)
    expect(edit.json().error).toContain('不同的草稿编辑内容')
    const cancel = await app.inject({
      method: 'POST', url: '/api/replenishment-orders/replenishment-1/cancel',
      payload: { requestKey: 'same-cancel-key', reason: '另一个原因' },
    })
    expect(cancel.statusCode).toBe(409)
    expect(cancel.json().error).toContain('不同的取消原因')
  })
})
