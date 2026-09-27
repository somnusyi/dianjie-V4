import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DELIVERY_EXPORT_MAX_ROWS, exceedsDeliveryExportLimit } from '../../src/routes/deliveries'
import { RECEIPT_EXPORT_MAX_ROWS, exceedsReceiptExportLimit } from '../../src/routes/receipts'

const routes = resolve(process.cwd(), 'src/routes')

describe('收货与配送查询导出契约', () => {
  it('10,000 行可导出，第 10,001 行要求缩小筛选范围', () => {
    expect(exceedsReceiptExportLimit(RECEIPT_EXPORT_MAX_ROWS)).toBe(false)
    expect(exceedsReceiptExportLimit(RECEIPT_EXPORT_MAX_ROWS + 1)).toBe(true)
    expect(exceedsDeliveryExportLimit(DELIVERY_EXPORT_MAX_ROWS)).toBe(false)
    expect(exceedsDeliveryExportLimit(DELIVERY_EXPORT_MAX_ROWS + 1)).toBe(true)
  })

  it('导出复用列表的角色、租户与筛选范围，不另建宽松查询', () => {
    const receipts = readFileSync(resolve(routes, 'receipts.ts'), 'utf8')
    const deliveries = readFileSync(resolve(routes, 'deliveries.ts'), 'utf8')
    const receiptExport = receipts.slice(receipts.indexOf("app.get('/export.xlsx'"), receipts.indexOf("app.get('/:id'"))
    const deliveryExport = deliveries.slice(deliveries.indexOf("app.get('/export.xlsx'"), deliveries.indexOf("app.get('/:id'"))

    expect(receiptExport).toContain("allowsSupplyDataRead(role, 'receipt.read')")
    expect(receiptExport).toContain('buildReceiptListWhere(parsed.data, req.user)')
    expect(receiptExport).toContain('take: RECEIPT_EXPORT_MAX_ROWS + 1')
    expect(deliveryExport).toContain("allowsSupplyDataRead(req.user.role, 'delivery.read')")
    expect(deliveryExport).toContain('buildDeliveryListWhere(parsed.data, req.user)')
    expect(deliveryExport).toContain('take: DELIVERY_EXPORT_MAX_ROWS + 1')
  })
})
