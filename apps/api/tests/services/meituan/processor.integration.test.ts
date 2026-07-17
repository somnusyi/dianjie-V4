import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '@dianjie/db'
import { processPendingOrders } from '../../../src/services/meituan/processor'

const STORE_ID = 'test-store-meituan'
const TENANT_ID = 'test-tenant-meituan'
const TEST_ORG_ID = 1076686
const TEST_ORDER_IDS = ['a1', 'a2']

async function setupStore() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    create: {
      id: TENANT_ID,
      name: 'Test Meituan',
      slug: 'test-meituan-' + Date.now(),  // unique slug to avoid collision
    },
    update: {},
  })
  await prisma.store.upsert({
    where: { id: STORE_ID },
    create: {
      id: STORE_ID,
      tenantId: TENANT_ID,
      no: 'TEST-MT',
      name: 'Test Meituan Store',
      meituanShopId: '600382210',
    },
    update: { meituanShopId: '600382210' },
  })
}

function makeMtOrder(opts: {
  mtOrderId: string
  payed: number
  businessTime: Date
  storeId?: string | null
  status?: number
}) {
  return prisma.mtOrder.create({
    data: {
      mtOrderId: opts.mtOrderId,
      orderNo: 'X-' + opts.mtOrderId,
      orgId: TEST_ORG_ID,
      poiId: 600382210,
      storeId: opts.storeId !== undefined ? opts.storeId : STORE_ID,
      channel: 'INSTORE',
      callLogId: 'test',
      businessTime: opts.businessTime,
      status: opts.status ?? 300,
      payed: opts.payed,
      receivable: opts.payed,
      amount: opts.payed,
      income: opts.payed,
      processed: false,
      processedAmount: 0,
      rawPayload: {} as object,
    },
  })
}

describe('processPendingOrders (integration)', () => {
  beforeEach(async () => {
    await setupStore()
    await prisma.mtOrderItem.deleteMany({ where: { mtOrderId: { in: TEST_ORDER_IDS } } })
    await prisma.mtOrderPayment.deleteMany({ where: { mtOrderId: { in: TEST_ORDER_IDS } } })
    await prisma.mtOrder.deleteMany({ where: { orgId: TEST_ORG_ID } })
    await prisma.revenueRecord.deleteMany({ where: { storeId: STORE_ID } })
  })

  it('首次处理 → RevenueRecord create amount=元', async () => {
    await makeMtOrder({ mtOrderId: 'a1', payed: 12000, businessTime: new Date('2026-05-27') })
    const r = await processPendingOrders()
    expect(r.processed).toBe(1)
    const rec = await prisma.revenueRecord.findUnique({
      where: { storeId_date: { storeId: STORE_ID, date: new Date('2026-05-27') } },
    })
    expect(rec?.source).toBe('meituan')
    expect(Number(rec?.amount)).toBe(120)         // 12000 分 = 120 元
  })

  it('当天 2 笔订单 → amount 累加', async () => {
    await makeMtOrder({ mtOrderId: 'a1', payed: 12000, businessTime: new Date('2026-05-27') })
    await makeMtOrder({ mtOrderId: 'a2', payed: 3800,  businessTime: new Date('2026-05-27') })
    await processPendingOrders()
    const rec = await prisma.revenueRecord.findUnique({
      where: { storeId_date: { storeId: STORE_ID, date: new Date('2026-05-27') } },
    })
    expect(Number(rec?.amount)).toBe(158)         // (12000+3800)/100
  })

  it('manual 记录被覆盖, 旧值进 rawData.replacedManual', async () => {
    await prisma.revenueRecord.create({
      data: { storeId: STORE_ID, date: new Date('2026-05-27'), amount: 999.99, source: 'manual' },
    })
    await makeMtOrder({ mtOrderId: 'a1', payed: 12000, businessTime: new Date('2026-05-27') })
    await processPendingOrders()
    const rec = await prisma.revenueRecord.findUnique({
      where: { storeId_date: { storeId: STORE_ID, date: new Date('2026-05-27') } },
    })
    expect(rec?.source).toBe('meituan')
    expect(Number(rec?.amount)).toBe(120)         // manual 999.99 zero'd then + 120
    expect((rec?.rawData as any)?.replacedManual?.previousAmount).toBe(999.99)
  })

  it('part refund — payed 变小, delta 为负, RevenueRecord decrement', async () => {
    await makeMtOrder({ mtOrderId: 'a1', payed: 12000, businessTime: new Date('2026-05-27') })
    await processPendingOrders()
    // Simulate part-refund 1600 happens, then re-sync
    await prisma.mtOrder.update({
      where: { mtOrderId: 'a1' },
      data: { payed: 10400, processed: false },
    })
    await processPendingOrders()
    const rec = await prisma.revenueRecord.findUnique({
      where: { storeId_date: { storeId: STORE_ID, date: new Date('2026-05-27') } },
    })
    expect(Number(rec?.amount)).toBe(104)         // 10400/100
  })

  it('storeId 为 null → 跳过 + 标 processError', async () => {
    await makeMtOrder({ mtOrderId: 'a1', payed: 100, businessTime: new Date('2026-05-27'), storeId: null })
    const r = await processPendingOrders()
    expect(r.skippedNoStore).toBe(1)
    expect(r.processed).toBe(0)
    const o = await prisma.mtOrder.findUnique({ where: { mtOrderId: 'a1' } })
    expect(o?.processError).toContain('storeId 未解析')
  })

  it('status=600 取消单 → 算作 0 收入', async () => {
    await makeMtOrder({ mtOrderId: 'a1', payed: 12000, businessTime: new Date('2026-05-27') })
    await processPendingOrders()         // writes 120
    await prisma.mtOrder.update({
      where: { mtOrderId: 'a1' },
      data: { status: 600, processed: false },
    })
    await processPendingOrders()
    const rec = await prisma.revenueRecord.findUnique({
      where: { storeId_date: { storeId: STORE_ID, date: new Date('2026-05-27') } },
    })
    expect(Number(rec?.amount)).toBe(0)
  })
})
