import { describe, expect, it, vi } from 'vitest'

/**
 * 总仓的出库账只能有一个来源。系统订货→发货链路和美团每日数据包都会写
 * ORDER_OUTBOUND 并扣物理库存，而同一批货在两边都会出现——美团那笔
 * 「配送发货出库」正是系统这笔发货。两条路同时开就是双重扣减，且不报错。
 *
 * 生产今天是美团数据包驱动(系统发货链路未接总仓)，属于「碰巧没触发」。
 * 这里锁住:后开的那条路必须被明确拒绝。
 */

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }),
  }
})

const { consumeWarehouseLedgerForShipment } = await import('../../src/services/warehouseLedger')

function tx(conflictingSourceType: string | null) {
  return {
    purchaseOrder: {
      findFirst: vi.fn().mockResolvedValue({ supplier: { sourceType: 'HEADQ_WAREHOUSE' } }),
    },
    warehouse: {
      findFirst: vi.fn().mockResolvedValue({ id: 'wh-1', inventoryMode: 'OFF', isActive: true }),
    },
    warehouseLedgerMovement: {
      findFirst: vi.fn(async ({ where }: any) => (
        where.sourceType === conflictingSourceType
          ? { id: 'mv-1', effectiveAt: new Date('2026-08-11T23:59:00Z') }
          : null
      )),
    },
    tenant: { findFirst: vi.fn().mockResolvedValue({ id: 'tenant-1' }) },
  } as any
}

const input = {
  tenantId: 'tenant-1',
  purchaseOrderId: 'po-1',
  deliveryOrderId: 'do-1',
  orderNo: 'PO-1',
  userId: 'user-1',
  lines: [],
}

describe('总仓出库账来源互斥', () => {
  it('美团数据包已经在记账时，系统发货链路被拒绝并说明原因', async () => {
    await expect(consumeWarehouseLedgerForShipment(tx('MeituanDailyPackage'), input as any))
      .rejects.toThrow(/美团每日数据包/)
  })

  it('拒绝信息点明会被扣减两次，并给出切换办法', async () => {
    await expect(consumeWarehouseLedgerForShipment(tx('MeituanDailyPackage'), input as any))
      .rejects.toThrow(/扣减两次[\s\S]*冲销/)
  })

  it('没有冲突来源时不拦(后续因为空行等其他原因失败，但不是被这道闸拦的)', async () => {
    await expect(consumeWarehouseLedgerForShipment(tx(null), input as any))
      .rejects.not.toThrow(/不能同时用/)
  })
})
