import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { consumptionAdminRoutes } from '../../src/routes/consumption'
import { inventoryRoutes } from '../../src/routes/inventory'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { receiptRoutes } from '../../src/routes/receipts'
import { v2DashboardRoutes } from '../../src/routes/v2Dashboard'

const actor = {
  tenantId: 'tenant-internal',
  userId: 'user-internal',
  role: 'SUPPLY_CHAIN',
  storeId: null,
  supplierId: null,
}

function appFor(plugin: any, prefix: string) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = actor
  })
  return app.register(plugin, { prefix })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('internal supply-chain route contracts', () => {
  it('returns dashboard landing data before every revenue query', async () => {
    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: actor.userId,
      name: '内部供应链',
      role: 'SUPPLY_CHAIN',
      store: null,
      supplier: null,
    } as any)
    vi.spyOn(prisma.store, 'findMany').mockResolvedValue([
      { id: 'store-a', no: '001', name: '一店' },
      { id: 'store-b', no: '002', name: '二店' },
    ] as any)
    vi.spyOn(prisma.purchaseOrder, 'count').mockResolvedValue(4)
    vi.spyOn(prisma.deliveryOrder, 'count').mockResolvedValue(2)
    vi.spyOn(prisma.receipt, 'count').mockResolvedValue(3)
    const revenueAggregate = vi.spyOn(prisma.revenueRecord, 'aggregate')
    const revenueFindMany = vi.spyOn(prisma.revenueRecord, 'findMany')

    const app = appFor(v2DashboardRoutes, '/api/v2/dashboard')
    await app.ready()
    const response = await app.inject({ method: 'GET', url: '/api/v2/dashboard/me' })
    await app.close()

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      role: 'SUPPLY_CHAIN',
      hero: { label: '内部供应链只读工作台', value: '2 家门店' },
      supplyChain: {
        readOnly: true,
        counts: { orders: 4, deliveries: 2, receipts: 3 },
      },
    })
    expect(body.hero).not.toHaveProperty('revenue7d')
    expect(JSON.stringify(body)).not.toContain('营业额')
    expect(revenueAggregate).not.toHaveBeenCalled()
    expect(revenueFindMany).not.toHaveBeenCalled()
  })

  it('rejects daily-series before RevenueRecord or store access', async () => {
    const revenueFindMany = vi.spyOn(prisma.revenueRecord, 'findMany')
    const storeFindFirst = vi.spyOn(prisma.store, 'findFirst')
    const consumptionFindMany = vi.spyOn(prisma.stockConsumption, 'findMany')

    const app = appFor(consumptionAdminRoutes, '/api/consumption')
    await app.ready()
    const response = await app.inject({
      method: 'GET',
      url: '/api/consumption/daily-series?storeId=store-a&month=2026-07',
    })
    await app.close()

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toContain('无权查看营业额与成本率')
    expect(revenueFindMany).not.toHaveBeenCalled()
    expect(storeFindFirst).not.toHaveBeenCalled()
    expect(consumptionFindMany).not.toHaveBeenCalled()
  })

  it('omits receipt finance fields from internal list and detail DTOs', async () => {
    const unsafeReceipt = {
      id: 'receipt-a',
      tenantId: actor.tenantId,
      no: 'RK001',
      storeId: 'store-a',
      supplierId: 'supplier-a',
      deliveryDate: new Date('2026-07-20T00:00:00.000Z'),
      totalAmount: 100,
      status: 'CONFIRMED',
      note: null,
      createdById: actor.userId,
      confirmedAt: new Date('2026-07-20T01:00:00.000Z'),
      isManual: false,
      tempSupplierName: null,
      tempBankAccount: 'secret-account',
      tempBankName: 'secret-bank',
      rejectReason: null,
      rejectedAt: null,
      purchaseOrderId: 'order-a',
      deliveryOrderId: 'delivery-a',
      invoiceId: 'invoice-a',
      supplierVerifiedAt: null,
      supplierVerifiedById: null,
      supplierVerifyNote: null,
      financeVerifiedAt: new Date(),
      financeVerifiedById: 'finance-user',
      financeVerifyNote: 'finance-only',
      createdAt: new Date(),
      updatedAt: new Date(),
      store: { id: 'store-a', no: '001', name: '一店' },
      supplier: { id: 'supplier-a', no: 'SUP001', name: '供应商 A' },
      createdBy: { id: actor.userId, name: '内部供应链' },
      items: [{ id: 'item-a', productId: 'product-a', quantity: 2, unitPrice: 50, amount: 100 }],
      paymentSchedule: { id: 'schedule-a', amount: 100, status: 'PENDING' },
      invoice: { id: 'invoice-a', amount: 100 },
    }
    const findMany = vi.spyOn(prisma.receipt, 'findMany').mockResolvedValue([unsafeReceipt] as any)
    vi.spyOn(prisma.receipt, 'count').mockResolvedValue(1)
    const findFirst = vi.spyOn(prisma.receipt, 'findFirst').mockResolvedValue(unsafeReceipt as any)

    const app = appFor(receiptRoutes, '/api/receipts')
    await app.ready()
    const list = await app.inject({ method: 'GET', url: '/api/receipts?page=1&pageSize=20' })
    const detail = await app.inject({ method: 'GET', url: '/api/receipts/receipt-a' })
    await app.close()

    expect(list.statusCode).toBe(200)
    expect(detail.statusCode).toBe(200)
    for (const row of [list.json().items[0], detail.json()]) {
      expect(row.items).toHaveLength(1)
      expect(row).not.toHaveProperty('paymentSchedule')
      expect(row).not.toHaveProperty('invoice')
      expect(row).not.toHaveProperty('invoiceId')
      expect(row).not.toHaveProperty('tempBankAccount')
      expect(row).not.toHaveProperty('tempBankName')
      expect(row).not.toHaveProperty('financeVerifiedAt')
      expect(row).not.toHaveProperty('financeVerifyNote')
    }
    expect((findMany.mock.calls[0][0] as any).include).not.toHaveProperty('paymentSchedule')
    expect((findFirst.mock.calls[0][0] as any).include).not.toHaveProperty('paymentSchedule')
  })

  it('rejects order, receipt and inventory writes before any transaction', async () => {
    const transaction = vi.spyOn(prisma, '$transaction')
    const cases = [
      {
        plugin: purchaseOrderRoutes,
        prefix: '/api/orders',
        url: '/api/orders',
        payload: {
          storeId: 'store-a',
          supplierId: 'supplier-a',
          expectedDate: '2026-07-26',
          items: [{ productId: 'product-a', quantity: 1, unitPrice: 1 }],
        },
      },
      {
        plugin: receiptRoutes,
        prefix: '/api/receipts',
        url: '/api/receipts',
        payload: {},
      },
      {
        plugin: inventoryRoutes,
        prefix: '/api/inventory',
        url: '/api/inventory/consume',
        payload: {},
      },
    ]

    for (const testCase of cases) {
      const app = appFor(testCase.plugin, testCase.prefix)
      await app.ready()
      const response = await app.inject({
        method: 'POST',
        url: testCase.url,
        payload: testCase.payload,
      })
      await app.close()
      expect(response.statusCode).toBe(403)
    }
    expect(transaction).not.toHaveBeenCalled()
  })
})
