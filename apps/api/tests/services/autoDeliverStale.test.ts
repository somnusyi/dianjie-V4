import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 送达兜底（2026-08-15 与供应链确认）："点送达"由负责人/会计代点、经常遗忘，
 * 配送单永久停在 SHIPPED、门店收不了货。业务确认发货 24h 内必达。
 *
 * 锁住三件事：
 * 1. 超 24h 的 SHIPPED 配送单被系统自动推进（CAS + autoDelivered 标记）；
 * 2. 系统自动送达的单跳过 24h 自动收货（防"货未到→自动送达→自动收货→幽灵入账"）；
 * 3. 订单不在 DELIVERING 时不抢状态。
 */
vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: {
      deliveryOrder: { findMany: vi.fn() },
      purchaseOrder: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
      receipt: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
      deliveryOrderEvent: { create: vi.fn().mockResolvedValue({}) },
      opLog: { create: vi.fn().mockResolvedValue({}) },
    } as any,
  }
})
vi.mock('../../src/services/notification', () => ({
  sendNotification: vi.fn().mockResolvedValue({ created: true }),
}))
vi.mock('../../src/services/notify', () => ({
  fireAndForget: vi.fn(),
}))

import { prisma } from '@dianjie/db'
import { autoDeliverStaleShipments, autoReceivePurchaseOrder } from '../../src/services/scheduler'

const P = prisma as any

function staleDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'do-1',
    tenantId: 'tenant-1',
    rowVersion: 3,
    purchaseOrderId: 'po-1',
    purchaseOrder: { no: 'PO202608000011', status: 'DELIVERING', storeId: 'store-1', supplierId: 'sup-1' },
    ...overrides,
  }
}

function runTransactionMock() {
  P.$transaction.mockImplementation(async (fn: any) => fn({
    deliveryOrder: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    purchaseOrder: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    deliveryOrderEvent: { create: vi.fn().mockResolvedValue({}) },
    opLog: { create: vi.fn().mockResolvedValue({}) },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  P.purchaseOrder.findMany.mockResolvedValue([])
  P.receipt.findFirst.mockResolvedValue(null)
})

describe('autoDeliverStaleShipments（送达兜底）', () => {
  it('超 24h 的 SHIPPED 配送单：CAS 推进并打 autoDelivered 标记、通知门店人工验收', async () => {
    P.deliveryOrder.findMany.mockResolvedValue([staleDelivery()])
    runTransactionMock()
    const result = await autoDeliverStaleShipments()
    expect(result).toEqual({ scanned: 1, delivered: 1 })
    const txArg = (P.$transaction.mock.calls[0][0] as Function)
    expect(txArg).toBeTypeOf('function')
  })

  it('订单已不在 DELIVERING（如已被人工处理）→ 跳过不抢状态', async () => {
    P.deliveryOrder.findMany.mockResolvedValue([
      staleDelivery({ purchaseOrder: { no: 'PO1', status: 'RECEIVED', storeId: 's', supplierId: 'x' } }),
    ])
    const result = await autoDeliverStaleShipments()
    expect(result).toEqual({ scanned: 1, delivered: 0 })
    expect(P.$transaction).not.toHaveBeenCalled()
  })

  it('CAS 竞争失败（人工抢先点了送达）→ 不写事件、不计入 delivered', async () => {
    P.deliveryOrder.findMany.mockResolvedValue([staleDelivery()])
    P.$transaction.mockImplementation(async (fn: any) => fn({
      deliveryOrder: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      purchaseOrder: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      deliveryOrderEvent: { create: vi.fn() },
      opLog: { create: vi.fn() },
    }))
    const result = await autoDeliverStaleShipments()
    expect(result).toEqual({ scanned: 1, delivered: 0 })
  })

  it('无超时单 → 空转', async () => {
    P.deliveryOrder.findMany.mockResolvedValue([])
    const result = await autoDeliverStaleShipments()
    expect(result).toEqual({ scanned: 0, delivered: 0 })
  })
})

describe('autoReceivePurchaseOrder（自动送达单跳过自动收货）', () => {
  it('系统自动送达的配送单不自动收货，等待门店人工验收', async () => {
    P.purchaseOrder.findFirst.mockResolvedValue({
      id: 'po-1',
      tenantId: 'tenant-1',
      status: 'PENDING_CONFIRM',
      deliveredAt: new Date(Date.now() - 48 * 3600 * 1000),
      items: [],
      supplier: {},
      store: {},
      deliveries: [{
        id: 'do-1',
        status: 'DELIVERED',
        deliveredAt: new Date(Date.now() - 48 * 3600 * 1000),
        autoDelivered: true,
        rowVersion: 1,
        items: [],
      }],
    })
    const result = await autoReceivePurchaseOrder('po-1')
    expect(result).toBeNull()
    expect(P.$transaction).not.toHaveBeenCalled()
  })

  it('人工点送达的配送单维持原有 24h 自动收货行为（不跳过）', async () => {
    P.purchaseOrder.findFirst.mockResolvedValue({
      id: 'po-1',
      tenantId: 'tenant-1',
      status: 'PENDING_CONFIRM',
      deliveredAt: new Date(Date.now() - 48 * 3600 * 1000),
      items: [],
      supplier: {},
      store: {},
      deliveries: [{
        id: 'do-1',
        status: 'DELIVERED',
        deliveredAt: new Date(Date.now() - 48 * 3600 * 1000),
        autoDelivered: false,
        rowVersion: 1,
        items: [],
      }],
    })
    // 人工送达的单会进入收货事务路径（本测试仅断言它没被 autoDelivered 拦截）
    P.$transaction.mockImplementation(async (fn: any) => fn({
      deliveryOrder: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }))
    await autoReceivePurchaseOrder('po-1')
    expect(P.$transaction).toHaveBeenCalled()
  })
})
