import Fastify from 'fastify'
import { prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { SERVER_SHIPMENT_DRAFT_KEY } from '../../src/services/shipmentDraftMarker'

describe('delivery list shipment-draft rollback compatibility', () => {
  let app: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    vi.restoreAllMocks()
  })

  async function requestList(query = '') {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLY_CHAIN',
        supplierId: null,
      }
    })
    const findMany = vi.spyOn(prisma.deliveryOrder, 'findMany').mockResolvedValue([])
    const count = vi.spyOn(prisma.deliveryOrder, 'count').mockResolvedValue(0)
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: `/api/deliveries?page=1&pageSize=20${query}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 })
    return {
      findManyWhere: (findMany.mock.calls[0]?.[0] as any)?.where,
      countWhere: (count.mock.calls[0]?.[0] as any)?.where,
    }
  }

  it('hides every DRAFT and all marked internal drafts from the ordinary list', async () => {
    const { findManyWhere, countWhere } = await requestList()

    for (const where of [findManyWhere, countWhere]) {
      expect(where).toMatchObject({
        tenantId: 'tenant-test',
        status: { not: 'DRAFT' },
        AND: [{
          OR: [
            { idempotencyKey: null },
            { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
          ],
        }],
      })
    }
  })

  it('never exposes a marked internal draft even when status=DRAFT is explicit', async () => {
    const { findManyWhere, countWhere } = await requestList('&status=DRAFT')

    expect(findManyWhere).toMatchObject({
      tenantId: 'tenant-test',
      status: 'DRAFT',
      AND: [{
        OR: [
          { idempotencyKey: null },
          { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
        ],
      }],
    })
    expect(countWhere).toEqual(findManyWhere)
  })

  it('also hides a marked draft after cancellation from an explicit CANCELLED list', async () => {
    const { findManyWhere, countWhere } = await requestList('&status=CANCELLED')

    for (const where of [findManyWhere, countWhere]) {
      expect(where).toMatchObject({
        tenantId: 'tenant-test',
        status: 'CANCELLED',
        AND: [{
          OR: [
            { idempotencyKey: null },
            { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
          ],
        }],
      })
    }
  })

  it('does not expose an internal draft through the delivery detail route', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLY_CHAIN',
        supplierId: null,
      }
    })
    const findFirst = vi.spyOn(prisma.deliveryOrder, 'findFirst').mockResolvedValue(null)
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/api/deliveries/internal-draft-id' })

    expect(response.statusCode).toBe(404)
    expect((findFirst.mock.calls[0]?.[0] as any)?.where).toMatchObject({
      id: 'internal-draft-id',
      tenantId: 'tenant-test',
      OR: [
        { idempotencyKey: null },
        { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
      ],
    })
  })

  it('does not resolve an internal draft as a mutable formal delivery', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLY_CHAIN',
        supplierId: null,
      }
    })
    const findFirst = vi.spyOn(prisma.deliveryOrder, 'findFirst').mockResolvedValue(null)
    await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
    await app.ready()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/deliveries/internal-draft-id/remove-item',
      payload: { itemId: 'item-id', rowVersion: 0 },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: '配送单不存在' })
    expect((findFirst.mock.calls[0]?.[0] as any)?.where).toMatchObject({
      id: 'internal-draft-id',
      tenantId: 'tenant-test',
      OR: [
        { idempotencyKey: null },
        { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
      ],
    })
  })
})

describe('order list shipment-draft visibility', () => {
  let app: ReturnType<typeof Fastify> | undefined

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('loads only formal deliveries for order-list totals and summaries', async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-test',
        userId: 'user-test',
        role: 'SUPPLIER_OWNER',
        supplierId: 'supplier-test',
      }
    })
    const findMany = vi.spyOn(prisma.purchaseOrder, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.purchaseOrder, 'count').mockResolvedValue(0)
    await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: '/api/orders?page=1&pageSize=20',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 })
    expect((findMany.mock.calls[0]?.[0] as any)?.include?.deliveries?.where).toEqual({
      status: { in: ['SHIPPED', 'DELIVERED', 'RECEIVED'] },
    })
  })
})
