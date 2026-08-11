import ExcelJS from 'exceljs'
import SevenZip from '7z-wasm'
import { describe, expect, it } from 'vitest'
import { extractSupplyChainDailyPackage } from '../../src/services/supplyChainDailyPackage'

async function xlsx(rows: unknown[][], name: string) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(name)
  rows.forEach(row => sheet.addRow(row))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function dailyArchive() {
  const inventory = await xlsx([
    ['实时库存查询表-到仓库维度'],
    ['维度：【仓库】'],
    ['物品编码', '物品名称', '规格型号', '物品类别', '统计类型', '单位', '基准单位换算率', '辅助单位', '物品体积', '物品重量', '机构', '机构编码', '仓库', '库存量', '库存量（辅助单位）', '库存金额', '库存金额（不含税）', '库存税额', '库存均价（不含税）', '预计入库量', '预计出库量', '理论库存量', '理论库存金额'],
    ['SKU-1', '测试商品', '箱/10袋', '测试', '原料类', '袋', '1箱=10袋', '', '', '', '总部配送中心', 'PS1', '供应链总仓', 8, '', 80, 80, 0, 10, 0, 2, 6, 60],
    ['SKU-2', '零库存商品', '个', '测试', '原料类', '个', '1个=1个', '', '', '', '总部配送中心', 'PS1', '供应链总仓', 0, '', 0, 0, 0, 0, 0, 1, -1, -10],
  ], '实时库存查询表-到仓库维度')

  const group = Array(58).fill('')
  group[0] = '物品编码'; group[1] = '物品名称'; group[14] = '出入库单号'; group[16] = '出入库类型'
  const detail = Array(58).fill('')
  detail[0] = '物品编码'; detail[1] = '物品名称'; detail[14] = '出入库单号'; detail[16] = '出入库类型'
  const movement = Array(58).fill('')
  movement[0] = 'SKU-1'; movement[1] = '测试商品'; movement[14] = 'PFCK-1'; movement[16] = '配送发货出库'; movement[19] = '测试门店'; movement[40] = 2; movement[44] = 12; movement[48] = 20; movement[54] = 8
  const movements = await xlsx([['出入库明细表'], ['日期：【2026/08/10 至 2026/08/10】'], group, detail, movement], '出入库明细表')

  const purchasing = await xlsx([
    ['采购汇总表'],
    ['业务日期【2026/08/10-2026/08/10】'],
    ['供应商名称', '采购机构', '收货方', '物品名称', '物品编码', '规格型号', '物品类别', '统计类型', '业务模式', '单位', '采购数量', '采购金额（含税）', '采购金额（不含税）', '收货数量', '收货金额（含税）', '收货金额（不含税）', '退货数量', '退货金额（含税）', '退货金额（不含税）', '净收货数量', '净收货金额（含税）', '净收货均价（含税）', '净收货均价（不含税）'],
    ['测试供应商', '总部配送中心', '总部配送中心', '测试商品', 'SKU-1', '箱/10袋', '测试', '原料类', '常规采购', '箱', 0, 0, 0, 1, 10, 10, 0, 0, 0, 1, 10, 10, 10],
  ], '采购汇总表')

  const files = [
    ['集团_实时库存查询表-到仓库维度_20260810_2001_test.xlsx', inventory],
    ['集团_出入库明细表-单据+物品维度_20260810_2000_test.xlsx', movements],
    ['集团_采购汇总表_20260810_2001_test.xlsx', purchasing],
  ] as const
  const sevenZip = await SevenZip({ print: () => {}, printErr: () => {} })
  for (const [filename, buffer] of files) sevenZip.FS.writeFile(filename, buffer)
  sevenZip.callMain(['a', 'daily.7z', ...files.map(([filename]) => filename)])
  return Buffer.from(sevenZip.FS.readFile('daily.7z'))
}

describe('supply chain daily package', () => {
  it('extracts all three reports and builds a reconciliation summary', async () => {
    const parsed = await extractSupplyChainDailyPackage(await dailyArchive())

    expect(parsed.summary.packageDate).toBe('2026-08-10')
    expect(parsed.summary.sourceSnapshotAt).toBe('2026-08-10T20:01:00+08:00')
    expect(parsed.summary.inventory).toMatchObject({ rowCount: 2, positiveCount: 1, zeroCount: 1, theoreticalNegativeCount: 1, amount: 80 })
    expect(parsed.summary.movements).toMatchObject({ rowCount: 1, documentCount: 1, storeCount: 1, skuCount: 1, costAmount: 12, settlementAmount: 20, grossProfit: 8, grossMargin: 40 })
    expect(parsed.summary.purchasing).toMatchObject({ rowCount: 1, supplierCount: 1, skuCount: 1, receivedAmount: 10, receivedWithoutPurchaseCount: 1 })
    expect(parsed.summary.issues.map(issue => issue.code)).toContain('THEORETICAL_NEGATIVE_STOCK')
    expect(parsed.summary.issues.map(issue => issue.code)).toContain('RECEIPT_WITHOUT_PERIOD_PURCHASE')
    expect(parsed.inventoryBuffer.byteLength).toBeGreaterThan(100)
  })
})
