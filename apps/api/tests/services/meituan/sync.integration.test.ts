import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '@dianjie/db'
import { syncInstoreOrders, syncReverseOrders } from '../../../src/services/meituan/sync'

const TEST_ORG_ID = 1076686  // Meituan doc sample, never a real customer

describe('syncInstoreOrders (integration, mock client)', () => {
  beforeEach(async () => {
    // Clean up both TEST_ORG_ID and ORG_ID=0 artifacts (module uses env var at load time)
    await prisma.mtOrderItem.deleteMany({})
    await prisma.mtOrderPayment.deleteMany({})
    await prisma.mtRefundOrder.deleteMany({ where: { orgId: TEST_ORG_ID } })
    await prisma.mtOrder.deleteMany({ where: { orgId: TEST_ORG_ID } })
    await prisma.meituanApiCallLog.deleteMany({ where: { correlationId: { startsWith: 'test-corr-' } } })
    // Clean both orgId 0 and TEST_ORG_ID to avoid stale cursors
    await prisma.meituanSyncCursor.deleteMany({})
    // Make sure env is in mock mode
    process.env.MEITUAN_MODE = 'mock'
    process.env.MEITUAN_ORG_ID = String(TEST_ORG_ID)
  })

  it('mock 拉 page1 → 落 2 单 + 5 items + 2 payments', async () => {
    const report = await syncInstoreOrders({
      correlationId: 'test-corr-1',
      since: new Date('2026-05-27T00:00:00Z'),
      until: new Date('2026-05-27T23:59:59Z'),
      queryTimeType: 2,
    })

    expect(report.orders).toBe(2)
    expect(report.failures).toHaveLength(0)

    const orders = await prisma.mtOrder.findMany({
      where: { orgId: TEST_ORG_ID },
      orderBy: { mtOrderId: 'asc' },
    })
    expect(orders).toHaveLength(2)
    expect(orders[0].mtOrderId).toBe('10001')
    expect(orders[0].payed).toBe(12000)
    expect(orders[0].processed).toBe(false)

    const items = await prisma.mtOrderItem.findMany({ where: { mtOrderId: '10001' } })
    expect(items).toHaveLength(4)

    const payments = await prisma.mtOrderPayment.findMany({ where: { mtOrderId: '10001' } })
    expect(payments).toHaveLength(1)
    expect(payments[0].payTypeName).toBe('微信')
  })

  it('cursor 推进 — 同步完 lastSyncedAt = until', async () => {
    const until = new Date('2026-05-27T23:59:59Z')

    await syncInstoreOrders({
      correlationId: 'test-corr-2',
      since: new Date('2026-05-27T00:00:00Z'),
      until,
      queryTimeType: 2,
    })

    const cursor = await prisma.meituanSyncCursor.findUnique({
      where: { apiPath_orgId: {
        apiPath: '/rms/pos/api/v2/poi/orders/instore/query',
        orgId: TEST_ORG_ID,
      }},
    })
    expect(cursor?.lastSyncedAt?.getTime()).toBe(until.getTime())
  })

  it('重复 sync 同一窗口 — 订单只有 1 份 (mtOrderId unique 约束)', async () => {
    const args = {
      correlationId: 'test-corr-3',
      since: new Date('2026-05-27T00:00:00Z'),
      until: new Date('2026-05-27T23:59:59Z'),
      queryTimeType: 2 as const,
    }
    await syncInstoreOrders(args)
    await syncInstoreOrders(args)

    const count = await prisma.mtOrder.count({ where: { orgId: TEST_ORG_ID } })
    expect(count).toBe(2)         // still 2 not 4
  })
})

describe('syncReverseOrders (integration, mock client)', () => {
  beforeEach(async () => {
    // Clean up everything including stale cursors with orgId=0
    await prisma.mtRefundOrder.deleteMany({ where: { orgId: TEST_ORG_ID } })
    await prisma.mtOrderItem.deleteMany({})
    await prisma.mtOrderPayment.deleteMany({})
    await prisma.mtOrder.deleteMany({ where: { orgId: TEST_ORG_ID } })
    await prisma.meituanSyncCursor.deleteMany({})
    process.env.MEITUAN_MODE = 'mock'
    process.env.MEITUAN_ORG_ID = String(TEST_ORG_ID)
  })

  it('拉到退单 → 落 MtRefundOrder + 关联 MtOrder.processed=false', async () => {
    // Pre-create the related MtOrder (otherwise FK is null which is OK but we want to test the trigger)
    await prisma.mtOrder.create({
      data: {
        mtOrderId: '10001', orderNo: 'X', orgId: TEST_ORG_ID, poiId: 600382210,
        channel: 'INSTORE', callLogId: 'X', businessTime: new Date('2026-05-27'),
        status: 300, payed: 12000, receivable: 12000, amount: 12000, income: 12000,
        processed: true,
        processedAmount: 12000,
        rawPayload: {} as object,
      },
    })

    await syncReverseOrders({
      correlationId: 'test-corr-4',
      since: new Date('2026-05-26T00:00:00Z'),
      until: new Date('2026-05-27T23:59:59Z'),
    })

    const refunds = await prisma.mtRefundOrder.findMany({ where: { orgId: TEST_ORG_ID } })
    expect(refunds).toHaveLength(1)
    expect(refunds[0].mtRefundId).toBe('9001')

    // Related order should be marked for reprocessing
    const order = await prisma.mtOrder.findUnique({ where: { mtOrderId: '10001' } })
    expect(order?.processed).toBe(false)
  })
})
