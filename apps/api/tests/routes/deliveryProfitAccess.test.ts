import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliveryRoutes } from '../../src/routes/deliveries'

const delivery = {
  id: 'delivery-1',
  no: 'DO-001',
  tenantId: 'tenant-a',
  purchaseOrderId: 'order-1',
  storeId: 'store-a',
  supplierId: 'supplier-a',
  status: 'SHIPPED',
  actualTotalAmount: '999.00',
  createdAt: new Date('2026-09-10T01:00:00Z'),
  shippedAt: new Date('2026-09-10T02:00:00Z'),
  purchaseOrder: { id: 'order-1', no: 'PO-001', status: 'DELIVERING', originalTotalAmount: '100', currentOrderAmount: '100' },
  store: { id: 'store-a', no: 'S001', name: '门店A' },
  supplier: { id: 'supplier-a', no: 'SUP001', name: '总仓' },
  createdBy: { id: 'supply-user', name: '供应链', role: 'SUPPLY_CHAIN' },
  shippedBy: null,
  deliveredBy: null,
  receivedBy: null,
  receipt: null,
  events: [],
  items: [{
    id: 'delivery-item-1',
    purchaseOrderItemId: 'order-item-1',
    productId: 'product-1',
    orderedQtySnapshot: '10',
    shippedQty: '8',
    unitPriceSnapshot: '12.50',
    amount: '100.00',
    productCodeSnapshot: 'P001',
    productNameSnapshot: '菌菇',
    productSpecSnapshot: '1kg',
    productUnitSnapshot: 'kg',
    productCategorySnapshot: '食材',
    product: { id: 'product-1', code: 'P001', name: '菌菇', spec: '1kg', unit: 'kg' },
  }],
}

const outbound = {
  id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1',
  productId: 'product-1',
  originalQuantity: '8', valueDelta: '-60',
}

async function createApp(role: string) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = {
      tenantId: 'tenant-a',
      userId: `${role.toLowerCase()}-user`,
      role,
      storeId: role === 'KITCHEN_LEAD' ? 'store-a' : null,
      storeIds: role === 'KITCHEN_LEAD' ? ['store-a'] : [],
      supplierId: role === 'SUPPLIER_OWNER' ? 'supplier-a' : null,
    }
  })
  await app.register(deliveryRoutes, { prefix: '/api/deliveries' })
  await app.ready()
  return app
}

function mockDeliveryList() {
  vi.spyOn(prisma.deliveryOrder, 'findMany').mockResolvedValue([delivery] as any)
  vi.spyOn(prisma.deliveryOrder, 'count').mockResolvedValue(1)
}

function mockProfitLedger() {
  return vi.spyOn(prisma.warehouseLedgerMovement, 'findMany')
    .mockResolvedValueOnce([outbound] as any)
    .mockResolvedValueOnce([] as any)
}

describe('delivery profit route access and consistency', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()))
    vi.restoreAllMocks()
  })

  it('returns the same frozen profitability on supply-chain list and detail within the tenant scope', async () => {
    mockDeliveryList()
    const ledger = vi.spyOn(prisma.warehouseLedgerMovement, 'findMany')
      .mockResolvedValueOnce([outbound] as any).mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([outbound] as any).mockResolvedValueOnce([] as any)
    const findFirst = vi.spyOn(prisma.deliveryOrder, 'findFirst').mockResolvedValue(delivery as any)
    const app = await createApp('SUPPLY_CHAIN'); apps.push(app)

    const list = await app.inject({ method: 'GET', url: '/api/deliveries?page=1&pageSize=20' })
    const detail = await app.inject({ method: 'GET', url: '/api/deliveries/delivery-1' })

    expect(list.statusCode).toBe(200)
    expect(detail.statusCode).toBe(200)
    expect(list.json().items[0].profitability).toMatchObject({ shippedAmount: '100.00', costAmount: '60.00', profit: '40.00' })
    expect(detail.json().profitability).toEqual(list.json().items[0].profitability)
    expect(detail.json().items[0].profitability).toMatchObject({ acceptedQuantity: '10.00', shippedQuantity: '8.00', costAmount: '60.00', profit: '40.00' })
    expect((findFirst.mock.calls[0][0] as any).where).toMatchObject({ id: 'delivery-1', tenantId: 'tenant-a' })
    expect(ledger).toHaveBeenCalledTimes(4)
  })

  it.each(['KITCHEN_LEAD', 'SUPPLIER_OWNER'])('never returns internal cost to %s', async role => {
    mockDeliveryList()
    vi.spyOn(prisma.deliveryOrder, 'findFirst').mockResolvedValue(delivery as any)
    const ledger = vi.spyOn(prisma.warehouseLedgerMovement, 'findMany')
    const app = await createApp(role); apps.push(app)

    const list = await app.inject({ method: 'GET', url: '/api/deliveries?page=1&pageSize=20' })
    const detail = await app.inject({ method: 'GET', url: '/api/deliveries/delivery-1' })

    expect(list.statusCode).toBe(200)
    expect(detail.statusCode).toBe(200)
    expect(list.json().items[0]).not.toHaveProperty('profitability')
    expect(detail.json()).not.toHaveProperty('profitability')
    expect(detail.json().items[0]).not.toHaveProperty('profitability')
    expect(ledger).not.toHaveBeenCalled()
  })

  it.each(['KITCHEN_LEAD', 'SUPPLIER_OWNER'])('rejects detail profit export for %s before querying a document', async role => {
    const findFirst = vi.spyOn(prisma.deliveryOrder, 'findFirst')
    const app = await createApp(role); apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/deliveries/delivery-1/export.xlsx' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '只有内部供应链可导出配送成本利润明细' })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('uses the projection amount, cost and profit in the supply-chain list workbook', async () => {
    mockDeliveryList()
    mockProfitLedger()
    const app = await createApp('SUPPLY_CHAIN'); apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/deliveries/export.xlsx?page=1&pageSize=20' })
    expect(response.statusCode).toBe(200)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(response.rawPayload)
    const sheet = workbook.getWorksheet('配送单查询')!
    const headers = (sheet.getRow(1).values as any[]).slice(1)
    expect(headers).toContain('成本金额')
    expect(headers).toContain('利润')
    const amountColumn = headers.indexOf('发货金额') + 1
    const costColumn = headers.indexOf('成本金额') + 1
    const profitColumn = headers.indexOf('利润') + 1
    expect(sheet.getRow(2).getCell(amountColumn).value).toBe(100)
    expect(sheet.getRow(2).getCell(costColumn).value).toBe(60)
    expect(sheet.getRow(2).getCell(profitColumn).value).toBe(40)
  })
})
