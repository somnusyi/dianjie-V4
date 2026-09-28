import Fastify from 'fastify'
import { prisma } from '@dianjie/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { replenishmentOrderRoutes } from '../../src/routes/replenishmentOrders'

const run = process.env.RUN_REPLENISHMENT_DB_TESTS === '1' ? describe : describe.skip

async function appFor(user: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = user })
  await app.register(replenishmentOrderRoutes, { prefix: '/api/replenishment-orders' })
  await app.ready()
  return app
}

run('replenishment isolated database integration', () => {
  const apps: any[] = []
  const tenantA = 'tenant-replenishment-a'
  const tenantB = 'tenant-replenishment-b'
  const storeA = 'store-replenishment-a'
  const storeB = 'store-replenishment-b'
  const supplierA = 'supplier-replenishment-a'
  const strictSupplier = 'supplier-replenishment-strict'
  const productA = 'product-replenishment-a'
  const strictProduct = 'product-replenishment-strict'
  const supplyUser = 'user-replenishment-supply'
  const storeUser = 'user-replenishment-store'
  const supplierUser = 'user-replenishment-supplier'

  beforeAll(async () => {
    await prisma.tenant.createMany({ data: [
      { id: tenantA, name: '补货租户A', slug: 'replenishment-a' },
      { id: tenantB, name: '补货租户B', slug: 'replenishment-b' },
    ] })
    await prisma.store.createMany({ data: [
      { id: storeA, tenantId: tenantA, no: 'SA', name: '门店A' },
      { id: storeB, tenantId: tenantB, no: 'SB', name: '门店B' },
    ] })
    await prisma.supplier.createMany({ data: [
      { id: supplierA, tenantId: tenantA, no: 'SUPA', name: '供应商A', bankAccount: 'SECRET-BANK', businessScopes: ['STORE_FULFILLER'] },
      { id: strictSupplier, tenantId: tenantA, no: 'SUPS', name: '严格库存供应商', inventoryMode: 'STRICT', businessScopes: ['STORE_FULFILLER'] },
    ] })
    await prisma.user.createMany({ data: [
      { id: supplyUser, tenantId: tenantA, name: '供应链', email: 'supply@replenishment.test', password: 'x', role: 'SUPPLY_CHAIN' },
      { id: storeUser, tenantId: tenantA, name: '门店', email: 'store@replenishment.test', password: 'x', role: 'KITCHEN_LEAD', storeId: storeA, storeIds: [storeA] },
      { id: supplierUser, tenantId: tenantA, name: '供应商', email: 'supplier@replenishment.test', password: 'x', role: 'SUPPLIER_OWNER', supplierId: supplierA },
    ] })
    const units = {
      unit: 'kg', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'VERIFIED' as const, price: 10, minOrderQty: 1, stepQty: 1,
    }
    await prisma.product.createMany({ data: [
      { id: productA, tenantId: tenantA, supplierId: supplierA, code: 'PA', name: '菌菇', stock: 100, ...units },
      { id: strictProduct, tenantId: tenantA, supplierId: strictSupplier, code: 'PS', name: '缺货商品', stock: 0, ...units },
    ] })
  })

  afterAll(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
    await prisma.$disconnect()
  })

  async function createAndSubmit(supplierId = supplierA, productId = productA) {
    const app = await appFor({ tenantId: tenantA, userId: supplyUser, role: 'SUPPLY_CHAIN' }); apps.push(app)
    const created = await app.inject({
      method: 'POST', url: '/api/replenishment-orders',
      payload: {
        storeId: storeA, supplierId, expectedDate: '2026-09-30', note: '补货',
        idempotencyKey: `create-${supplierId}`, items: [{ productId, quantity: 2 }],
      },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    const submitted = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/submit`, payload: { requestKey: `submit-${supplierId}` },
    })
    expect(submitted.statusCode).toBe(200)
    return { app, id }
  }

  it('enforces composite tenant foreign keys at the database boundary', async () => {
    await expect(prisma.replenishmentOrder.create({
      data: {
        tenantId: tenantA, no: 'RO-CROSS', storeId: storeB, supplierId: supplierA,
        expectedDate: new Date('2026-09-30'), requestFingerprint: 'x'.repeat(64), createdById: supplyUser,
      },
    })).rejects.toMatchObject({ code: 'P2003' })
  })

  it('allows only one formal PO/link when two accept requests race', async () => {
    const { app, id } = await createAndSubmit()
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/replenishment-orders/${id}/accept`, payload: { requestKey: 'accept-race-a' } }),
      app.inject({ method: 'POST', url: `/api/replenishment-orders/${id}/accept`, payload: { requestKey: 'accept-race-b' } }),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    const links = await prisma.replenishmentFulfillmentLink.findMany({ where: { replenishmentOrderId: id } })
    expect(links).toHaveLength(1)
    expect(await prisma.purchaseOrder.count({ where: { replenishmentFulfillmentLink: { is: { replenishmentOrderId: id } } } })).toBe(1)
    expect((await prisma.replenishmentOrder.findUnique({ where: { id } }))?.status).toBe('ACCEPTED')

    const accepted = await app.inject({ method: 'GET', url: '/api/replenishment-orders?status=ACCEPTED' })
    const fulfillingBefore = await app.inject({ method: 'GET', url: '/api/replenishment-orders?status=FULFILLING' })
    expect(accepted.json().total).toBe(1)
    expect(fulfillingBefore.json().total).toBe(0)
    await prisma.purchaseOrder.update({ where: { id: links[0].purchaseOrderId }, data: { status: 'DELIVERING' } })
    const fulfillingAfter = await app.inject({ method: 'GET', url: '/api/replenishment-orders?status=FULFILLING' })
    expect(fulfillingAfter.json().total).toBe(1)
    expect(fulfillingAfter.json().items[0].displayStatus).toBe('FULFILLING')
  })

  it('edits a draft with rowVersion CAS, keeps one concurrent winner, and forbids edits after submit', async () => {
    const app = await appFor({ tenantId: tenantA, userId: supplyUser, role: 'SUPPLY_CHAIN' }); apps.push(app)
    const created = await app.inject({
      method: 'POST', url: '/api/replenishment-orders',
      payload: {
        storeId: storeA, supplierId: supplierA, expectedDate: '2026-10-01', note: '草稿',
        idempotencyKey: 'create-edit-race', items: [{ productId: productA, quantity: 2 }],
      },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    const body = {
      storeId: storeA, supplierId: supplierA, expectedDate: '2026-10-02', note: '已编辑',
      rowVersion: 0, items: [{ productId: productA, quantity: 3 }],
    }
    const [first, second] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/replenishment-orders/${id}`, payload: { ...body, requestKey: 'edit-race-same-key' } }),
      app.inject({ method: 'PATCH', url: `/api/replenishment-orders/${id}`, payload: { ...body, note: '竞争编辑', requestKey: 'edit-race-same-key' } }),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    const saved = await prisma.replenishmentOrder.findUnique({ where: { id }, include: { items: true } })
    expect(saved?.rowVersion).toBe(1)
    expect(saved?.items).toHaveLength(1)
    expect(Number(saved?.items[0].quantity)).toBe(3)
    const submitted = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/submit`, payload: { requestKey: 'submit-edit-race' },
    })
    expect(submitted.statusCode).toBe(200)
    const forbidden = await app.inject({
      method: 'PATCH', url: `/api/replenishment-orders/${id}`,
      payload: { ...body, rowVersion: 2, requestKey: 'edit-after-submit' },
    })
    expect(forbidden.statusCode).toBe(409)
  })

  it('freezes the cancellation reason for an idempotency key', async () => {
    const app = await appFor({ tenantId: tenantA, userId: supplyUser, role: 'SUPPLY_CHAIN' }); apps.push(app)
    const created = await app.inject({
      method: 'POST', url: '/api/replenishment-orders',
      payload: {
        storeId: storeA, supplierId: supplierA, expectedDate: '2026-10-03',
        idempotencyKey: 'create-cancel-replay', items: [{ productId: productA, quantity: 1 }],
      },
    })
    const id = created.json().id
    const first = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/cancel`,
      payload: { requestKey: 'cancel-replay-key', reason: '门店不再需要' },
    })
    expect(first.statusCode).toBe(200)
    const changed = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/cancel`,
      payload: { requestKey: 'cancel-replay-key', reason: '改成另一个原因' },
    })
    expect(changed.statusCode).toBe(409)
    expect((await prisma.replenishmentOrder.findUnique({ where: { id } }))?.cancelReason).toBe('门店不再需要')
  })

  it('requires an explicit draft save before a changed catalog price can be submitted', async () => {
    const app = await appFor({ tenantId: tenantA, userId: supplyUser, role: 'SUPPLY_CHAIN' }); apps.push(app)
    const created = await app.inject({
      method: 'POST', url: '/api/replenishment-orders',
      payload: {
        storeId: storeA, supplierId: supplierA, expectedDate: '2026-10-05',
        idempotencyKey: 'create-price-change', items: [{ productId: productA, quantity: 2 }],
      },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    const oldPrice = created.json().items[0].unitPrice
    await prisma.product.update({ where: { id: productA }, data: { price: 12 } })
    const blocked = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/submit`, payload: { requestKey: 'submit-price-change-blocked' },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().code).toBe('REPLENISHMENT_PRICE_CHANGED')
    expect(blocked.json().changedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: productA, oldPrice: '10.00', newPrice: '12.00', delta: '2.00' }),
    ]))
    const saved = await app.inject({
      method: 'PATCH', url: `/api/replenishment-orders/${id}`,
      payload: {
        storeId: storeA, supplierId: supplierA, expectedDate: '2026-10-05', note: '', rowVersion: 0,
        requestKey: 'edit-price-change-confirmed', items: [{ productId: productA, quantity: 2 }],
      },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().items[0].unitPrice).not.toBe(oldPrice)
    const submitted = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/submit`, payload: { requestKey: 'submit-price-change-confirmed' },
    })
    expect(submitted.statusCode).toBe(200)
    await prisma.product.update({ where: { id: productA }, data: { price: 10 } })
  })

  it('rolls back accepted status, PO, events and link when strict stock reservation fails', async () => {
    const { app, id } = await createAndSubmit(strictSupplier, strictProduct)
    const response = await app.inject({
      method: 'POST', url: `/api/replenishment-orders/${id}/accept`, payload: { requestKey: 'accept-strict-failure' },
    })
    expect(response.statusCode).toBe(409)
    expect((await prisma.replenishmentOrder.findUnique({ where: { id } }))?.status).toBe('SUBMITTED')
    expect(await prisma.replenishmentFulfillmentLink.count({ where: { replenishmentOrderId: id } })).toBe(0)
    expect(await prisma.purchaseOrder.count({ where: { supplierId: strictSupplier } })).toBe(0)
    expect(await prisma.replenishmentOrderEvent.count({ where: { replenishmentOrderId: id, eventType: 'ACCEPTED' } })).toBe(0)
  })

  it('returns the same minimal DTO to store/supplier reads without supplier finance or request fingerprints', async () => {
    const internalApp = await appFor({ tenantId: tenantA, userId: supplyUser, role: 'SUPPLY_CHAIN' }); apps.push(internalApp)
    const draft = await internalApp.inject({
      method: 'POST', url: '/api/replenishment-orders',
      payload: {
        storeId: storeA, supplierId: supplierA, expectedDate: '2026-10-04',
        idempotencyKey: 'supplier-hidden-draft', items: [{ productId: productA, quantity: 1 }],
      },
    })
    expect(draft.statusCode).toBe(201)
    const draftId = draft.json().id
    const storeApp = await appFor({ tenantId: tenantA, userId: storeUser, role: 'KITCHEN_LEAD', storeIds: [storeA] }); apps.push(storeApp)
    const supplierApp = await appFor({ tenantId: tenantA, userId: supplierUser, role: 'SUPPLIER_OWNER', supplierId: supplierA }); apps.push(supplierApp)
    const storeDraftList = await storeApp.inject({ method: 'GET', url: '/api/replenishment-orders' })
    expect(storeDraftList.json().items.some((item: any) => item.id === draftId)).toBe(false)
    const storeDraftDetail = await storeApp.inject({ method: 'GET', url: `/api/replenishment-orders/${draftId}` })
    expect(storeDraftDetail.statusCode).toBe(404)
    const supplierDraftList = await supplierApp.inject({ method: 'GET', url: '/api/replenishment-orders' })
    expect(supplierDraftList.json().items.some((item: any) => item.id === draftId)).toBe(false)
    const supplierDraftDetail = await supplierApp.inject({ method: 'GET', url: `/api/replenishment-orders/${draftId}` })
    expect(supplierDraftDetail.statusCode).toBe(404)
    const submitted = await internalApp.inject({
      method: 'POST', url: `/api/replenishment-orders/${draftId}/submit`, payload: { requestKey: 'supplier-visible-submit' },
    })
    expect(submitted.statusCode).toBe(200)
    const storeSubmittedDetail = await storeApp.inject({ method: 'GET', url: `/api/replenishment-orders/${draftId}` })
    expect(storeSubmittedDetail.statusCode).toBe(200)
    const supplierSubmittedDetail = await supplierApp.inject({ method: 'GET', url: `/api/replenishment-orders/${draftId}` })
    expect(supplierSubmittedDetail.statusCode).toBe(200)
    for (const app of [storeApp, supplierApp]) {
      const response = await app.inject({ method: 'GET', url: '/api/replenishment-orders' })
      expect(response.statusCode).toBe(200)
      const body = JSON.stringify(response.json())
      expect(body).not.toContain('SECRET-BANK')
      expect(body).not.toContain('bankAccount')
      expect(body).not.toContain('requestFingerprint')
      for (const item of response.json().items) {
        expect(Object.keys(item.supplier).sort()).toEqual(['id', 'name', 'no'])
      }
    }
    expect(supplierApp.inject).toBeDefined()
    const supplierRows = await supplierApp.inject({ method: 'GET', url: '/api/replenishment-orders' })
    expect(supplierRows.json().items.every((item: any) => item.supplier.id === supplierA)).toBe(true)
  })
})
