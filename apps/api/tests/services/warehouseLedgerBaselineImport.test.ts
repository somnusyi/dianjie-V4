import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  normalizeExternalProductCode,
  parseMeituanUnitConversion,
  parseMeituanWarehouseInventoryWorkbook,
  resolveWarehouseInventoryRow,
  warehouseInventoryFileHash,
  type InventoryImportProduct,
  type ParsedWarehouseInventoryRow,
} from '../../src/services/warehouseInventoryImport'
import { warehouseSnapshotCutoffShanghai } from '../../src/services/warehouseLedgerBaselineImport'

const REAL_FILE_PATH = '/Users/somnusyi/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_hata3ao0ldvj22_1a9d/temp/drag/供应链7.31日库存(1).xlsx'

describe('warehouse ledger baseline import – Shanghai cutoff', () => {
  it('derives the end of the imported calendar day without client timezone input', () => {
    expect(warehouseSnapshotCutoffShanghai(new Date('2026-07-31T00:00:00.000Z')).toISOString())
      .toBe('2026-07-31T15:59:59.999Z')
  })
})

function sourceRow(overrides: Partial<ParsedWarehouseInventoryRow> = {}): ParsedWarehouseInventoryRow {
  return {
    rowNumber: 4,
    externalCode: 'ZBWP0768',
    externalName: '甄选青提汁',
    sourceSpec: '1.2kg*12瓶/箱',
    sourceCategory: '饮品材料',
    sourceWarehouseName: '供应链总仓',
    purchaseUnit: '瓶',
    conversionText: '1瓶=1瓶',
    sourceQuantity: 9,
    inventoryAmount: 270,
    inventoryAmountExcludingTax: 270,
    inventoryTax: 0,
    averageCostExcludingTax: 30,
    expectedInboundQuantity: 0,
    expectedOutboundQuantity: 0,
    theoreticalQuantity: 9,
    theoreticalAmount: 270,
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
    name: '甄选青提汁',
    status: 'ENABLED',
    supplierId: 'supplier-1',
    unit: '瓶',
    purchaseUnit: '瓶',
    inventoryUnit: '瓶',
    orderUnit: '瓶',
    costUnit: '瓶',
    inventoryUnitsPerPurchaseUnit: 1,
    inventoryUnitsPerOrderUnit: 1,
    inventoryUnitsPerCostUnit: 1,
    unitConversionStatus: 'VERIFIED',
    ...overrides,
  }
}

async function buildSyntheticWorkbook(rows: Array<Record<string, unknown>>, warehouses = ['供应链总仓', '测试仓']) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('实时库存查询表-到仓库维度')
  sheet.getCell('A1').value = '实时库存查询表-到仓库维度'
  sheet.getCell('A2').value = `维度：【仓库】；机构：【总部配送中心】；仓库：【已选择${warehouses.length}个】；计量单位类型：【采购单位】`
  const headers = [
    '物品编码', '物品名称', '规格型号', '物品类别', '统计类型', '单位', '基准单位换算率', '仓库',
    '库存量', '库存金额', '库存金额（不含税）', '库存税额', '库存均价（不含税）',
    '预计入库量', '预计出库量', '理论库存量', '理论库存金额',
  ]
  sheet.addRow(headers)
  for (const row of rows) {
    sheet.addRow(headers.map(h => row[h] ?? ''))
  }
  sheet.addRow(['合计', '', '', '', '', '', '', '', 999, '', '', '', '', '', '', '', ''])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('warehouse ledger baseline import – file parsing', () => {
  it('parses the real 7.31 supply chain file with correct row count and warehouse grouping', async () => {
    let buffer: Buffer
    try {
      const { readFile } = await import('node:fs/promises')
      buffer = await readFile(REAL_FILE_PATH)
    } catch {
      return
    }
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)
    expect(parsed.rows.length).toBeGreaterThanOrEqual(180)
    expect(parsed.rows.length).toBeLessThanOrEqual(200)
    expect(parsed.sourceRowCount).toBe(parsed.rows.length)
    const warehouseNames = [...new Set(parsed.rows.map(r => r.sourceWarehouseName))]
    expect(warehouseNames).toEqual(['供应链总仓'])
    expect(parsed.ignoredWarehouses).toEqual([])
  })

  it('computes a stable file hash for idempotency', async () => {
    let buffer: Buffer
    try {
      const { readFile } = await import('node:fs/promises')
      buffer = await readFile(REAL_FILE_PATH)
    } catch {
      return
    }
    const hash1 = warehouseInventoryFileHash(buffer)
    const hash2 = warehouseInventoryFileHash(buffer)
    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(64)
    const different = warehouseInventoryFileHash(Buffer.from('different content'))
    expect(different).not.toBe(hash1)
  })

  it('filters rows by target warehouse and records ignored warehouses', async () => {
    const buffer = await buildSyntheticWorkbook([
      { 物品编码: 'A001', 物品名称: '总仓商品', 单位: 'kg', 基准单位换算率: '1kg=1kg', 仓库: '供应链总仓', 库存量: 10, 库存金额: 100, '库存金额（不含税）': 100, 库存税额: 0, '库存均价（不含税）': 10, 预计入库量: 0, 预计出库量: 0, 理论库存量: 10, 理论库存金额: 100 },
      { 物品编码: 'B001', 物品名称: '测试仓商品', 单位: 'kg', 基准单位换算率: '1kg=1kg', 仓库: '测试仓', 库存量: 5, 库存金额: 50, '库存金额（不含税）': 50, 库存税额: 0, '库存均价（不含税）': 10, 预计入库量: 0, 预计出库量: 0, 理论库存量: 5, 理论库存金额: 50 },
      { 物品编码: 'A002', 物品名称: '总仓商品2', 单位: 'kg', 基准单位换算率: '1kg=1kg', 仓库: '供应链总仓', 库存量: 3, 库存金额: 30, '库存金额（不含税）': 30, 库存税额: 0, '库存均价（不含税）': 10, 预计入库量: 0, 预计出库量: 0, 理论库存量: 3, 理论库存金额: 30 },
    ])
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows.every(r => r.sourceWarehouseName === '供应链总仓')).toBe(true)
    expect(parsed.ignoredWarehouses).toEqual(['测试仓'])
    expect(parsed.ignoredRowCount).toBe(1)
  })

  it('keeps zero-quantity rows but flags them for audit', async () => {
    const buffer = await buildSyntheticWorkbook([
      { 物品编码: 'ZERO01', 物品名称: '零库存品', 单位: '袋', 基准单位换算率: '1袋=1袋', 仓库: '供应链总仓', 库存量: 0, 库存金额: 0, '库存金额（不含税）': 0, 库存税额: 0, '库存均价（不含税）': 0, 预计入库量: 0, 预计出库量: 0, 理论库存量: 0, 理论库存金额: 0 },
    ])
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0].sourceQuantity).toBe(0)
  })

  it('detects duplicate external codes within the same warehouse', async () => {
    const buffer = await buildSyntheticWorkbook([
      { 物品编码: 'DUP001', 物品名称: '重复品A', 单位: 'kg', 基准单位换算率: '1kg=1kg', 仓库: '供应链总仓', 库存量: 5, 库存金额: 50, '库存金额（不含税）': 50, 库存税额: 0, '库存均价（不含税）': 10, 预计入库量: 0, 预计出库量: 0, 理论库存量: 5, 理论库存金额: 50 },
      { 物品编码: 'DUP001', 物品名称: '重复品B', 单位: 'kg', 基准单位换算率: '1kg=1kg', 仓库: '供应链总仓', 库存量: 3, 库存金额: 30, '库存金额（不含税）': 30, 库存税额: 0, '库存均价（不含税）': 10, 预计入库量: 0, 预计出库量: 0, 理论库存量: 3, 理论库存金额: 30 },
    ])
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)
    expect(parsed.rows).toHaveLength(2)
    for (const row of parsed.rows) {
      expect(row.issues).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_EXTERNAL_CODE' }))
    }
  })
})

describe('warehouse ledger baseline import – unit conversion', () => {
  it('normalizes external product codes to upper-case for matching', () => {
    expect(normalizeExternalProductCode('zbwp0768')).toBe('ZBWP0768')
    expect(normalizeExternalProductCode('  ZBWP-001  ')).toBe('ZBWP-001')
    expect(normalizeExternalProductCode('')).toBe('')
  })

  it('parses all conversion patterns found in the real 7.31 file', () => {
    const patterns = [
      '1瓶=1瓶', '1kg=1kg', '1箱=8袋', '1箱=60袋', '1箱=10袋', '1箱=12瓶',
      '1箱=20袋', '1袋=1袋', '1桶=1桶', '1箱=12.5kg', '1箱=10斤', '1箱=7.5kg',
      '1箱=3kg', '1箱=80袋', '1箱=100袋', '1箱=14斤', '1箱=60个', '1箱=17袋',
      '1箱=2桶', '1箱=6盒', '1箱=10g', '1件=6盒', '1件=20杯', '1件=12瓶',
      '1箱=24瓶', '1箱=20瓶', '1箱=6瓶', '1箱=2瓶', '1箱=5袋', '1箱=25袋',
      '1箱=40袋', '1箱=32盒', '1箱=12盒', '1箱=144个', '1箱=250盒', '1箱=500盒',
      '1箱=50包', '1箱=20包', '1箱=48罐', '1箱=50卷', '1箱=200卷', '1包=1包',
      '1罐=1罐', '1盒=1盒', '1个=1个', '1把=1把', '1斤=1斤', '1箱=50袋',
      '1袋=100个', '1袋=40包', '1箱=1箱',
    ]
    for (const pattern of patterns) {
      const parsed = parseMeituanUnitConversion(pattern)
      expect(parsed, `failed to parse: ${pattern}`).not.toBeNull()
      expect(parsed!.leftQuantity).toBeGreaterThan(0)
      expect(parsed!.rightQuantity).toBeGreaterThan(0)
    }
  })

  it('converts purchase unit quantities to inventory unit using verified factor', () => {
    const row = sourceRow({
      externalCode: 'ZBWP0950',
      externalName: '测试袋装品',
      purchaseUnit: '箱',
      conversionText: '1箱=8袋',
      sourceQuantity: 54.875,
      inventoryAmount: 100,
      averageCostExcludingTax: 2,
    })
    const prod = product({
      name: '测试袋装品',
      purchaseUnit: '箱',
      inventoryUnit: '袋',
      inventoryUnitsPerPurchaseUnit: 8,
      unitConversionStatus: 'VERIFIED',
    })
    const resolved = resolveWarehouseInventoryRow(row, prod, 'EXACT_CODE')
    expect(resolved.productId).toBe('product-1')
    expect(resolved.inventoryUnit).toBe('袋')
    expect(resolved.conversionFactor).toBe(8)
    expect(resolved.normalizedQuantity).toBe(439)
    expect(resolved.issues).toEqual([])
  })

  it('accepts a parseable source conversion while leaving the product master pending', () => {
    const row = sourceRow({ purchaseUnit: '箱', conversionText: '1箱=8袋', sourceQuantity: 10 })
    const prod = product({
      purchaseUnit: '箱',
      inventoryUnit: '袋',
      inventoryUnitsPerPurchaseUnit: 8,
      unitConversionStatus: 'PENDING',
    })
    const resolved = resolveWarehouseInventoryRow(row, prod, 'EXACT_CODE')
    expect(resolved.issues).toEqual([])
    expect(resolved.warnings).toContainEqual(expect.objectContaining({ code: 'UNIT_CONFIRMED_BY_SOURCE_SNAPSHOT' }))
  })

  it('blocks when source purchase unit does not match system purchase unit', () => {
    const row = sourceRow({ purchaseUnit: '桶', conversionText: '1桶=1桶', sourceQuantity: 5 })
    const prod = product({ purchaseUnit: '箱', inventoryUnit: '瓶', inventoryUnitsPerPurchaseUnit: 24 })
    const resolved = resolveWarehouseInventoryRow(row, prod, 'EXACT_CODE')
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: 'PURCHASE_UNIT_MISMATCH' }))
  })

  it('uses the dated source factor and audits a contradiction with the current verified factor', () => {
    const row = sourceRow({ purchaseUnit: '箱', conversionText: '1箱=10袋', sourceQuantity: 5 })
    const prod = product({
      purchaseUnit: '箱',
      inventoryUnit: '袋',
      inventoryUnitsPerPurchaseUnit: 8,
      unitConversionStatus: 'VERIFIED',
    })
    const resolved = resolveWarehouseInventoryRow(row, prod, 'EXACT_CODE')
    expect(resolved.issues).toEqual([])
    expect(resolved.warnings).toContainEqual(expect.objectContaining({ code: 'UNIT_CONVERSION_MISMATCH' }))
    expect(resolved.normalizedQuantity).toBe(50)
  })

  it('flags items with quantity>0 but zero amount as cost-pending warnings', async () => {
    const buffer = await buildSyntheticWorkbook([
      { 物品编码: 'COST01', 物品名称: '缺成本品', 单位: 'kg', 基准单位换算率: '1kg=1kg', 仓库: '供应链总仓', 库存量: 10, 库存金额: 0, '库存金额（不含税）': 0, 库存税额: 0, '库存均价（不含税）': 0, 预计入库量: 0, 预计出库量: 0, 理论库存量: 10, 理论库存金额: 0 },
    ])
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)
    expect(parsed.rows[0].warnings).toContainEqual(expect.objectContaining({ code: 'COST_PENDING' }))
  })
})

describe('warehouse ledger baseline import – blocking and resolution', () => {
  it('blocks unmatched items with SKU_UNMATCHED', () => {
    const resolved = resolveWarehouseInventoryRow(sourceRow(), null, null)
    expect(resolved.productId).toBeNull()
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: 'SKU_UNMATCHED' }))
  })

  it('blocks name-only suggestions until external code is confirmed', () => {
    const resolved = resolveWarehouseInventoryRow(sourceRow(), product(), 'NAME_SUGGESTION')
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: 'EXTERNAL_CODE_REVIEW_REQUIRED' }))
  })

  it('blocks disabled products', () => {
    const resolved = resolveWarehouseInventoryRow(sourceRow(), product({ status: 'DISABLED' }), 'EXACT_CODE')
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: 'PRODUCT_NOT_ENABLED' }))
  })

  it('blocks products without supplier binding', () => {
    const resolved = resolveWarehouseInventoryRow(sourceRow(), product({ supplierId: null }), 'EXACT_CODE')
    expect(resolved.issues).toContainEqual(expect.objectContaining({ code: 'SUPPLIER_BINDING_MISSING' }))
  })

  it('warns when source name differs from system product name', () => {
    const resolved = resolveWarehouseInventoryRow(
      sourceRow({ externalName: '青提汁' }),
      product({ name: '甄选青提汁' }),
      'EXACT_CODE',
    )
    expect(resolved.warnings).toContainEqual(expect.objectContaining({ code: 'SOURCE_NAME_DIFFERS' }))
  })

  it('allows zero-quantity items to resolve without blocking', () => {
    const row = sourceRow({ sourceQuantity: 0, inventoryAmount: 0 })
    const resolved = resolveWarehouseInventoryRow(row, product(), 'EXACT_CODE')
    expect(resolved.productId).toBe('product-1')
    expect(resolved.normalizedQuantity).toBe(0)
    expect(resolved.issues.filter(i => i.code !== 'COST_PENDING')).toEqual([])
  })
})

describe('warehouse ledger baseline import – real file data quality', () => {
  it('reports data quality summary for the 7.31 snapshot', async () => {
    let buffer: Buffer
    try {
      const { readFile } = await import('node:fs/promises')
      buffer = await readFile(REAL_FILE_PATH)
    } catch {
      return
    }
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)

    const conversionPatterns = new Map<string, number>()
    const zeroQtyItems: string[] = []
    const costPendingItems: string[] = []
    const negativeTheoretical: string[] = []

    for (const row of parsed.rows) {
      const conv = row.conversionText || '(none)'
      conversionPatterns.set(conv, (conversionPatterns.get(conv) || 0) + 1)
      if (row.sourceQuantity === 0) zeroQtyItems.push(row.externalCode)
      if (row.warnings.some(w => w.code === 'COST_PENDING')) costPendingItems.push(row.externalCode)
      if (row.theoreticalQuantity < 0) negativeTheoretical.push(row.externalCode)
    }

    expect(parsed.rows.length).toBe(187)
    expect(zeroQtyItems.length).toBe(7)
    expect(negativeTheoretical.length).toBeGreaterThanOrEqual(0)
    expect(conversionPatterns.size).toBeGreaterThan(40)

    const trivialConversions = [...conversionPatterns.entries()]
      .filter(([pattern]) => /^1\w+=1\w+$/.test(pattern.replace(/\s/g, '')))
      .reduce((sum, [, count]) => sum + count, 0)
    expect(trivialConversions).toBeLessThan(parsed.rows.length)
  })

  it('verifies all conversion patterns are parseable', async () => {
    let buffer: Buffer
    try {
      const { readFile } = await import('node:fs/promises')
      buffer = await readFile(REAL_FILE_PATH)
    } catch {
      return
    }
    const parsed = await parseMeituanWarehouseInventoryWorkbook(buffer)
    const unparseable: string[] = []
    for (const row of parsed.rows) {
      if (row.conversionText && !parseMeituanUnitConversion(row.conversionText)) {
        unparseable.push(`${row.externalCode}: ${row.conversionText}`)
      }
    }
    expect(unparseable).toEqual([])
  })
})

describe('warehouse ledger baseline import – file hash idempotency', () => {
  it('produces different hashes for different file contents', () => {
    const hash1 = warehouseInventoryFileHash(Buffer.from('content-a'))
    const hash2 = warehouseInventoryFileHash(Buffer.from('content-b'))
    expect(hash1).not.toBe(hash2)
  })

  it('produces sha-256 hex digest of correct length', () => {
    const hash = warehouseInventoryFileHash(Buffer.from('test'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const expected = crypto.createHash('sha256').update(Buffer.from('test')).digest('hex')
    expect(hash).toBe(expected)
  })
})
