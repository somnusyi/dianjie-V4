import { describe, expect, it } from 'vitest'
import { Prisma } from '@dianjie/db'
import { daysWithoutOutbound, loadInventorySupplement, warehouseAlert } from '../src/services/inventoryReportSupplement'
import { numberReportRows } from '../src/services/reportFieldContract'
const d = (v: number) => new Prisma.Decimal(v)
describe('new report metrics', () => {
  it('measures stagnation in Shanghai calendar days and does not invent missing history', () => {
    const now = new Date('2026-09-22T16:00:00Z')
    expect(daysWithoutOutbound(now, new Date('2026-09-21T15:59:00Z'))).toBe(2)
    expect(daysWithoutOutbound(now, null, new Date('2026-09-01T16:00:00Z'))).toBe(21)
    expect(daysWithoutOutbound(now)).toBeNull()
  })
  it('uses verified legacy conversion only as fallback and reports all alert boundaries', () => {
    const p = { minStock: d(2), inventoryUnitsPerOrderUnit: d(10), unitConversionStatus: 'VERIFIED' }
    expect(warehouseAlert(d(19), p)).toMatchObject({ minQty: 20, maxQty: null, alertStatus: '低于下限' })
    expect(warehouseAlert(d(20), p).alertStatus).toBe('正常')
    const configured = { inventoryUnitSnapshot: 'kg', minQty: d(20), maxQty: d(30), stagnantDays: 45, active: true }
    expect(warehouseAlert(d(20), p, configured, 'kg').alertStatus).toBe('正常')
    expect(warehouseAlert(d(30), p, configured, 'kg').alertStatus).toBe('正常')
    expect(warehouseAlert(d(31), p, configured, 'kg').alertStatus).toBe('高于上限')
    expect(warehouseAlert(d(10), { ...p, unitConversionStatus: 'NEEDS_REVIEW' })).toMatchObject({ minQty: null, alertStatus: '单位待确认' })
    expect(warehouseAlert(d(10), { ...p, minStock: d(0) })).toMatchObject({ minQty: null, alertStatus: '阈值未配置' })
    expect(warehouseAlert(d(10), p, { inventoryUnitSnapshot: 'kg', minQty: d(5), maxQty: d(20), stagnantDays: 30, active: false }, 'kg'))
      .toMatchObject({ minQty: null, maxQty: null, alertStatus: '阈值未配置', ruleSource: 'unconfigured' })
    expect(warehouseAlert(d(10), p, { ...configured, inventoryUnitSnapshot: '件' }, 'kg').alertStatus).toBe('单位待确认')
    expect(warehouseAlert(d(0), p).alertStatus).toBe('缺货')
  })
  it('fills unknown fields with null and numbers complete results before pagination', () => {
    expect(numberReportRows([{ revenue: 0 }, { revenue: 2 }], [{ key: 'revenue' }, { key: 'unknown' }])).toEqual([{ revenue: 0, unknown: null, seq: 1 }, { revenue: 2, unknown: null, seq: 2 }])
  })
  it('将结构化总仓自损纳入其他出入库汇总，不依赖原因关键词', async () => {
    let capturedWhere: any
    const tx = {
      warehouseLedgerMovement: {
        findMany: async ({ where }: any) => {
          capturedWhere = where
          return [{
            id: 'loss-movement', productId: 'product-1', warehouseId: 'warehouse-1', inventoryUnit: 'kg',
            type: 'ORDER_OUTBOUND', sourceType: 'WarehouseSelfLoss', physicalDelta: d(-2), valueDelta: d(-6),
            product: { id: 'product-1', code: 'P-1', name: '测试商品', spec: null, category: '测试' },
            warehouse: { id: 'warehouse-1', name: '总仓' },
            docLines: [{ doc: { reason: '总仓自损：过期变质' } }],
          }]
        },
      },
    } as any
    const q = { start: '2026-09-01', end: '2026-09-30', type: '', warehouseId: '', keyword: '', category: '' } as any
    const rows = await loadInventorySupplement(tx, 'tenant-1', 'other-summary', q, { tenantId: 'tenant-1', product: { tenantId: 'tenant-1' } })
    expect(capturedWhere.OR[0].sourceType.in).toContain('WarehouseSelfLoss')
    expect(rows).toEqual([expect.objectContaining({ type: '出库', reason: '总仓自损：过期变质', quantity: -2, amount: -6 })])
  })
})
