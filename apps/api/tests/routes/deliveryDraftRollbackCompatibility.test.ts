import Fastify from 'fastify'
import { prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryRoutes } from '../../src/routes/deliveries'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { FORMAL_DELIVERY_STATUSES, SERVER_SHIPMENT_DRAFT_KEY } from '../../src/services/shipmentDraftMarker'

const actor = {
  tenantId: 'tenant-test',
  userId: 'user-test',
  role: 'SUPPLY_CHAIN',
  supplierId: null,
}

function appFor(plugin: any, prefix: string, user: Record<string, unknown> = actor) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = user
  })
  return app.register(plugin, { prefix })
}

function expectDraftMarkerExcluded(where: any) {
  expect(where).toMatchObject({
    OR: [
      { idempotencyKey: null },
      { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
    ],
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shipment draft rollback compatibility reads', () => {
  it('hides drafts by default and excludes marked drafts from every delivery list filter', async () => {
    const findMany = vi.spyOn(prisma.deliveryOrder, 'findMany').mockResolvedValue([])
    const count = vi.spyOn(prisma.deliveryOrder, 'count').mockResolvedValue(0)
    const app = appFor(deliveryRoutes, '/api/deliveries')
    await app.ready()

    const ordinary = await app.inject({ method: 'GET', url: '/api/deliveries?page=1&pageSize=20' })
    expect(ordinary.statusCode).toBe(200)
    const ordinaryWhere = (findMany.mock.calls[0][0] as any).where
    expect(ordinaryWhere.status).toEqual({ not: 'DRAFT' })
    expectDraftMarkerExcluded(ordinaryWhere.AND[0])
    expect((count.mock.calls[0][0] as any).where).toEqual(ordinaryWhere)

    const explicitDraft = await app.inject({ method: 'GET', url: '/api/deliveries?status=DRAFT' })
    expect(explicitDraft.statusCode).toBe(200)
    const draftWhere = (findMany.mock.calls[1][0] as any).where
    expect(draftWhere.status).toBe('DRAFT')
    expectDraftMarkerExcluded(draftWhere.AND[0])
    await app.close()
  })

  it('excludes marked drafts from delivery detail and mutation supplier resolution', async () => {
    const findFirst = vi.spyOn(prisma.deliveryOrder, 'findFirst').mockResolvedValue(null)
    const app = appFor(deliveryRoutes, '/api/deliveries')
    await app.ready()

    const detail = await app.inject({ method: 'GET', url: '/api/deliveries/delivery-draft' })
    expect(detail.statusCode).toBe(404)
    expectDraftMarkerExcluded((findFirst.mock.calls[0][0] as any).where)

    const mutation = await app.inject({
      method: 'PATCH',
      url: '/api/deliveries/delivery-draft/item-quantity',
      payload: { itemId: 'item-1', targetQuantity: 1, rowVersion: 0 },
    })
    expect(mutation.statusCode).toBe(404)
    expectDraftMarkerExcluded((findFirst.mock.calls[1][0] as any).where)
    await app.close()
  })

  it('excludes marked drafts from order list and detail delivery relations', async () => {
    const findMany = vi.spyOn(prisma.purchaseOrder, 'findMany').mockResolvedValue([])
    vi.spyOn(prisma.purchaseOrder, 'count').mockResolvedValue(0)
    const findFirst = vi.spyOn(prisma.purchaseOrder, 'findFirst').mockResolvedValue(null)
    const supplier = {
      ...actor,
      role: 'SUPPLIER_OWNER',
      supplierId: 'supplier-test',
    }
    const app = appFor(purchaseOrderRoutes, '/api/orders', supplier)
    await app.ready()

    const list = await app.inject({ method: 'GET', url: '/api/orders?page=1&pageSize=20' })
    expect(list.statusCode).toBe(200)
    const listDeliveryWhere = (findMany.mock.calls[0][0] as any).include.deliveries.where
    expect(listDeliveryWhere.status).toEqual({ in: [...FORMAL_DELIVERY_STATUSES] })
    expectDraftMarkerExcluded(listDeliveryWhere)

    const detail = await app.inject({ method: 'GET', url: '/api/orders/order-1' })
    expect(detail.statusCode).toBe(404)
    const detailDeliveryWhere = (findFirst.mock.calls[0][0] as any).include.deliveries.where
    expect(detailDeliveryWhere.status).toEqual({ not: 'DRAFT' })
    expectDraftMarkerExcluded(detailDeliveryWhere)
    await app.close()
  })
})
