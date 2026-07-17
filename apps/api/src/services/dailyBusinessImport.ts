import crypto from 'node:crypto'
import ExcelJS from 'exceljs'

export type ImportIssue = {
  code: string
  message: string
  detail?: string
}

const DEFERRABLE_BOM_ISSUES = new Set(['DISH_UNMATCHED', 'BOM_MISSING'])

export function partitionImportIssues(issues: ImportIssue[]) {
  return {
    deferrable: issues.filter(issue => DEFERRABLE_BOM_ISSUES.has(issue.code)),
    hard: issues.filter(issue => !DEFERRABLE_BOM_ISSUES.has(issue.code)),
  }
}

export function calculateDeferredBomConsumptions(
  saleQuantity: number,
  recipes: Array<{ productId: string; quantity: unknown; lossRate: unknown }>,
) {
  const byProduct = new Map<string, number>()
  for (const recipe of recipes) {
    const quantity = saleQuantity * Number(recipe.quantity) * (1 + Number(recipe.lossRate))
    if (quantity > 0) byProduct.set(recipe.productId, (byProduct.get(recipe.productId) || 0) + quantity)
  }
  return [...byProduct.entries()]
    .map(([productId, quantity]) => ({ productId, quantity: Math.round((quantity + Number.EPSILON) * 1_000_000) / 1_000_000 }))
    .sort((left, right) => left.productId.localeCompare(right.productId))
}

export type BusinessMetrics = {
  date: string
  storeName: string
  grossAmount: number
  discountAmount: number
  netRevenue: number
  orders: number
  diners: number
  tables: number
}

export type PosDishVariant = {
  date: string
  name: string
  spec: string
  externalCodes: string[]
  unit: string
  category: string
  subcategory: string
  quantity: number
  grossAmount: number
  discountAmount: number
  netIncome: number
  lineCount: number
  uniqueOrders: number
}

export type ParsedDailyFiles = {
  business: BusinessMetrics
  sales: PosDishVariant[]
  returns: PosDishVariant[]
  salesStoreNames: string[]
  returnStoreNames: string[]
  totals: {
    quantity: number
    grossAmount: number
    discountAmount: number
    netIncome: number
  }
  blockingIssues: ImportIssue[]
  warningIssues: ImportIssue[]
}

export function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function normalizeDishName(value: string) {
  return value.normalize('NFKC').replace(/[\s·•・|（）()【】\-/]+/g, '').trim().toLowerCase()
}

export function normalizeVariantKey(value: string | null | undefined) {
  return normalizeDishName(String(value || ''))
}

function storeIdentity(value: string) {
  return normalizeDishName(value)
    .replaceAll('南京云洱之境餐饮集团', '')
    .replaceAll('云洱之境餐饮集团', '')
    .replaceAll('云南山珍菌汤锅', '')
    .replaceAll('滇界', '')
    .replaceAll('门店', '')
    .replaceAll('店', '')
}

export function storeNameMatches(targetStoreName: string, sourceStoreName: string) {
  const target = storeIdentity(targetStoreName)
  const source = storeIdentity(sourceStoreName)
  if (!target || !source) return false
  if (target.includes(source) || source.includes(target)) return true
  let longest = 0
  for (let left = 0; left < target.length; left += 1) {
    for (let right = 0; right < source.length; right += 1) {
      let length = 0
      while (target[left + length] && target[left + length] === source[right + length]) length += 1
      longest = Math.max(longest, length)
    }
  }
  return longest >= 2
}

function round(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function text(value: ExcelJS.CellValue | undefined | null): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('result' in value) return text(value.result as ExcelJS.CellValue)
    if ('richText' in value) return value.richText.map(item => item.text).join('')
    if ('text' in value) return String(value.text || '')
    if ('hyperlink' in value) return String((value as any).text || '')
  }
  return String(value).trim()
}

function numberValue(value: ExcelJS.CellValue | undefined | null): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = Number(text(value).replaceAll(',', '').replace(/[￥¥]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeHeader(value: string) {
  return value.normalize('NFKC').replace(/[\s_]/g, '').replaceAll('（', '(').replaceAll('）', ')')
}

function dateString(value: ExcelJS.CellValue | string | undefined | null): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  const raw = text(value as ExcelJS.CellValue)
  const match = raw.match(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
}

function rowValues(row: ExcelJS.Row) {
  const values: ExcelJS.CellValue[] = []
  for (let column = 1; column <= row.worksheet.columnCount; column += 1) values.push(row.getCell(column).value)
  return values
}

function findHeader(worksheet: ExcelJS.Worksheet, required: string[]) {
  for (let rowNumber = 1; rowNumber <= Math.min(15, worksheet.rowCount); rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const headers = rowValues(row).map(value => normalizeHeader(text(value)))
    if (required.every(name => headers.includes(normalizeHeader(name)))) {
      const indexes = new Map<string, number>()
      headers.forEach((header, index) => header && indexes.set(header, index + 1))
      return { rowNumber, indexes }
    }
  }
  return null
}

function headerColumn(indexes: Map<string, number>, ...aliases: string[]) {
  for (const alias of aliases) {
    const result = indexes.get(normalizeHeader(alias))
    if (result) return result
  }
  return null
}

function requiredColumn(indexes: Map<string, number>, label: string, ...aliases: string[]) {
  const column = headerColumn(indexes, label, ...aliases)
  if (!column) throw new Error(`表格缺少列：${label}`)
  return column
}

export async function parseBusinessWorkbook(buffer: Buffer): Promise<BusinessMetrics> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as any)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('综合营业统计没有工作表')
  const found = findHeader(worksheet, ['营业日', '营业额(元)'])
    || findHeader(worksheet, ['营业日期', '营业额(元)'])
  if (!found) throw new Error('无法识别综合营业统计表头')

  const dateColumn = requiredColumn(found.indexes, '营业日', '营业日期')
  const storeColumn = requiredColumn(found.indexes, '门店')
  const grossColumn = requiredColumn(found.indexes, '营业额(元)')
  const discountColumn = requiredColumn(found.indexes, '优惠金额(元)')
  const netColumn = requiredColumn(found.indexes, '营业收入(元)')
  const ordersColumn = requiredColumn(found.indexes, '订单量')
  const dinersColumn = headerColumn(found.indexes, '用餐人数')
  const tablesColumn = headerColumn(found.indexes, '消费桌数')

  const rows: BusinessMetrics[] = []
  for (let rowNumber = found.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const date = dateString(row.getCell(dateColumn).value)
    if (!date || text(row.getCell(1).value) === '合计') continue
    const storeName = text(row.getCell(storeColumn).value)
    if (!storeName) throw new Error(`综合营业统计第 ${rowNumber} 行缺少门店名称`)
    const metrics = {
      date,
      storeName,
      grossAmount: round(numberValue(row.getCell(grossColumn).value), 2),
      discountAmount: round(numberValue(row.getCell(discountColumn).value), 2),
      netRevenue: round(numberValue(row.getCell(netColumn).value), 2),
      orders: Math.round(numberValue(row.getCell(ordersColumn).value)),
      diners: dinersColumn ? Math.round(numberValue(row.getCell(dinersColumn).value)) : 0,
      tables: tablesColumn ? Math.round(numberValue(row.getCell(tablesColumn).value)) : 0,
    }
    if (metrics.grossAmount < 0 || metrics.discountAmount < 0 || metrics.netRevenue < 0 || metrics.orders < 0) {
      throw new Error(`综合营业统计第 ${rowNumber} 行包含负数，不能导入`)
    }
    rows.push(metrics)
  }
  if (rows.length === 0) throw new Error('综合营业统计没有可导入的数据行')
  if (rows.length > 1) throw new Error('综合营业统计包含多个门店或多个营业日，请只导出单店单日数据')
  return rows[0]
}

function parseDishWorksheet(worksheet: ExcelJS.Worksheet) {
  const found = findHeader(worksheet, ['菜品名称', '销售数量'])
    || findHeader(worksheet, ['菜品名称', '菜品销量'])
  if (!found) throw new Error(`工作表“${worksheet.name}”无法识别菜品销售表头`)
  const nameColumn = requiredColumn(found.indexes, '菜品名称')
  const storeColumn = headerColumn(found.indexes, '门店', '门店名称')
  const dateColumn = headerColumn(found.indexes, '营业日期', '营业日', '日期')
  const specColumn = headerColumn(found.indexes, '规格')
  const codeColumn = headerColumn(found.indexes, '菜品编码', '商品编码')
  const unitColumn = headerColumn(found.indexes, '单位')
  const categoryColumn = headerColumn(found.indexes, '菜品大类', '大类')
  const subcategoryColumn = headerColumn(found.indexes, '菜品小类', '小类')
  const quantityColumn = requiredColumn(found.indexes, '销售数量', '菜品销量')
  const grossColumn = requiredColumn(found.indexes, '销售额(元)', '销售额')
  const discountColumn = headerColumn(found.indexes, '菜品优惠(元)', '优惠金额(元)', '优惠金额')
  const netColumn = headerColumn(found.indexes, '菜品收入(元)', '营业收入(元)', '菜品收入')
  const orderColumn = headerColumn(found.indexes, '订单编号', '订单号')
  const metadataDate = (() => {
    for (let rowNumber = 1; rowNumber < found.rowNumber; rowNumber += 1) {
      for (const value of rowValues(worksheet.getRow(rowNumber))) {
        const parsed = dateString(value)
        if (parsed) return parsed
      }
    }
    return null
  })()

  const grouped = new Map<string, PosDishVariant & { codes: Set<string>; orders: Set<string> }>()
  const storeNames = new Set<string>()
  for (let rowNumber = found.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const name = text(row.getCell(nameColumn).value)
    if (!name || name === '合计') continue
    const storeName = storeColumn ? text(row.getCell(storeColumn).value) : ''
    if (storeName) storeNames.add(storeName)
    const date = (dateColumn ? dateString(row.getCell(dateColumn).value) : null) || metadataDate
    if (!date) throw new Error(`工作表“${worksheet.name}”第 ${rowNumber} 行无法识别营业日期`)
    const spec = specColumn ? text(row.getCell(specColumn).value) : ''
    const key = `${date}\u0000${name}\u0000${spec}`
    const current = grouped.get(key) || {
      date, name, spec,
      externalCodes: [], codes: new Set<string>(),
      unit: unitColumn ? text(row.getCell(unitColumn).value) || '份' : '份',
      category: categoryColumn ? text(row.getCell(categoryColumn).value) : '',
      subcategory: subcategoryColumn ? text(row.getCell(subcategoryColumn).value) : '',
      quantity: 0, grossAmount: 0, discountAmount: 0, netIncome: 0,
      lineCount: 0, uniqueOrders: 0, orders: new Set<string>(),
    }
    const code = codeColumn ? text(row.getCell(codeColumn).value).replace(/\.0$/, '') : ''
    if (code) current.codes.add(code)
    const order = orderColumn ? text(row.getCell(orderColumn).value) : ''
    if (order) current.orders.add(order)
    current.quantity += numberValue(row.getCell(quantityColumn).value)
    current.grossAmount += numberValue(row.getCell(grossColumn).value)
    current.discountAmount += discountColumn ? numberValue(row.getCell(discountColumn).value) : 0
    current.netIncome += netColumn ? numberValue(row.getCell(netColumn).value) : 0
    current.lineCount += 1
    grouped.set(key, current)
  }
  const rows = [...grouped.values()].map(({ codes, orders, ...row }) => ({
    ...row,
    externalCodes: [...codes].sort(),
    uniqueOrders: orders.size,
    quantity: round(row.quantity, 4),
    grossAmount: round(row.grossAmount, 2),
    discountAmount: round(row.discountAmount, 2),
    netIncome: round(netColumn ? row.netIncome : (row.grossAmount - row.discountAmount), 2),
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.spec.localeCompare(b.spec, 'zh-CN'))
  return { rows, storeNames: [...storeNames].sort((a, b) => a.localeCompare(b, 'zh-CN')) }
}

export async function parseSalesWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as any)
  const soldSheet = workbook.getWorksheet('已销售') || workbook.worksheets.find(sheet => findHeader(sheet, ['菜品名称', '销售数量']))
  if (!soldSheet) throw new Error('菜品销售文件缺少“已销售”工作表')
  const returnSheet = workbook.getWorksheet('退菜')
  const sold = parseDishWorksheet(soldSheet)
  const returned = returnSheet ? parseDishWorksheet(returnSheet) : { rows: [], storeNames: [] }
  return { sales: sold.rows, returns: returned.rows, salesStoreNames: sold.storeNames, returnStoreNames: returned.storeNames }
}

export async function parseDailyFiles(businessBuffer: Buffer, salesBuffer: Buffer): Promise<ParsedDailyFiles> {
  const [business, parsedSales] = await Promise.all([
    parseBusinessWorkbook(businessBuffer),
    parseSalesWorkbook(salesBuffer),
  ])
  const salesDates = [...new Set(parsedSales.sales.map(row => row.date))]
  const totals = parsedSales.sales.reduce((result, row) => ({
    quantity: result.quantity + row.quantity,
    grossAmount: result.grossAmount + row.grossAmount,
    discountAmount: result.discountAmount + row.discountAmount,
    netIncome: result.netIncome + row.netIncome,
  }), { quantity: 0, grossAmount: 0, discountAmount: 0, netIncome: 0 })
  Object.keys(totals).forEach(key => { (totals as any)[key] = round((totals as any)[key], key === 'quantity' ? 4 : 2) })

  const blockingIssues: ImportIssue[] = []
  const warningIssues: ImportIssue[] = []
  if (salesDates.length !== 1 || salesDates[0] !== business.date) {
    blockingIssues.push({
      code: 'DATE_MISMATCH', message: '两份文件的营业日期不一致',
      detail: `综合营业：${business.date}；菜品销售：${salesDates.join('、') || '未识别'}`,
    })
  }
  if (parsedSales.salesStoreNames.length !== 1) {
    blockingIssues.push({
      code: 'SALES_STORE_INVALID',
      message: parsedSales.salesStoreNames.length === 0 ? '菜品销售文件无法识别门店' : '菜品销售文件包含多个门店',
      detail: parsedSales.salesStoreNames.join('、') || '请重新导出包含门店列的单店单日报表',
    })
  } else if (normalizeDishName(parsedSales.salesStoreNames[0]) !== normalizeDishName(business.storeName)) {
    blockingIssues.push({
      code: 'FILE_STORE_MISMATCH',
      message: '两份文件的门店不一致',
      detail: `综合营业：${business.storeName}；菜品销售：${parsedSales.salesStoreNames[0]}`,
    })
  }
  const mismatchedReturnStores = parsedSales.returnStoreNames.filter(
    name => normalizeDishName(name) !== normalizeDishName(business.storeName),
  )
  if (mismatchedReturnStores.length > 0) {
    blockingIssues.push({
      code: 'RETURN_STORE_MISMATCH',
      message: '退菜工作表包含其他门店数据',
      detail: mismatchedReturnStores.join('、'),
    })
  }
  const checks: Array<[string, string, number, number]> = [
    ['GROSS_MISMATCH', '营业额', totals.grossAmount, business.grossAmount],
    ['DISCOUNT_MISMATCH', '优惠金额', totals.discountAmount, business.discountAmount],
    ['NET_MISMATCH', '营业收入', totals.netIncome, business.netRevenue],
  ]
  for (const [code, label, salesValue, businessValue] of checks) {
    if (Math.abs(salesValue - businessValue) > 0.05) {
      blockingIssues.push({
        code, message: `${label}勾稽不一致`,
        detail: `菜品合计 ¥${salesValue.toFixed(2)}；综合营业 ¥${businessValue.toFixed(2)}`,
      })
    }
  }
  if (parsedSales.sales.length === 0) blockingIssues.push({ code: 'NO_SALES', message: '菜品销售文件没有销售数据' })
  if (parsedSales.returns.length > 0) {
    warningIssues.push({
      code: 'RETURNS_NOT_RESTOCKED', message: `检测到 ${parsedSales.returns.length} 个退菜品项，按已确认规则不补回库存`,
    })
  }
  return {
    business,
    sales: parsedSales.sales,
    returns: parsedSales.returns,
    salesStoreNames: parsedSales.salesStoreNames,
    returnStoreNames: parsedSales.returnStoreNames,
    totals,
    blockingIssues,
    warningIssues,
  }
}
