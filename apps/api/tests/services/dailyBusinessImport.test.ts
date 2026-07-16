import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { normalizeDishName, normalizeVariantKey, parseDailyFiles } from '../../src/services/dailyBusinessImport'

async function workbookBuffer(workbook: ExcelJS.Workbook) {
  const value = await workbook.xlsx.writeBuffer()
  return Buffer.from(value)
}

async function businessFile(input: { date?: string; gross?: number; discount?: number; net?: number } = {}) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('综合营业统计')
  sheet.addRow(['综合营业统计'])
  sheet.addRow(['营业日期【2026/07/15-2026/07/15】'])
  sheet.addRow(['城市', '门店', '营业日', '营业额(元)', '优惠金额(元)', '营业收入(元)', '订单量', '用餐人数', '消费桌数'])
  sheet.addRow(['合肥市', '瑶海店', input.date || '2026/07/15', input.gross ?? 100, input.discount ?? 20, input.net ?? 80, 2, 4, 2])
  return workbookBuffer(workbook)
}

async function salesFile(input: { date?: string; net?: number } = {}) {
  const workbook = new ExcelJS.Workbook()
  const sold = workbook.addWorksheet('已销售')
  sold.addRow(['菜品销售明细'])
  sold.addRow([`【结账时间】；【${input.date || '2026/07/15'} 00:00 至 ${input.date || '2026/07/15'} 23:59】`])
  sold.addRow(['城市', '门店', '营业日期', '菜品编码', '菜品名称', '规格', '单位', '菜品大类', '订单编号', '销售数量', '销售额（元）', '菜品优惠（元）', '菜品收入（元）'])
  sold.addRow(['合肥', '瑶海店', input.date || '2026/07/15', '1001', '云南秘制黄牛肉（微微辣）', '小份', '份', '牛肉', 'A1', 1, 60, 10, input.net ?? 50])
  sold.addRow(['合肥', '瑶海店', input.date || '2026/07/15', '1001', '云南秘制黄牛肉（微微辣）', '小份', '份', '牛肉', 'A2', 1, 40, 10, 30])
  const returned = workbook.addWorksheet('退菜')
  returned.addRow(['退菜'])
  returned.addRow([`【结账时间】；【${input.date || '2026/07/15'} 00:00 至 ${input.date || '2026/07/15'} 23:59】`])
  returned.addRow(['城市', '门店', '营业日期', '菜品编码', '菜品名称', '规格', '单位', '菜品大类', '订单编号', '销售数量', '销售额（元）', '菜品优惠（元）', '菜品收入（元）'])
  returned.addRow(['合肥', '瑶海店', input.date || '2026/07/15', '1002', '百家蘸料', '', '份', '蘸料', 'A3', 1, 6, 0, 0])
  return workbookBuffer(workbook)
}

describe('daily business import parser', () => {
  it('parses and reconciles the two workbooks while keeping sale variants', async () => {
    const parsed = await parseDailyFiles(await businessFile(), await salesFile())
    expect(parsed.business).toMatchObject({
      date: '2026-07-15', grossAmount: 100, discountAmount: 20, netRevenue: 80, orders: 2,
    })
    expect(parsed.sales).toHaveLength(1)
    expect(parsed.sales[0]).toMatchObject({
      name: '云南秘制黄牛肉（微微辣）', spec: '小份', quantity: 2,
      grossAmount: 100, discountAmount: 20, netIncome: 80, uniqueOrders: 2,
    })
    expect(parsed.returns).toHaveLength(1)
    expect(parsed.blockingIssues).toEqual([])
    expect(parsed.warningIssues.map(issue => issue.code)).toContain('RETURNS_NOT_RESTOCKED')
  })

  it('blocks preview when the dates differ', async () => {
    const parsed = await parseDailyFiles(await businessFile(), await salesFile({ date: '2026/07/14' }))
    expect(parsed.blockingIssues.map(issue => issue.code)).toContain('DATE_MISMATCH')
  })

  it('blocks preview when revenue and dish totals do not reconcile', async () => {
    const parsed = await parseDailyFiles(await businessFile({ net: 79 }), await salesFile())
    expect(parsed.blockingIssues.map(issue => issue.code)).toContain('NET_MISMATCH')
  })

  it('normalizes POS names and specification keys consistently', () => {
    expect(normalizeDishName('10 秒·脆毛肚')).toBe(normalizeDishName('10秒脆毛肚'))
    expect(normalizeVariantKey('（大 份）')).toBe('大份')
    expect(normalizeVariantKey('')).toBe('')
  })
})
