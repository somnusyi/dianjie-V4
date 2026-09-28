import { describe, expect, it } from 'vitest'
import { collectReportPages, reportCsv } from './table-report'

describe('完整筛选结果打印', () => {
  it('读取所有分页而不是只使用当前页', async () => {
    const calls: number[] = []
    const rows = await collectReportPages(async (page, size) => {
      calls.push(page)
      expect(size).toBe(100)
      return { total: 205, items: Array.from({ length: page === 3 ? 5 : 100 }, (_, index) => ({ id: String((page - 1) * size + index) })) }
    })
    expect(calls).toEqual([1, 2, 3])
    expect(rows).toHaveLength(205)
    expect(rows[204].id).toBe('204')
  })

  it('拒绝超限、总数漂移与缺页，避免把不完整数据当成全部', async () => {
    await expect(collectReportPages(async () => ({ total: 10001, items: [] }))).rejects.toThrow('缩小筛选')
    await expect(collectReportPages(async page => ({ total: page === 1 ? 2 : 3, items: [1] }))).rejects.toThrow('记录已变化')
    await expect(collectReportPages(async () => ({ total: 1, items: [] }))).rejects.toThrow('不完整')
    expect(await collectReportPages(async () => ({ total: 0, items: [] }))).toEqual([])
  })

  it('CSV保留中文、引号、换行和金额，并阻断单元格公式', () => {
    const csv = reportCsv({ title: '测试', headers: ['商品', '金额'], rows: [['菌菇,"鲜"\n第二行', -2.5], ['=HYPERLINK("x")', 0]] })
    expect(csv).toContain('\uFEFF"商品","金额"')
    expect(csv).toContain('"菌菇,""鲜""\n第二行","-2.5"')
    expect(csv).toContain('"\'=HYPERLINK(""x"")"')
  })
})
