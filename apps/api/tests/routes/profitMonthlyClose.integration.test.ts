import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { profitRoutes } from '../../src/routes/profit'

const suffix = `monthly-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let app: ReturnType<typeof Fastify>
let tenantId = ''
let storeId = ''
let userId = ''

describe('store monthly close projection (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } })
    tenantId = tenant.id
    const store = await prisma.store.create({ data: { tenantId, no: `MC-${suffix}`, name: '月结验证门店' } })
    storeId = store.id
    const user = await prisma.user.create({
      data: { tenantId, storeId, storeIds: [storeId], name: '月结验证店长', email: `${suffix}@local.test`, password: 'test', role: 'MANAGER' },
    })
    userId = user.id
    await prisma.revenueRecord.create({
      data: { storeId, date: new Date('2026-06-15T00:00:00.000Z'), amount: 100, source: 'daily_import',
        rawData: { grossAmount: 120, netRevenue: 100, discountAmount: 20, orders: 2 } },
    })
    await prisma.storeExpense.create({
      data: { tenantId, storeId, month: '2026-06', category: 'LABOR', item: '工资成本', amount: 20 },
    })
    await prisma.storeMonthlyClose.create({
      data: {
        tenantId, storeId, month: '2026-06', status: 'CONFIRMED',
        operatingRevenue: 98, revenueExTax: 97, vat: 1, surcharge: 0,
        foodCost: 10, beverageCost: 2, consumablesCost: 1,
        laborCost: 20, salesExpense: 10, managementExpense: 5, financeExpense: 1,
        nonOperatingIncome: 1, nonOperatingExpense: 0, profitBeforeTax: 49,
        incomeTax: 2, netProfit: 47, sourceFilename: 'monthly-close.xlsx', sourceHash: 'a'.repeat(64),
        confirmedAt: new Date(), confirmedById: userId,
      },
    })
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, storeId, storeIds: [storeId], userId, role: 'MANAGER' }
    })
    await app.register(profitRoutes, { prefix: '/api/profit' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.storeMonthlyClose.deleteMany({ where: { tenantId } })
    await prisma.storeExpense.deleteMany({ where: { tenantId } })
    await prisma.revenueRecord.deleteMany({ where: { storeId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('keeps daily operating metrics while using the confirmed close for P&L', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/profit/store/${storeId}?month=2026-06` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      accountingClose: { operatingRevenue: 98, operationalRevenue: 100, reconciliationDifference: -2 },
      revenue: { total: 98, operationalTotal: 100, metrics: { grossAmount: 120, netRevenue: 100, orders: 2 } },
      cost: { food: 13, labor: { total: 20 }, sales: { total: 10 }, mgmt: { total: 5 }, finance: { total: 1 } },
      grossProfit: 85,
      netProfit: 47,
    })
  })

  it('locks manual expense edits after a finance close is confirmed', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/profit/store/${storeId}/expenses`,
      payload: { month: '2026-06', expenses: { 工资成本: 99 } },
    })
    expect(response.statusCode).toBe(409)
  })
})
