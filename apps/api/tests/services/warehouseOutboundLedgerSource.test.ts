import { describe, expect, it, vi } from 'vitest'

/**
 * 总仓出库来源互斥（2026-08-18 升级为「商品级 + 纪元语义」）：
 * - 纪元：最近一次基准（baselineApplied）之前的历史出库不参与判定——新基准把账
 *   重置后来源约定重新开始（8.11 时代的美团包不得永远拦住切换后的系统发货链路）。
 * - 商品级：只拦"同一商品被两条链路都记出库"。按对方门店拆行 + 已切店跳过后，
 *   两条链路记的是不同批货，商品重叠正常；同商品真的两路都记仍响亮报错。
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

/** baselineSnapshotDate: 最近基准日；clash: 冲突流水（或 null） */
function tx(clash: { effectiveAt: string; productId: string } | null, baselineSnapshotDate: string | null) {
  return {
    purchaseOrder: {
      findFirst: vi.fn().mockResolvedValue({ supplier: { sourceType: 'HEADQ_WAREHOUSE' } }),
    },
    warehouse: {
      findFirst: vi.fn().mockResolvedValue({ id: 'wh-1', inventoryMode: 'OFF', isActive: true }),
    },
    warehouseInventoryImport: {
      findMany: vi.fn(async () => (
        baselineSnapshotDate
          ? [{ snapshotDate: new Date(baselineSnapshotDate), metadata: { baselineApplied: true } }]
          : []
      )),
    },
    warehouseLedgerMovement: {
      // 先被闸查询（ORDER_OUTBOUND + conflicting 来源 + 纪元内 + 商品交集），
      // 通过后被幂等 replay 查询（idempotencyKey）
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.sourceType === 'MeituanDailyPackage') {
          if (!clash) return null
          const after = where.effectiveAt?.gt ? new Date(where.effectiveAt.gt).getTime() : 0
          if (new Date(clash.effectiveAt).getTime() <= after) return null
          if (where.productId?.in && !where.productId.in.includes(clash.productId)) return null
          return { id: 'mv-clash', effectiveAt: new Date(clash.effectiveAt) }
        }
        return null
      }),
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
  lines: [{
    purchaseOrderItemId: 'poi-1',
    productId: 'prod-1',
    quantity: 5,
    shippedQty: 5,
    productName: '金耳菌',
    productUnit: 'kg',
    orderUnitSnapshot: 'kg',
    inventoryUnitSnapshot: 'g',
    inventoryUnitsPerOrderUnitSnapshot: 1000,
  }],
}

describe('总仓出库来源互斥（商品级 + 纪元）', () => {
  it('同纪元内同商品已被美团包记出库 → 系统发货链路被拒并说明原因', async () => {
    // 基准 8.17；冲突流水 8.18（新纪元内、同商品）
    await expect(consumeWarehouseLedgerForShipment(
      tx({ effectiveAt: '2026-08-18T12:00:00Z', productId: 'prod-1' }, '2026-08-17'), input as any,
    )).rejects.toThrow(/美团每日数据包/)
  })

  it('拒绝信息点明会被扣减两次，并给出切换办法', async () => {
    await expect(consumeWarehouseLedgerForShipment(
      tx({ effectiveAt: '2026-08-18T12:00:00Z', productId: 'prod-1' }, '2026-08-17'), input as any,
    )).rejects.toThrow(/扣减两次[\s\S]*冲销/)
  })

  it('冲突流水在最近基准之前（旧纪元）→ 放行，新基准后来源重新约定', async () => {
    // 基准 8.17；冲突流水 8.11（旧纪元，已被基准吸收）→ 不拦
    await expect(consumeWarehouseLedgerForShipment(
      tx({ effectiveAt: '2026-08-11T23:59:00Z', productId: 'prod-1' }, '2026-08-17'), input as any,
    )).rejects.not.toThrow(/不能对同一商品再记一次/)
  })

  it('没有冲突来源时不拦（后续因其他原因失败，但不是被这道闸拦的）', async () => {
    await expect(consumeWarehouseLedgerForShipment(tx(null, '2026-08-17'), input as any))
      .rejects.not.toThrow(/不能对同一商品再记一次/)
  })
})
