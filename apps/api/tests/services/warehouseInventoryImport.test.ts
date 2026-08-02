import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  parseMeituanUnitConversion,
  parseMeituanWarehouseInventoryWorkbook,
  resolveWarehouseInventoryRow,
  type InventoryImportProduct,
  type ParsedWarehouseInventoryRow,
} from '../../src/services/warehouseInventoryImport'

const HEADERS = [
  '物品编码', '物品名称', '规格型号', '物品类别', '单位', '基准单位换算率', '仓库',
  '库存量', '库存金额', '库存金额(不含税)', '库存税额', '库存均价(不含税)',
  '预计入库量', '预计出库量', '理论库存量', '理论库存金额', '备注',
]

async function workbookBuffer() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('实时库存查询表-到仓库维度')
  sheet.getCell('A1').value = '实时库存查询表'
  sheet.getCell('A2').value = '仓库：供应链总仓、测试仓；单位：采购单位'
  sheet.addRow(HEADERS)
  sheet.addRow(['ZBWP0950', '测试袋装品', '8袋/箱', '干货', '箱', '1箱=8袋', '供应链总仓', 54.875, 100, 90, 10, 2, 0, 0, 54.875, 100, ''])
  sheet.addRow(['ZBWP0000', '零库存品', null, '干货', '袋', '1袋=1袋', '供应链总仓', 0, 0, 0, 0, 0, 0, 0, 0, 0, ''])
  sheet.addRow(['OTHER001', '其他仓商品', null, '干货', '袋', '1袋=1袋', '测试仓', 3, 60, 60, 0, 20, 0, 0, 3, 60, ''])
  sheet.addRow(['合计', '', '', '', '', '', '', '', 999, '', '', '', '', '', '', '', ''])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

function sourceRow(overrides: Partial<ParsedWarehouseInventoryRow> = {}): ParsedWarehouseInventoryRow {
  return {
    rowNumber: 4,
    externalCode: 'ZBWP0950',
    externalName: '测试袋装品',
    sourceSpec: '8袋/箱',
    sourceCategory: '干货',
    sourceWarehouseName: '供应链总仓',
    purchaseUnit: '箱',
    conversionText: '1箱=8袋',
    sourceQuantity: 54.875,
    inventoryAmount: 100,
    inventoryAmountExcludingTax: 90,
    inventoryTax: 10,
    averageCostExcludingTax: 2,
    expectedInboundQuantity: 0,
    expectedOutboundQuantity: 0,
    theoreticalQuantity: 54.875,
    theoreticalAmount: 100,
    issues: [],
    warnings: [],
    rawData: {},
    ...overrides,
  }
}

function product(overrides: Partial<InventoryImportProduct> = {}): InventoryImportProduct {
  return {
    id: 'product-1',
    code: 'DJ001',
    name: '测试袋装品',
    status: 'ENABLED',
    supplierId: 'supplier-1',
    unit: '箱',
    purchaseUnit: '箱',
    inventoryUnit: '袋',
    orderUnit: '箱',
    costUnit: '袋',
    inventoryUnitsPerPurchaseUnit: 8,
    inventoryUnitsPerOrderUnit: 8,
    inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'VERIFIED',
    ...overrides,
  }
}

describe('Meituan warehouse inventory snapshot', () => {
  it('keeps the target warehouse, zero balances and source precision while ignoring the total row', async () => {
    const parsed = await parseMeituanWarehouseInventoryWorkbook(await workbookBuffer())

    expect(parsed.sourceRowCount).toBe(3)
    expect(parsed.ignoredRowCount).toBe(1)
    expect(parsed.ignoredWarehouses).toEqual(['测试仓'])
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toMatchObject({ externalCode: 'ZBWP0950', sourceQuantity: 54.875, purchaseUnit: '箱' })
    expect(parsed.rows[1]).toMatchObject({ externalCode: 'ZBWP0000', sourceQuantity: 0 })
    expect(parsed.detailTotalAmount).toBe(100)
    expect(parsed.sourceTotalAmount).toBe(999)
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: 'SOURCE_TOTAL_MISMATCH' }))
  })

  it('treats the source unit as the purchase/receiving unit and normalizes into the verified inventory unit', () => {
    expect(parseMeituanUnitConversion('1箱 = 8袋')).toEqual({
      leftQuantity: 1, leftUnit: '箱', rightQuantity: 8, rightUnit: '袋',
    })
    const resolved = resolveWarehouseInventoryRow(sourceRow(), product(), 'EXACT_CODE')
    expect(resolved).toMatchObject({
      productId: 'product-1',
      inventoryUnit: '袋',
      conversionFactor: 8,
      normalizedQuantity: 439,
      issues: [],
    })
  })

  it('blocks name-only suggestions until an operator confirms the external code mapping', () => {
    const resolved = resolveWarehouseInventoryRow(sourceRow(), product(), 'NAME_SUGGESTION')
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: 'EXTERNAL_CODE_REVIEW_REQUIRED' }))
  })

  it('blocks unverified or contradictory unit contracts instead of silently guessing', () => {
    const pending = resolveWarehouseInventoryRow(sourceRow(), product({ unitConversionStatus: 'PENDING' }), 'EXACT_CODE')
    expect(pending.issues).toContainEqual(expect.objectContaining({ code: 'UNIT_CONVERSION_NOT_VERIFIED' }))

    const mismatch = resolveWarehouseInventoryRow(sourceRow(), product({ inventoryUnitsPerPurchaseUnit: 12 }), 'EXACT_CODE')
    expect(mismatch.issues).toContainEqual(expect.objectContaining({ code: 'UNIT_CONVERSION_MISMATCH' }))
  })
})
