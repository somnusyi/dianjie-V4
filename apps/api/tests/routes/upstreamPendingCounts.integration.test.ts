import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

let app: ReturnType<typeof Fastify>, tenantId: string, supplierId: string, otherSupplierId: string
beforeAll(async () => {
  vi.stubEnv('UPSTREAM_PROCUREMENT_ENABLED', 'true')
  tenantId = (await prisma.tenant.create({ data: { slug: `pending-counts-${randomUUID()}`, name: '采购汇总隔离' } })).id
  supplierId = (await prisma.supplier.create({ data: { tenantId, no: 'A', name: '食材甲' } })).id
  otherSupplierId = (await prisma.supplier.create({ data: { tenantId, no: 'B', name: '食材乙' } })).id
  const userId = (await prisma.user.create({ data: { tenantId, email: `${randomUUID()}@local.invalid`, password: 'unusable', role: 'SUPPLY_CHAIN', name: '采购员' } })).id
  const warehouseId = (await prisma.warehouse.create({ data: { tenantId, code: 'MAIN', name: '总仓' } })).id
  const createdAt = new Date('2026-11-02T04:00:00Z')
  await prisma.upstreamPurchaseOrder.createMany({ data: Array.from({ length: 402 }, (_, i) => ({
    tenantId, supplierId, warehouseId, createdById: userId, no: `A-${i}`, status: i < 201 ? 'DRAFT' as const : 'CLOSED' as const, createdAt,
  })) })
  await prisma.upstreamPurchaseOrder.create({ data: { tenantId, supplierId: otherSupplierId, warehouseId, createdById: userId, no: 'B-1', status: 'SUPPLIER_ACCEPTED', createdAt } })
  app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId, userId, role: 'SUPPLY_CHAIN' } })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' }); await app.ready()
})
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); await prisma.$disconnect() })
it('counts all 201 open orders across 402 rows and survives page changes', async () => {
  for (const page of [1, 11, 21]) {
    const response = await app.inject(`/api/upstream/purchase-orders?paginated=true&supplierId=${supplierId}&page=${page}`)
    expect(response.statusCode).toBe(200)
    expect(response.json().total).toBe(402)
    expect(response.json().summary).toEqual({ pendingOrders: 201, pendingReceipts: 0, pendingClaims: 0 })
    expect(response.json().items.length).toBe(page === 21 ? 2 : 20)
  }
})
it('supplier/date filters and empty sets use the same full scope', async () => {
  const get = async (query: string) => (await app.inject(`/api/upstream/purchase-orders?paginated=true&${query}`)).json()
  expect((await get(`supplierId=${otherSupplierId}`)).summary.pendingOrders).toBe(1)
  expect((await get(`supplierId=${supplierId}&dateFrom=2026-11-03`)).summary.pendingOrders).toBe(0)
  expect((await get(`supplierId=${supplierId}&dateFrom=2026-11-02&dateTo=2026-11-02`)).summary.pendingOrders).toBe(201)
  expect((await get('productQuery=不存在商品')).total).toBe(0)
})
it('refresh reflects actual status transitions without changing any stock facts', async () => {
  const order = await prisma.upstreamPurchaseOrder.findFirstOrThrow({ where: { tenantId, no: 'A-0' } })
  await prisma.upstreamPurchaseOrder.update({ where: { id: order.id }, data: { status: 'CANCELLED' } })
  const response = await app.inject(`/api/upstream/purchase-orders?paginated=true&supplierId=${supplierId}`)
  expect(response.json().summary.pendingOrders).toBe(200)
  expect(await prisma.warehouseLedgerMovement.count({ where: { tenantId } })).toBe(0)
})
