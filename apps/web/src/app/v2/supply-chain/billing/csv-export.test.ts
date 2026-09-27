// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { billingCsvFilename, buildBillingCsv, downloadBillingCsv } from './csv-export'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('供应链账务 CSV 导出', () => {
  it('导出账期当前行并正确转义特殊字符', () => {
    const csv = buildBillingCsv('schedule', [{
      amount: '12.50', status: 'OVERDUE', dueAt: '2026-09-28T00:00:00.000Z',
      supplier: { name: '华南,"蔬菜"' }, receipt: { no: 'RC-1', store: { name: '门店\n一' } },
    }])

    expect(csv.startsWith('\ufeff')).toBe(true)
    expect(csv).toContain('供应商,入库单,门店,到期日,状态,金额')
    expect(csv).toContain('"华南,""蔬菜"""')
    expect(csv).toContain('"门店\n一"')
    expect(csv).toContain('2026-09-28,OVERDUE,12.5')
  })

  it('分别生成对账单与发票列', () => {
    const reconciliation = buildBillingCsv('reconciliation', [{
      no: 'REC-1', totalAmount: 88, status: 'CONFIRMED', periodStart: '2026-09-01', periodEnd: '2026-09-30',
      supplier: { name: '供应商甲', no: 'SUP-1' },
    }])
    const invoice = buildBillingCsv('invoice', [{
      invoiceNo: 'INV-1', amount: 66, status: 'VERIFIED', issueDate: '2026-09-28',
      supplier: { name: '供应商乙' }, receipts: [{ id: 'r1' }, { id: 'r2' }],
    }])

    expect(reconciliation).toContain('对账单号,供应商,供应商编号,期间开始,期间结束,状态,金额')
    expect(reconciliation).toContain('REC-1,供应商甲,SUP-1,2026-09-01,2026-09-30,CONFIRMED,88')
    expect(invoice).toContain('发票号码,供应商,开票日,关联入库数,状态,金额')
    expect(invoice).toContain('INV-1,供应商乙,2026-09-28,2,VERIFIED,66')
  })

  it('阻止用户可控文本在 Excel 中被当作公式执行', () => {
    const csv = buildBillingCsv('invoice', [{
      invoiceNo: '=HYPERLINK("https://example.test")', amount: 66, status: 'PENDING', issueDate: '2026-09-28',
      supplier: { name: '+SUM(1,2)' }, receipts: [],
    }])

    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"')
    expect(csv).toContain('"\'+SUM(1,2)"')
  })

  it('文件名包含 tab 与时间戳', () => {
    expect(billingCsvFilename('invoice', new Date(2026, 8, 28, 14, 5, 9)))
      .toBe('供应链账务-发票-20260928-140509.csv')
  })

  it('点击下载后延迟回收 Blob URL，兼容 Safari 与 WebView', () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn(() => 'blob:billing-csv')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    downloadBillingCsv('invoice', [])

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4_999)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:billing-csv')
    expect(document.querySelector('a[download]')).toBeNull()
  })
})
