import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { calculateDeferredBomConsumptions, normalizeDishName, normalizeVariantKey, parseDailyFiles, partitionImportIssues, storeNameMatches } from '../../src/services/dailyBusinessImport'

async function workbookBuffer(workbook: ExcelJS.Workbook) {
  const value = await workbook.xlsx.writeBuffer()
  return Buffer.from(value)
}

async function businessFile(input: { date?: string; gross?: number; discount?: number; net?: number; store?: string; extraStore?: string; omitStore?: boolean } = {}) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('综合营业统计')
  sheet.addRow(['综合营业统计'])
  sheet.addRow(['营业日期【2026/07/15-2026/07/15】'])
  const headers = ['城市', '门店', '营业日', '营业额(元)', '优惠金额(元)', '营业收入(元)', '订单量', '用餐人数', '消费桌数']
  const row = ['合肥市', input.store || '瑶海店', input.date || '2026/07/15', input.gross ?? 100, input.discount ?? 20, input.net ?? 80, 2, 4, 2]
  if (input.omitStore) {
    headers.splice(1, 1)
    row.splice(1, 1)
  }
  sheet.addRow(headers)
  sheet.addRow(row)
  if (input.extraStore) {
    const extraRow = ['合肥市', input.extraStore, input.date || '2026/07/15', 1, 0, 1, 1, 1, 1]
    if (input.omitStore) extraRow.splice(1, 1)
    sheet.addRow(extraRow)
  }
  return workbookBuffer(workbook)
}

async function salesFile(input: { date?: string; net?: number; store?: string; freeDish?: boolean; omitStore?: boolean } = {}) {
  const workbook = new ExcelJS.Workbook()
  const sold = workbook.addWorksheet('已销售')
  sold.addRow(['菜品销售明细'])
  sold.addRow([`【结账时间】；【${input.date || '2026/07/15'} 00:00 至 ${input.date || '2026/07/15'} 23:59】`])
  const soldHeaders = ['城市', '门店', '营业日期', '菜品编码', '菜品名称', '规格', '单位', '菜品大类', '订单编号', '销售数量', '销售额（元）', '菜品优惠（元）', '菜品收入（元）']
  const soldRows: any[][] = [
    ['合肥', input.store || '瑶海店', input.date || '2026/07/15', '1001', '云南秘制黄牛肉（微微辣）', '小份', '份', '牛肉', 'A1', 1, 60, 10, input.net ?? 50],
    ['合肥', input.store || '瑶海店', input.date || '2026/07/15', '1001', '云南秘制黄牛肉（微微辣）', '小份', '份', '牛肉', 'A2', 1, 40, 10, 30],
  ]
  if (input.freeDish) soldRows.push(['合肥', input.store || '瑶海店', input.date || '2026/07/15', '1003', '赠品', '', '份', '赠品', 'A3', 1, 6, 0, 0])
  if (input.omitStore) {
    soldHeaders.splice(1, 1)
    soldRows.forEach(row => row.splice(1, 1))
  }
  sold.addRow(soldHeaders)
  soldRows.forEach(row => sold.addRow(row))
  const returned = workbook.addWorksheet('退菜')
  returned.addRow(['退菜'])
  returned.addRow([`【结账时间】；【${input.date || '2026/07/15'} 00:00 至 ${input.date || '2026/07/15'} 23:59】`])
  const returnHeaders = ['城市', '门店', '营业日期', '菜品编码', '菜品名称', '规格', '单位', '菜品大类', '订单编号', '销售数量', '销售额（元）', '菜品优惠（元）', '菜品收入（元）']
  const returnRow = ['合肥', '瑶海店', input.date || '2026/07/15', '1002', '百家蘸料', '', '份', '蘸料', 'A3', 1, 6, 0, 0]
  if (input.omitStore) {
    returnHeaders.splice(1, 1)
    returnRow.splice(1, 1)
  }
  returned.addRow(returnHeaders)
  returned.addRow(returnRow)
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

  it('keeps an explicit zero dish income instead of replacing it with gross minus discount', async () => {
    const parsed = await parseDailyFiles(
      await businessFile({ gross: 106, discount: 20, net: 80 }),
      await salesFile({ freeDish: true }),
    )
    expect(parsed.sales.find(row => row.name === '赠品')?.netIncome).toBe(0)
    expect(parsed.blockingIssues).toEqual([])
  })

  it('blocks files exported for different stores', async () => {
    const parsed = await parseDailyFiles(await businessFile(), await salesFile({ store: '万象汇店' }))
    expect(parsed.blockingIssues.map(issue => issue.code)).toContain('FILE_STORE_MISMATCH')
  })

  it('uses the authenticated target store when both exports omit the store column', async () => {
    const parsed = await parseDailyFiles(
      await businessFile({ omitStore: true }),
      await salesFile({ omitStore: true }),
      { targetStoreName: '合肥瑶海店' },
    )
    expect(parsed.business.storeName).toBe('合肥瑶海店')
    expect(parsed.blockingIssues).toEqual([])
  })

  it('still blocks missing store identity outside an authenticated store context', async () => {
    const parsed = await parseDailyFiles(
      await businessFile({ omitStore: true }),
      await salesFile({ omitStore: true }),
    )
    expect(parsed.blockingIssues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'BUSINESS_STORE_INVALID',
      'SALES_STORE_INVALID',
    ]))
  })

  it('rejects a comprehensive workbook that contains more than one store row', async () => {
    await expect(parseDailyFiles(await businessFile({ extraStore: '万象汇店' }), await salesFile()))
      .rejects.toThrow('单店单日')
  })

  it('normalizes POS names and specification keys consistently', () => {
    expect(normalizeDishName('10 秒·脆毛肚')).toBe(normalizeDishName('10秒脆毛肚'))
    expect(normalizeVariantKey('（大 份）')).toBe('大份')
    expect(normalizeVariantKey('')).toBe('')
    expect(storeNameMatches('合肥瑶海店', '滇界·云南山珍菌汤锅（瑶海万达店）')).toBe(true)
    expect(storeNameMatches('合肥瑶海店', '滇界·云南山珍菌汤锅（万象汇店）')).toBe(false)
  })

  it('defers missing dish, BOM and unit-governance issues without allowing identity errors', () => {
    const result = partitionImportIssues([
      { code: 'DISH_UNMATCHED', message: '菜品未建档' },
      { code: 'BOM_MISSING', message: '缺少 BOM' },
      { code: 'INVENTORY_UNIT_PENDING', message: '原材料单位换算待核验' },
      { code: 'DISH_AMBIGUOUS', message: '菜品匹配不唯一' },
      { code: 'TARGET_STORE_MISMATCH', message: '门店不一致' },
    ])
    expect(result.deferrable.map(issue => issue.code)).toEqual(['DISH_UNMATCHED', 'BOM_MISSING', 'INVENTORY_UNIT_PENDING'])
    expect(result.hard.map(issue => issue.code)).toEqual(['DISH_AMBIGUOUS', 'TARGET_STORE_MISMATCH'])
  })

  it('calculates deferred BOM backfill with loss and aggregates duplicate products', () => {
    expect(calculateDeferredBomConsumptions(3, [
      { productId: 'p2', quantity: '0.2', lossRate: '0.1' },
      { productId: 'p1', quantity: '0.1', lossRate: '0' },
      { productId: 'p1', quantity: '0.05', lossRate: '0' },
      { productId: 'ignored', quantity: '0', lossRate: '0' },
    ])).toEqual([
      { productId: 'p1', quantity: 0.45 },
      { productId: 'p2', quantity: 0.66 },
    ])
  })
})
