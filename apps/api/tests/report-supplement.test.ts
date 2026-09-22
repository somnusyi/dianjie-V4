import { describe, expect, it } from 'vitest'
import { Prisma } from '@dianjie/db'
import { daysWithoutOutbound, warehouseAlert } from '../src/services/inventoryReportSupplement'
import { numberReportRows } from '../src/services/reportFieldContract'
const d = (v: number) => new Prisma.Decimal(v)
describe('new report metrics', () => {
  it('measures stagnation in Shanghai calendar days and does not invent missing history', () => {
    const now = new Date('2026-09-22T16:00:00Z')
    expect(daysWithoutOutbound(now, new Date('2026-09-21T15:59:00Z'))).toBe(2)
    expect(daysWithoutOutbound(now, null, new Date('2026-09-01T16:00:00Z'))).toBe(21)
    expect(daysWithoutOutbound(now)).toBeNull()
  })
  it('converts safety stock and does not invent a ceiling or unverifiable unit conversion', () => {
    const p = { minStock: d(2), inventoryUnitsPerOrderUnit: d(10), unitConversionStatus: 'VERIFIED' }
    expect(warehouseAlert(d(19), p)).toMatchObject({ minQty: 20, maxQty: null, alertStatus: '低于下限' })
    expect(warehouseAlert(d(20), p).alertStatus).toBe('未触发下限（未设上限）')
    expect(warehouseAlert(d(10), { ...p, unitConversionStatus: 'NEEDS_REVIEW' }).minQty).toBeNull()
    expect(warehouseAlert(d(0), p).alertStatus).toBe('缺货')
  })
  it('fills unknown fields with null and numbers complete results before pagination', () => {
    expect(numberReportRows([{ revenue: 0 }, { revenue: 2 }], [{ key: 'revenue' }, { key: 'unknown' }])).toEqual([{ revenue: 0, unknown: null, seq: 1 }, { revenue: 2, unknown: null, seq: 2 }])
  })
})
