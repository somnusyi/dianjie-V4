import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import { Prisma } from '@dianjie/db'
import { resolveProductInventoryUnit, type ProductInventoryUnitLike } from './inventoryUnits'

export type WarehouseInventoryIssue = {
  code: string
  message: string
  detail?: string
}

export type ParsedWarehouseInventoryRow = {
  rowNumber: number
  externalCode: string
  externalName: string
  sourceSpec: string | null
  sourceCategory: string | null
  sourceWarehouseName: string
  purchaseUnit: string
  conversionText: string | null
  sourceQuantity: number
  inventoryAmount: number
  inventoryAmountExcludingTax: number
  inventoryTax: number
  averageCostExcludingTax: number
  expectedInboundQuantity: number
  expectedOutboundQuantity: number
  theoreticalQuantity: number
  theoreticalAmount: number
  issues: WarehouseInventoryIssue[]
  warnings: WarehouseInventoryIssue[]
  rawData: Record<string, unknown>
}

export type ParsedWarehouseInventoryWorkbook = {
  sheetName: string
  title: string
  filterDescription: string
  sourceRowCount: number
  ignoredRowCount: number
  ignoredWarehouses: string[]
  sourceWarehouseName: string
  detailTotalAmount: number
  sourceTotalAmount: number | null
  costColumnsPresent: boolean
  rows: ParsedWarehouseInventoryRow[]
  warnings: WarehouseInventoryIssue[]
}

export type WarehouseInventoryCostSemantics =
  | 'UNAVAILABLE'
  | 'SOURCE_INVENTORY_AMOUNT_PARTIAL'
  | 'SOURCE_INVENTORY_AMOUNT'

export function warehouseInventoryCostSemantics(
  parsed: Pick<ParsedWarehouseInventoryWorkbook, 'costColumnsPresent' | 'rows'>,
): WarehouseInventoryCostSemantics {
  if (!parsed.costColumnsPresent) return 'UNAVAILABLE'
  return parsed.rows.some(row => row.sourceQuantity > 0 && row.inventoryAmount === 0)
    ? 'SOURCE_INVENTORY_AMOUNT_PARTIAL'
    : 'SOURCE_INVENTORY_AMOUNT'
}

export type InventoryImportProduct = ProductInventoryUnitLike & {
  id: string
  code: string
  name: string
  spec?: string | null
  status?: string | null
  supplierId?: string | null
}

export type ResolvedWarehouseInventoryRow = {
  productId: string | null
  matchSource: string | null
  inventoryUnit: string | null
  conversionFactor: number | null
  normalizedQuantity: number | null
  issues: WarehouseInventoryIssue[]
  warnings: WarehouseInventoryIssue[]
}

const MAX_SOURCE_ROWS = 1000
const MAX_STOCK_QUANTITY = 99_999_999.999
const QUANTITY_SCALE = 3

export function warehouseInventoryFileHash(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function cellText(value: ExcelJS.CellValue | undefined | null): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('richText' in value) return value.richText.map(item => item.text).join('').trim()
    if ('text' in value) return String(value.text || '').trim()
    if ('hyperlink' in value) return String((value as any).text || '').trim()
  }
  return String(value).trim()
}

function numericCell(value: ExcelJS.CellValue | undefined | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = cellText(value).replaceAll(',', '').replace(/[￥¥]/g, '')
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function optionalNumber(value: ExcelJS.CellValue | undefined | null) {
  return numericCell(value) ?? 0
}

function normalizeHeader(value: string) {
  return value.normalize('NFKC').replace(/[\s_]/g, '').replaceAll('（', '(').replaceAll('）', ')')
}

function worksheetRowValues(row: ExcelJS.Row) {
  const values: ExcelJS.CellValue[] = []
  for (let column = 1; column <= row.worksheet.columnCount; column += 1) {
    values.push(row.getCell(column).value)
  }
  return values
}

function findHeader(worksheet: ExcelJS.Worksheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount); rowNumber += 1) {
    const headers = worksheetRowValues(worksheet.getRow(rowNumber)).map(value => normalizeHeader(cellText(value)))
    if (headers.includes(normalizeHeader('物品名称')) && headers.includes(normalizeHeader('库存量'))) {
      const indexes = new Map<string, number>()
      headers.forEach((header, index) => header && indexes.set(header, index + 1))
      return { rowNumber, indexes }
    }
  }
  return null
}

function column(indexes: Map<string, number>, label: string, ...aliases: string[]) {
  for (const candidate of [label, ...aliases]) {
    const found = indexes.get(normalizeHeader(candidate))
    if (found) return found
  }
  throw new Error(`美团库存表缺少列：${label}`)
}

function optionalColumn(indexes: Map<string, number>, label: string, ...aliases: string[]) {
  for (const candidate of [label, ...aliases]) {
    const found = indexes.get(normalizeHeader(candidate))
    if (found) return found
  }
  return null
}

function round(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function decimalPlaces(value: number) {
  return new Prisma.Decimal(value).decimalPlaces()
}

export function normalizeExternalProductCode(value: unknown) {
  return String(value || '').normalize('NFKC').trim().toUpperCase()
}

export function normalizeWarehouseProductName(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^[xｘ][\-－—_\s]+/i, '')
    .replaceAll('（', '(')
    .replaceAll('）', ')')
    .replace(/\s+/g, '')
}

export async function parseMeituanWarehouseInventoryWorkbook(
  buffer: Buffer,
  sourceWarehouseName = '供应链总仓',
): Promise<ParsedWarehouseInventoryWorkbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as any)
  const worksheet = workbook.worksheets.find(sheet => Boolean(findHeader(sheet)))
  if (!worksheet) throw new Error('无法识别美团实时库存查询表表头')
  const found = findHeader(worksheet)!

  const codeColumn = optionalColumn(found.indexes, '物品编码', '商品编码')
  const nameColumn = column(found.indexes, '物品名称', '商品名称')
  const specColumn = column(found.indexes, '规格型号', '规格')
  const categoryColumn = column(found.indexes, '物品类别', '商品类别')
  const unitColumn = column(found.indexes, '单位')
  const conversionColumn = column(found.indexes, '基准单位换算率', '单位换算率')
  const warehouseColumn = column(found.indexes, '仓库')
  const quantityColumn = column(found.indexes, '库存量')
  const amountColumn = optionalColumn(found.indexes, '库存金额')
  const amountExTaxColumn = optionalColumn(found.indexes, '库存金额(不含税)')
  const taxColumn = optionalColumn(found.indexes, '库存税额')
  const averageCostColumn = optionalColumn(found.indexes, '库存均价(不含税)')
  const expectedInboundColumn = optionalColumn(found.indexes, '预计入库量')
  const expectedOutboundColumn = optionalColumn(found.indexes, '预计出库量')
  const theoreticalQuantityColumn = optionalColumn(found.indexes, '理论库存量')
  const theoreticalAmountColumn = optionalColumn(found.indexes, '理论库存金额')
  const costColumnsPresent = amountColumn != null

  const rows: ParsedWarehouseInventoryRow[] = []
  const ignoredWarehouses = new Set<string>()
  let sourceRowCount = 0
  let ignoredRowCount = 0
  let sourceTotalAmount: number | null = null

  for (let rowNumber = found.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const externalName = cellText(row.getCell(nameColumn).value)
    const sourceSpec = cellText(row.getCell(specColumn).value)
    const sourceCategory = cellText(row.getCell(categoryColumn).value)
    const purchaseUnit = cellText(row.getCell(unitColumn).value)
    const sourceCode = codeColumn == null ? '' : cellText(row.getCell(codeColumn).value)
    const externalCode = normalizeExternalProductCode(sourceCode) || `NAME-${crypto
      .createHash('sha256')
      .update(`${normalizeExternalProductCode(externalName)}|${normalizeExternalProductCode(sourceSpec)}|${normalizeExternalProductCode(purchaseUnit)}`)
      .digest('hex')
      .slice(0, 24)
      .toUpperCase()}`
    if (!externalName && !sourceCode) continue
    if (normalizeExternalProductCode(sourceCode || externalName) === '合计') {
      sourceTotalAmount = amountColumn == null ? null : numericCell(row.getCell(amountColumn).value)
      continue
    }
    sourceRowCount += 1
    if (sourceRowCount > MAX_SOURCE_ROWS) throw new Error(`库存表超过 ${MAX_SOURCE_ROWS} 条明细，不能导入`)

    const warehouse = cellText(row.getCell(warehouseColumn).value)
    if (warehouse !== sourceWarehouseName) {
      ignoredRowCount += 1
      if (warehouse) ignoredWarehouses.add(warehouse)
      continue
    }

    const sourceQuantity = numericCell(row.getCell(quantityColumn).value)
    if (sourceQuantity == null) throw new Error(`第 ${rowNumber} 行库存量不是有效数字`)
    if (sourceQuantity < 0) throw new Error(`第 ${rowNumber} 行库存量不能为负数`)
    if (decimalPlaces(sourceQuantity) > 6) throw new Error(`第 ${rowNumber} 行库存量最多支持 6 位小数`)

    const conversionText = cellText(row.getCell(conversionColumn).value)
    if (externalCode.length > 80) throw new Error(`第 ${rowNumber} 行物品编码超过 80 个字符`)
    if (externalName.length > 120) throw new Error(`第 ${rowNumber} 行物品名称超过 120 个字符`)
    if (purchaseUnit.length > 16) throw new Error(`第 ${rowNumber} 行采购单位超过 16 个字符`)
    if (sourceSpec.length > 160) throw new Error(`第 ${rowNumber} 行规格超过 160 个字符`)
    if (sourceCategory.length > 80) throw new Error(`第 ${rowNumber} 行类别超过 80 个字符`)
    if (conversionText.length > 80) throw new Error(`第 ${rowNumber} 行换算率超过 80 个字符`)
    const issues: WarehouseInventoryIssue[] = []
    const warnings: WarehouseInventoryIssue[] = []
    if (!externalName) issues.push({ code: 'SOURCE_NAME_MISSING', message: '物品名称为空' })
    if (!purchaseUnit) issues.push({ code: 'SOURCE_UNIT_MISSING', message: '采购单位为空' })

    const inventoryAmount = round(amountColumn == null ? 0 : optionalNumber(row.getCell(amountColumn).value), 2)
    const averageCostExcludingTax = round(averageCostColumn == null ? 0 : optionalNumber(row.getCell(averageCostColumn).value), 6)
    const expectedInboundQuantity = expectedInboundColumn == null ? 0 : optionalNumber(row.getCell(expectedInboundColumn).value)
    const expectedOutboundQuantity = expectedOutboundColumn == null ? 0 : optionalNumber(row.getCell(expectedOutboundColumn).value)
    const theoreticalQuantity = theoreticalQuantityColumn == null
      ? sourceQuantity
      : optionalNumber(row.getCell(theoreticalQuantityColumn).value)
    if (sourceQuantity > 0 && inventoryAmount === 0) {
      warnings.push({ code: 'COST_PENDING', message: '有库存数量但库存金额为 0，成本待补' })
    }
    if (theoreticalQuantity < 0) {
      warnings.push({ code: 'THEORETICAL_STOCK_NEGATIVE', message: '理论库存为负，仅作审计参考' })
    }
    if (theoreticalQuantityColumn != null
      && Math.abs(theoreticalQuantity - (sourceQuantity + expectedInboundQuantity - expectedOutboundQuantity)) > 0.001) {
      warnings.push({ code: 'THEORETICAL_EQUATION_MISMATCH', message: '理论库存不等于库存量＋预计入库－预计出库' })
    }

    const parsedRow: ParsedWarehouseInventoryRow = {
      rowNumber,
      externalCode,
      externalName,
      sourceSpec: sourceSpec || null,
      sourceCategory: sourceCategory || null,
      sourceWarehouseName: warehouse,
      purchaseUnit,
      conversionText: conversionText || null,
      sourceQuantity,
      inventoryAmount,
      inventoryAmountExcludingTax: round(amountExTaxColumn == null ? 0 : optionalNumber(row.getCell(amountExTaxColumn).value), 2),
      inventoryTax: round(taxColumn == null ? 0 : optionalNumber(row.getCell(taxColumn).value), 2),
      averageCostExcludingTax,
      expectedInboundQuantity,
      expectedOutboundQuantity,
      theoreticalQuantity,
      theoreticalAmount: round(theoreticalAmountColumn == null ? 0 : optionalNumber(row.getCell(theoreticalAmountColumn).value), 2),
      issues,
      warnings,
      rawData: {},
    }
    parsedRow.rawData = {
      externalCode: parsedRow.externalCode,
      externalName: parsedRow.externalName,
      sourceSpec: parsedRow.sourceSpec,
      sourceCategory: parsedRow.sourceCategory,
      sourceWarehouseName: parsedRow.sourceWarehouseName,
      purchaseUnit: parsedRow.purchaseUnit,
      conversionText: parsedRow.conversionText,
      sourceQuantity: parsedRow.sourceQuantity,
      inventoryAmount: parsedRow.inventoryAmount,
      inventoryAmountExcludingTax: parsedRow.inventoryAmountExcludingTax,
      inventoryTax: parsedRow.inventoryTax,
      averageCostExcludingTax: parsedRow.averageCostExcludingTax,
      expectedInboundQuantity: parsedRow.expectedInboundQuantity,
      expectedOutboundQuantity: parsedRow.expectedOutboundQuantity,
      theoreticalQuantity: parsedRow.theoreticalQuantity,
      theoreticalAmount: parsedRow.theoreticalAmount,
      sourceIssues: parsedRow.issues,
      sourceWarnings: parsedRow.warnings,
      sourceCodeMissing: !sourceCode,
    }
    rows.push(parsedRow)
  }

  if (rows.length === 0) throw new Error(`库存表没有仓库“${sourceWarehouseName}”的商品明细`)
  const duplicateCodes = new Set<string>()
  const seenCodes = new Set<string>()
  for (const row of rows) {
    if (seenCodes.has(row.externalCode)) duplicateCodes.add(row.externalCode)
    seenCodes.add(row.externalCode)
  }
  for (const row of rows) {
    if (duplicateCodes.has(row.externalCode)) {
      row.issues.push({ code: 'DUPLICATE_EXTERNAL_CODE', message: '同一仓库内物品编码重复' })
    }
    row.rawData.sourceIssues = row.issues
    row.rawData.sourceWarnings = row.warnings
  }

  const detailTotalAmount = round(rows.reduce((sum, row) => sum + row.inventoryAmount, 0), 2)
  const warnings: WarehouseInventoryIssue[] = []
  if (!codeColumn) {
    warnings.push({ code: 'SOURCE_CODE_COLUMN_MISSING', message: '源文件没有物品编码列，使用名称、规格和单位生成稳定临时编码，映射必须人工确认' })
  }
  if (!costColumnsPresent) {
    warnings.push({ code: 'SOURCE_COST_COLUMNS_MISSING', message: '源文件没有库存金额列，本次只建立数量基准，成本标记待补' })
  }
  if (sourceTotalAmount != null && Math.abs(sourceTotalAmount - detailTotalAmount) > 0.01) {
    warnings.push({
      code: 'SOURCE_TOTAL_MISMATCH',
      message: '美团合计金额与目标仓库明细重算金额不一致，确认时将忽略合计行',
      detail: `明细 ${detailTotalAmount.toFixed(2)}，合计行 ${sourceTotalAmount.toFixed(2)}`,
    })
  }

  const title = cellText(worksheet.getCell('A1').value) || worksheet.name
  const filterDescription = Array.from({ length: Math.max(0, found.rowNumber - 1) }, (_, index) =>
    cellText(worksheet.getRow(index + 1).getCell(1).value),
  ).filter(Boolean).join('；')

  return {
    sheetName: worksheet.name,
    title,
    filterDescription,
    sourceRowCount,
    ignoredRowCount,
    ignoredWarehouses: [...ignoredWarehouses].sort(),
    sourceWarehouseName,
    detailTotalAmount,
    sourceTotalAmount,
    costColumnsPresent,
    rows,
    warnings,
  }
}

const UNIT_ALIASES: Record<string, string> = {
  公斤: 'kg',
  千克: 'kg',
  克: 'g',
  毫升: 'ml',
  升: 'l',
}

const MASS_TO_GRAMS: Record<string, number> = { g: 1, kg: 1000, 斤: 500 }
const VOLUME_TO_ML: Record<string, number> = { ml: 1, l: 1000 }
const INDIVIDUAL_UNIT_GROUPS = [
  new Set(['个', '枚']),
  new Set(['袋', '包']),
  new Set(['盒', '瓶', '罐']),
]
const OUTER_PACKAGE_UNIT_GROUPS = [
  new Set(['箱', '件']),
  new Set(['个', '件', '台', '块', '张']),
  new Set(['袋', '包', '件']),
]

export function normalizeWarehouseUnit(value: unknown) {
  const unit = String(value || '').normalize('NFKC').trim().toLowerCase()
  return UNIT_ALIASES[unit] || unit
}

export function parseMeituanUnitConversion(value: string | null | undefined) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '')
  const match = text.match(/^(\d+(?:\.\d+)?)([^\d=]+)=(\d+(?:\.\d+)?)([^\d=]+)$/)
  if (!match) return null
  const leftQuantity = Number(match[1])
  const rightQuantity = Number(match[3])
  if (!(leftQuantity > 0) || !(rightQuantity > 0)) return null
  return {
    leftQuantity,
    leftUnit: match[2],
    rightQuantity,
    rightUnit: match[4],
  }
}

function physicalUnitFactor(sourceUnit: string, targetUnit: string) {
  const source = normalizeWarehouseUnit(sourceUnit)
  const target = normalizeWarehouseUnit(targetUnit)
  if (source === target) return 1
  if (MASS_TO_GRAMS[source] && MASS_TO_GRAMS[target]) return MASS_TO_GRAMS[source] / MASS_TO_GRAMS[target]
  if (VOLUME_TO_ML[source] && VOLUME_TO_ML[target]) return VOLUME_TO_ML[source] / VOLUME_TO_ML[target]
  return null
}

function groupedUnitFactor(sourceUnit: string, targetUnit: string, groups: Array<Set<string>>) {
  const source = normalizeWarehouseUnit(sourceUnit)
  const target = normalizeWarehouseUnit(targetUnit)
  return groups.some(group => group.has(source) && group.has(target)) ? 1 : null
}

function directSnapshotUnitFactor(sourceUnit: string, targetUnit: string) {
  return physicalUnitFactor(sourceUnit, targetUnit)
    ?? groupedUnitFactor(sourceUnit, targetUnit, OUTER_PACKAGE_UNIT_GROUPS)
}

function sourceConversionFactorInInventoryUnit(conversionText: string | null, inventoryUnit: string) {
  const parsed = parseMeituanUnitConversion(conversionText)
  if (!parsed) return null
  const rightToInventory = physicalUnitFactor(parsed.rightUnit, inventoryUnit)
    ?? groupedUnitFactor(parsed.rightUnit, inventoryUnit, INDIVIDUAL_UNIT_GROUPS)
  if (rightToInventory == null) return null
  return {
    factor: (parsed.rightQuantity * rightToInventory) / parsed.leftQuantity,
    leftUnit: parsed.leftUnit,
  }
}

/**
 * Some compact Meituan exports keep the stock unit at an inner package while
 * the system product uses a physical base unit.  In that case the explicit
 * `1袋=1袋` conversion is not enough, but the adjacent specification still
 * carries the auditable package weight, for example:
 *
 * - source unit `袋`, spec `箱/2.5kg*8袋` => 2500 g per source unit
 * - source unit `箱`, spec `箱/1.5kg*6盒` => 9000 g per source unit
 * - source unit `件`, spec `件/2500g` => 2500 g per source unit
 *
 * Keep the parser intentionally narrow.  Ambiguous or non-mass patterns must
 * remain blocked instead of being guessed.
 */
function sourceSpecMassFactor(sourceSpec: string | null, sourceUnit: string, inventoryUnit: string) {
  const target = normalizeWarehouseUnit(inventoryUnit)
  const source = normalizeWarehouseUnit(sourceUnit)
  const text = String(sourceSpec || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  if (!text) return null

  const outerMatch = text.match(/^([^/]+)\/(\d+(?:\.\d+)?)(kg|g|斤)(?:\*(\d+(?:\.\d+)?)([^/*]+))?$/)
  if (!outerMatch) return null
  const outerUnit = normalizeWarehouseUnit(outerMatch[1])
  const massQuantity = Number(outerMatch[2])
  const massUnit = normalizeWarehouseUnit(outerMatch[3])
  const innerCount = outerMatch[4] ? Number(outerMatch[4]) : 1
  const innerUnit = outerMatch[5] ? normalizeWarehouseUnit(outerMatch[5]) : null
  if (!(massQuantity > 0) || !(innerCount > 0) || !MASS_TO_GRAMS[massUnit]) return null

  let massPerSourceInGrams: number | null = null
  if (source === outerUnit) {
    massPerSourceInGrams = massQuantity * MASS_TO_GRAMS[massUnit] * innerCount
  } else if (innerUnit && (source === innerUnit || groupedUnitFactor(source, innerUnit, INDIVIDUAL_UNIT_GROUPS) === 1)) {
    massPerSourceInGrams = massQuantity * MASS_TO_GRAMS[massUnit]
  }
  if (massPerSourceInGrams != null && MASS_TO_GRAMS[target]) {
    return massPerSourceInGrams / MASS_TO_GRAMS[target]
  }

  // The source may already be a physical mass while the existing product
  // contract stores one outer package (for example 1 件竹荪 = 1 kg).
  // Convert only when the specification names that exact outer package.
  if (MASS_TO_GRAMS[source]
    && groupedUnitFactor(outerUnit, target, OUTER_PACKAGE_UNIT_GROUPS) === 1) {
    const gramsPerOuter = massQuantity * MASS_TO_GRAMS[massUnit] * innerCount
    const gramsPerSource = MASS_TO_GRAMS[source]
    return gramsPerSource / gramsPerOuter
  }
  return null
}

function quantitiesEqual(left: number, right: number, tolerance = 0.000001) {
  return Math.abs(left - right) <= tolerance
}

export function resolveWarehouseInventoryRow(
  row: ParsedWarehouseInventoryRow,
  product: InventoryImportProduct | null,
  matchSource: string | null,
): ResolvedWarehouseInventoryRow {
  const issues = [...row.issues]
  const warnings = [...row.warnings]
  if (!product) {
    issues.push({ code: 'SKU_UNMATCHED', message: '美团编码尚未匹配系统商品' })
    return {
      productId: null,
      matchSource: null,
      inventoryUnit: null,
      conversionFactor: null,
      normalizedQuantity: null,
      issues,
      warnings,
    }
  }

  if (matchSource === 'NAME_SUGGESTION') {
    issues.push({ code: 'EXTERNAL_CODE_REVIEW_REQUIRED', message: '名称相同仅作为候选，请人工确认美团编码映射' })
  }
  if (product.status && product.status !== 'ENABLED') {
    issues.push({ code: 'PRODUCT_NOT_ENABLED', message: '匹配商品未启用' })
  }
  // The internal warehouse ledger belongs to the tenant/warehouse/product
  // scope. An upstream purchasing supplier is optional master data and must
  // not block a physical stock baseline. The retired Product.stock writer did
  // require supplierId because it emitted supplier-stock movements; the
  // independent warehouse ledger does not.
  if (normalizeExternalProductCode(product.name) !== normalizeExternalProductCode(row.externalName)) {
    warnings.push({
      code: 'SOURCE_NAME_DIFFERS',
      message: '美团名称与系统商品名称不同，按已确认编码映射处理',
      detail: `${row.externalName} → ${product.name}`,
    })
  }

  const unit = resolveProductInventoryUnit(product)
  const sourceConversion = sourceConversionFactorInInventoryUnit(row.conversionText, unit.inventoryUnit)
  const sourcePurchaseMatches = normalizeWarehouseUnit(row.purchaseUnit) === normalizeWarehouseUnit(unit.purchaseUnit)
  const sourceConversionUsable = sourceConversion
    && normalizeWarehouseUnit(sourceConversion.leftUnit) === normalizeWarehouseUnit(row.purchaseUnit)
  const directSnapshotFactor = directSnapshotUnitFactor(row.purchaseUnit, unit.inventoryUnit)
  const sourceSpecFactor = sourceSpecMassFactor(row.sourceSpec, row.purchaseUnit, unit.inventoryUnit)
  const snapshotFactor = sourceConversionUsable
    ? sourceConversion.factor
    : directSnapshotFactor ?? sourceSpecFactor
  const snapshotEvidenceUsable = snapshotFactor != null

  if (!unit.structured && !snapshotEvidenceUsable) {
    issues.push({ code: 'UNIT_CONVERSION_NOT_VERIFIED', message: '商品采购单位到库存单位的换算尚未验证' })
  } else if (unit.status !== 'VERIFIED' && !snapshotEvidenceUsable) {
    issues.push({ code: 'UNIT_CONVERSION_NOT_VERIFIED', message: '商品采购单位到库存单位的换算尚未验证' })
  } else if (unit.status !== 'VERIFIED' && snapshotEvidenceUsable) {
    warnings.push({ code: 'UNIT_CONFIRMED_BY_SOURCE_SNAPSHOT', message: '本次基准按源文件换算率折算，商品主数据仍待正式核验' })
  }
  if (!sourcePurchaseMatches && !snapshotEvidenceUsable) {
    issues.push({
      code: 'PURCHASE_UNIT_MISMATCH',
      message: '美团采购单位与系统采购单位不一致，且源换算率无法折算到系统库存单位',
      detail: `${row.purchaseUnit} ≠ ${unit.purchaseUnit}`,
    })
  }

  if (row.conversionText && !sourceConversion) {
    warnings.push({
      code: 'SOURCE_CONVERSION_NOT_COMPARABLE',
      message: '美团换算率无法直接换算到系统库存单位，保留原文供复核',
      detail: row.conversionText,
    })
  } else if (sourceConversion) {
    if (normalizeWarehouseUnit(sourceConversion.leftUnit) !== normalizeWarehouseUnit(row.purchaseUnit)) {
      issues.push({ code: 'SOURCE_CONVERSION_UNIT_MISMATCH', message: '美团换算率左侧单位与采购单位不一致' })
    } else if (sourcePurchaseMatches && !quantitiesEqual(sourceConversion.factor, unit.inventoryUnitsPerPurchaseUnit)) {
      warnings.push({
        code: 'UNIT_CONVERSION_MISMATCH',
        message: '本次快照换算率与系统商品主数据不一致，基准按源文件折算并保留差异',
        detail: `源文件 ${sourceConversion.factor}，系统 ${unit.inventoryUnitsPerPurchaseUnit}`,
      })
    }
  }

  if (!sourceConversionUsable && sourceSpecFactor != null) {
    warnings.push({
      code: 'UNIT_CONFIRMED_BY_SOURCE_SPEC',
      message: '本次基准按源文件规格中的包装重量折算',
      detail: row.sourceSpec || undefined,
    })
  } else if (!sourceConversionUsable && directSnapshotFactor != null && !sourcePurchaseMatches) {
    warnings.push({
      code: 'SOURCE_UNIT_ALIAS_USED',
      message: '源文件与系统的包装单位名称不同，本次基准按 1:1 容器/件数折算',
      detail: `${row.purchaseUnit} → ${unit.inventoryUnit}`,
    })
  }

  const conversionFactor = snapshotFactor ?? unit.inventoryUnitsPerPurchaseUnit
  const normalized = new Prisma.Decimal(row.sourceQuantity)
    .mul(conversionFactor)
  let normalizedQuantity: number | null = Number(normalized)
  if (normalized.greaterThan(MAX_STOCK_QUANTITY)) {
    issues.push({ code: 'NORMALIZED_QUANTITY_TOO_LARGE', message: '换算后库存量超过系统上限' })
    normalizedQuantity = null
  } else if (normalized.decimalPlaces() > QUANTITY_SCALE) {
    issues.push({
      code: 'NORMALIZED_PRECISION_EXCEEDED',
      message: '换算后库存量超过 3 位小数，禁止静默舍入',
      detail: normalized.toString(),
    })
    normalizedQuantity = null
  }

  return {
    productId: product.id,
    matchSource,
    inventoryUnit: unit.inventoryUnit,
    conversionFactor,
    normalizedQuantity,
    issues,
    warnings,
  }
}
