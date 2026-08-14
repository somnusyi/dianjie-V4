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

async function dailyArchive(layout: 'wide' | 'narrow' = 'wide') {
  const inventory = await xlsx([
    ['实时库存查询表-到仓库维度'],
    ['维度：【仓库】'],
    ['物品编码', '物品名称', '规格型号', '物品类别', '统计类型', '单位', '基准单位换算率', '辅助单位', '物品体积', '物品重量', '机构', '机构编码', '仓库', '库存量', '库存量（辅助单位）', '库存金额', '库存金额（不含税）', '库存税额', '库存均价（不含税）', '预计入库量', '预计出库量', '理论库存量', '理论库存金额'],
    ['SKU-1', '测试商品', '箱/10袋', '测试', '原料类', '袋', '1箱=10袋', '', '', '', '总部配送中心', 'PS1', '供应链总仓', 8, '', 80, 80, 0, 10, 0, 2, 6, 60],
    ['SKU-2', '零库存商品', '个', '测试', '原料类', '个', '1个=1个', '', '', '', '总部配送中心', 'PS1', '供应链总仓', 0, '', 0, 0, 0, 0, 0, 1, -1, -10],
  ], '实时库存查询表-到仓库维度')

  // 真实报表是两行表头:上面一行分组(入库/出库)，下面一行列名。「数量（基准单位）」
  // 在两个分组下各出现一次，所以列必须按「分组:列名」定位，不能写死列号——
  // 实测同一报表按导出条件不同会是 58 列或 27 列，出库数量会整体挪位。
  const group = Array(58).fill('')
  group[0] = '物品编码'; group[1] = '物品名称'; group[2] = '规格型号'
  group[6] = '基准单位'; group[7] = '单位'
  group[14] = '出入库单号'; group[16] = '出入库类型'; group[19] = '对方机构'
  group[22] = '出入库单据日期'; group[25] = '出入库单据审核时间'
  for (let index = 26; index <= 31; index += 1) group[index] = '入库'
  for (let index = 40; index <= 57; index += 1) group[index] = '出库'
  const detail = Array(58).fill('')
  detail[0] = '物品编码'; detail[1] = '物品名称'; detail[2] = '规格型号'
  detail[6] = '基准单位'; detail[7] = '单位'
  detail[14] = '出入库单号'; detail[16] = '出入库类型'; detail[19] = '对方机构'
  detail[22] = '出入库单据日期'; detail[25] = '出入库单据审核时间'
  detail[26] = '数量（基准单位）'; detail[27] = '数量'
  detail[40] = '数量（基准单位）'; detail[41] = '数量'
  detail[44] = '成本金额(含税)'; detail[48] = '结算金额(含税)'; detail[54] = '毛利'
  const movement = Array(58).fill('')
  movement[0] = 'SKU-1'; movement[1] = '测试商品'; movement[2] = '箱/10袋'; movement[6] = '袋'; movement[7] = '箱'; movement[14] = 'PFCK-1'; movement[16] = '配送发货出库'; movement[19] = '测试门店'; movement[25] = '2026-08-10 18:00:00'; movement[40] = 2; movement[41] = 0.2; movement[44] = 12; movement[48] = 20; movement[54] = 8

  // 窄版:导出条件只选「配送发货出库」时，美团只给 27 列——没有入库组，也没有
  // 成本/结算/毛利，出库数量从第 41/42 列挪到第 26/27 列，审核时间从 26 挪到 25。
  // 写死列号的旧实现在这种文件上会把出库数量全读成 0 且不报错。
  const narrow = (wide: unknown[]) => {
    const row = Array(27).fill('')
    for (const index of [0, 1, 2, 6, 7, 14, 16, 19, 22]) row[index] = wide[index]
    row[24] = wide[25]           // 出入库单据审核时间
    row[25] = wide[40]           // 出库 数量（基准单位）
    row[26] = wide[41]           // 出库 数量
    return row
  }
  const narrowGroup = narrow(group); narrowGroup[25] = '出库'; narrowGroup[26] = '出库'
  const narrowDetail = narrow(detail)
  const movementRows = layout === 'wide'
    ? [group, detail, movement]
    : [narrowGroup, narrowDetail, narrow(movement)]
  const movements = await xlsx([['出入库明细表'], ['日期：【2026/08/10 至 2026/08/10】'], ...movementRows], '出入库明细表')

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
    expect(parsed.summary.ledger.inbound).toEqual([expect.objectContaining({ externalCode: 'SKU-1', sourceUnit: '箱', quantity: 1, amount: 10 })])
    expect(parsed.summary.ledger.outbound).toEqual([expect.objectContaining({ externalCode: 'SKU-1', sourceUnit: '箱', baseUnit: '袋', quantity: 0.2, baseQuantity: 2, costAmount: 12 })])
    expect(parsed.summary.issues.map(issue => issue.code)).toContain('THEORETICAL_NEGATIVE_STOCK')
    expect(parsed.summary.issues.map(issue => issue.code)).toContain('RECEIPT_WITHOUT_PERIOD_PURCHASE')
    expect(parsed.inventoryBuffer.byteLength).toBeGreaterThan(100)
  })
  it('窄版导出(27 列)也能定位出库数量与审核时间，而不是静默算成 0', async () => {
    const parsed = await extractSupplyChainDailyPackage(await dailyArchive('narrow'))

    // 宽版里出库数量在第 41/42 列，窄版在 26/27。按表头名取列后两边结果一致。
    expect(parsed.summary.movements.outboundQuantity).toBe(2)
    expect(parsed.summary.ledger.outbound).toHaveLength(1)
    expect(parsed.summary.ledger.outbound[0]).toMatchObject({
      externalCode: 'SKU-1', baseQuantity: 2, quantity: 0.2,
    })
    // 审核时间在窄版是第 25 列，旧实现写死 26 会把数量当成时间戳读。
    expect(parsed.summary.ledger.outbound[0].effectiveAt).toContain('2026-08-10')
    // 窄版本来就没有成本/结算列，按 0 计而不是按列号猜。
    expect(parsed.summary.movements.costAmount).toBe(0)
  })
})
