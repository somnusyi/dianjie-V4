import ExcelJS from 'exceljs'
import SevenZip from '7z-wasm'

export type SupplyChainPackageIssue = {
  code: string
  message: string
  detail?: string
}

export type SupplyChainDailyPackageSummary = {
  packageDate: string
  sourceSnapshotAt: string | null
  sourceFiles: {
    inventory: string
    movements: string
    purchasing: string
  }
  inventory: {
    rowCount: number
    positiveCount: number
    zeroCount: number
    theoreticalNegativeCount: number
    amount: number
    theoreticalAmount: number
  }
  movements: {
    rowCount: number
    documentCount: number
    storeCount: number
    skuCount: number
    outboundQuantity: number
    costAmount: number
    settlementAmount: number
    grossProfit: number
    grossMargin: number | null
    zeroCostLineCount: number
    splitDocumentSkuCount: number
  }
  purchasing: {
    rowCount: number
    supplierCount: number
    skuCount: number
    receivedQuantity: number
    receivedAmount: number
    returnedQuantity: number
    returnedAmount: number
    receivedWithoutPurchaseCount: number
  }
  ledger: {
    inbound: SupplyChainDailyInboundLine[]
    outbound: SupplyChainDailyOutboundLine[]
  }
  issues: SupplyChainPackageIssue[]
}

export type SupplyChainDailyInboundLine = {
  externalCode: string
  externalName: string
  sourceUnit: string
  sourceSpec: string | null
  quantity: number
  amount: number
  suppliers: string[]
}

export type SupplyChainDailyOutboundLine = {
  externalCode: string
  externalName: string
  sourceUnit: string
  baseUnit: string
  sourceSpec: string | null
  quantity: number
  baseQuantity: number
  costAmount: number
  settlementAmount: number
  documents: string[]
  stores: string[]
  // 对方门店（单行单一门店）：已切入 V4 订货的门店由系统发货链路记出库，
  // 美团包按此字段跳过这些行，防止同一批货双记。
  store: string
  effectiveAt: string | null
}

export type ExtractedSupplyChainDailyPackage = {
  inventoryFilename: string
  inventoryBuffer: Buffer
  summary: SupplyChainDailyPackageSummary
}

const MAX_ARCHIVE_FILES = 8
const MAX_EXTRACTED_FILE_BYTES = 8 * 1024 * 1024
const MAX_EXTRACTED_TOTAL_BYTES = 20 * 1024 * 1024

function cellText(value: ExcelJS.CellValue | undefined | null): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue)
    if ('richText' in value) return value.richText.map(item => item.text).join('').trim()
    if ('text' in value) return String(value.text || '').trim()
  }
  return String(value).trim()
}

function numberCell(value: ExcelJS.CellValue | undefined | null) {
  const raw = cellText(value).replaceAll(',', '').replace(/[￥¥%]/g, '')
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function dateAndTimeFromFilename(filename: string) {
  const match = filename.match(/_(20\d{6})_(\d{4})(?:_|\.)/)
  if (!match) return { date: null, timestamp: null }
  const rawDate = match[1]
  const rawTime = match[2]
  const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
  const timestamp = `${date}T${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}:00+08:00`
  return { date, timestamp }
}

/**
 * 出入库明细表的列位置不固定。
 *
 * 实测:同一个报表，导出条件选「出入库类型=全部」时是 58 列(入库组 + 出库组 +
 * 成本/结算/毛利)，选「配送发货出库」时只有 27 列，出库数量从第 41/42 列挪到
 * 第 26/27 列。此前代码写死列号，喂窄版文件进去会把出库数量全部读成 0——
 * 而类型判断仍然通过，于是静默算出「今天没有出库」。
 *
 * 表头是两行:上面一行是分组(入库/出库)，下面一行是列名。「数量（基准单位）」
 * 在两个分组下各出现一次，所以映射必须带分组，不能只按列名。
 */
function movementColumns(sheet: ExcelJS.Worksheet, groupHeaderRow: number, detailHeaderRow: number) {
  const byKey = new Map<string, number>()
  let currentGroup = ''
  for (let index = 1; index <= sheet.columnCount; index += 1) {
    const group = cellText(sheet.getRow(groupHeaderRow).getCell(index).value)
    const label = cellText(sheet.getRow(detailHeaderRow).getCell(index).value)
    // 合并单元格只在首列有值，向右沿用上一个分组名。
    if (group) currentGroup = group
    if (!label) continue
    // 未分组的列在两行里写的是同一个名字。
    const key = currentGroup && currentGroup !== label ? `${currentGroup}:${label}` : label
    if (!byKey.has(key)) byKey.set(key, index)
  }
  const required = (key: string) => {
    const found = byKey.get(key)
    if (!found) throw Object.assign(new Error(`出入库明细表缺少列：${key}`), { statusCode: 400 })
    return found
  }
  return {
    code: required('物品编码'),
    name: required('物品名称'),
    spec: byKey.get('规格型号') ?? null,
    baseUnit: required('基准单位'),
    sourceUnit: required('单位'),
    documentNo: required('出入库单号'),
    type: required('出入库类型'),
    counterparty: byKey.get('对方机构') ?? null,
    documentDate: byKey.get('出入库单据日期') ?? null,
    auditedAt: byKey.get('出入库单据审核时间') ?? byKey.get('审核时间') ?? null,
    outboundBaseQuantity: required('出库:数量（基准单位）'),
    outboundQuantity: required('出库:数量'),
    // 成本/结算/毛利只在宽版导出里有；窄版取不到就按 0 计，不再按列号猜。
    outboundCost: byKey.get('出库:成本金额(含税)') ?? byKey.get('出库:成本金额（含税）') ?? null,
    outboundSettlement: byKey.get('出库:结算金额(含税)') ?? byKey.get('出库:结算金额（含税）') ?? null,
    outboundGrossProfit: byKey.get('出库:毛利') ?? byKey.get('出库:毛利额') ?? null,
  }
}

/**
 * 只有「配送发货出库」计入出库台账。入库走采购汇总表，其余类型(库存调整、
 * 调拨等)不参与记账但要报出来，而完全没见过的类型必须阻断整批——静默忽略
 * 一个新类型，等于让总仓账面凭空少掉一批货。
 */
const OUTBOUND_MOVEMENT_TYPES = new Set(['配送发货出库'])
const KNOWN_NON_OUTBOUND_TYPES = new Set(['采购入库', '其他入库', '采购退货出库', '调拨入库', '调拨出库'])

function classifyWorkbook(filename: string) {
  if (filename.includes('实时库存查询表')) return 'inventory' as const
  if (filename.includes('出入库明细表')) return 'movements' as const
  if (filename.includes('采购汇总表')) return 'purchasing' as const
  return null
}

function collectFiles(module: Awaited<ReturnType<typeof SevenZip>>, directory: string): string[] {
  const files: string[] = []
  for (const name of module.FS.readdir(directory)) {
    if (name === '.' || name === '..') continue
    const fullPath = `${directory}/${name}`
    const stat = module.FS.stat(fullPath)
    if (module.FS.isDir(stat.mode)) files.push(...collectFiles(module, fullPath))
    else if (module.FS.isFile(stat.mode)) files.push(fullPath)
  }
  return files
}

async function extractArchive(buffer: Buffer) {
  const output: string[] = []
  const errors: string[] = []
  const sevenZip = await SevenZip({
    print: line => output.push(String(line)),
    printErr: line => errors.push(String(line)),
  })
  sevenZip.FS.writeFile('daily.7z', buffer)
  try {
    sevenZip.callMain(['l', '-slt', 'daily.7z'])
    const declaredSizes = output
      .map(line => line.match(/^Size = (\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
    if (declaredSizes.some(size => size > MAX_EXTRACTED_FILE_BYTES)
      || declaredSizes.reduce((sum, size) => sum + size, 0) > MAX_EXTRACTED_TOTAL_BYTES) {
      throw Object.assign(new Error('压缩包声明的解压大小超过安全限制'), { statusCode: 400 })
    }
    output.length = 0
    sevenZip.callMain(['x', 'daily.7z', '-odaily', '-y'])
  } catch (error) {
    if ((error as any)?.statusCode) throw error
    const detail = [...errors, ...output].slice(-5).join('；')
    throw Object.assign(new Error(`无法解压每日供应链数据包${detail ? `：${detail}` : ''}`), { statusCode: 400, cause: error })
  }
  const paths = collectFiles(sevenZip, 'daily')
  if (paths.length === 0) throw Object.assign(new Error('压缩包内没有文件'), { statusCode: 400 })
  if (paths.length > MAX_ARCHIVE_FILES) throw Object.assign(new Error(`压缩包文件过多，最多允许 ${MAX_ARCHIVE_FILES} 个文件`), { statusCode: 400 })
  let totalSize = 0
  const files = paths.map(filePath => {
    const bytes = sevenZip.FS.readFile(filePath)
    if (bytes.byteLength > MAX_EXTRACTED_FILE_BYTES) {
      throw Object.assign(new Error(`压缩包内文件 ${filePath.split('/').pop()} 超过 8MB`), { statusCode: 400 })
    }
    totalSize += bytes.byteLength
    return { filename: filePath.split('/').pop() || filePath, buffer: Buffer.from(bytes) }
  })
  if (totalSize > MAX_EXTRACTED_TOTAL_BYTES) throw Object.assign(new Error('压缩包解压后总大小不能超过 20MB'), { statusCode: 400 })
  return files
}

async function workbook(buffer: Buffer) {
  const result = new ExcelJS.Workbook()
  await result.xlsx.load(buffer as any)
  return result
}

function findRow(sheet: ExcelJS.Worksheet, required: string[], maxRows = 20) {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, maxRows); rowNumber += 1) {
    const values = Array.from({ length: sheet.columnCount }, (_, index) => cellText(sheet.getRow(rowNumber).getCell(index + 1).value))
    if (required.every(label => values.includes(label))) return rowNumber
  }
  return null
}

async function summarizeInventory(buffer: Buffer) {
  const book = await workbook(buffer)
  const sheet = book.worksheets.find(candidate => findRow(candidate, ['物品编码', '物品名称', '库存量']))
  if (!sheet) throw Object.assign(new Error('库存文件缺少可识别的明细表'), { statusCode: 400 })
  const headerRow = findRow(sheet, ['物品编码', '物品名称', '库存量'])!
  const headers = Array.from({ length: sheet.columnCount }, (_, index) => cellText(sheet.getRow(headerRow).getCell(index + 1).value))
  const index = (label: string) => headers.indexOf(label) + 1
  let rowCount = 0
  let positiveCount = 0
  let zeroCount = 0
  let theoreticalNegativeCount = 0
  let amount = 0
  let theoreticalAmount = 0
  const codes = new Set<string>()
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const code = cellText(row.getCell(index('物品编码')).value)
    const name = cellText(row.getCell(index('物品名称')).value)
    if ((!code && !name) || code === '合计' || name === '合计') continue
    rowCount += 1
    if (code) codes.add(code.toUpperCase())
    const quantity = numberCell(row.getCell(index('库存量')).value)
    if (quantity > 0) positiveCount += 1
    else zeroCount += 1
    const theoreticalQuantityColumn = index('理论库存量')
    if (theoreticalQuantityColumn > 0 && numberCell(row.getCell(theoreticalQuantityColumn).value) < 0) theoreticalNegativeCount += 1
    const amountColumn = index('库存金额')
    const theoreticalAmountColumn = index('理论库存金额')
    if (amountColumn > 0) amount += numberCell(row.getCell(amountColumn).value)
    if (theoreticalAmountColumn > 0) theoreticalAmount += numberCell(row.getCell(theoreticalAmountColumn).value)
  }
  return {
    summary: { rowCount, positiveCount, zeroCount, theoreticalNegativeCount, amount: round(amount), theoreticalAmount: round(theoreticalAmount) },
    codes,
  }
}

async function summarizeMovements(buffer: Buffer) {
  const book = await workbook(buffer)
  const sheet = book.worksheets.find(candidate => findRow(candidate, ['物品编码', '出入库单号', '出入库类型']))
  if (!sheet) throw Object.assign(new Error('出入库文件缺少可识别的明细表'), { statusCode: 400 })
  const groupHeaderRow = findRow(sheet, ['物品编码', '出入库单号', '出入库类型'])!
  const detailHeaderRow = groupHeaderRow + 1
  const columns = movementColumns(sheet, groupHeaderRow, detailHeaderRow)
  const skippedTypes = new Map<string, number>()
  const unknownTypes = new Map<string, number>()
  const documents = new Set<string>()
  const stores = new Set<string>()
  const skus = new Set<string>()
  const documentSkus = new Map<string, number>()
  let rowCount = 0
  let outboundQuantity = 0
  let costAmount = 0
  let settlementAmount = 0
  let grossProfit = 0
  let zeroCostLineCount = 0
  const ledger = new Map<string, {
    externalCode: string
    externalName: string
    sourceUnit: string
    baseUnit: string
    sourceSpec: string | null
    quantity: number
    baseQuantity: number
    costAmount: number
    settlementAmount: number
    documents: Set<string>
    stores: Set<string>
    store: string
    effectiveAt: string | null
  }>()
  for (let rowNumber = detailHeaderRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const code = cellText(row.getCell(columns.code).value)
    const name = cellText(row.getCell(columns.name).value)
    if ((!code && !name) || code === '合计' || name === '合计') continue
    const type = cellText(row.getCell(columns.type).value)
    // 只有配送发货出库进出库台账。其余已知类型记数报出，未登记的类型阻断整批。
    if (!OUTBOUND_MOVEMENT_TYPES.has(type)) {
      if (KNOWN_NON_OUTBOUND_TYPES.has(type)) skippedTypes.set(type, (skippedTypes.get(type) || 0) + 1)
      else if (type) unknownTypes.set(type, (unknownTypes.get(type) || 0) + 1)
      continue
    }
    const quantity = numberCell(row.getCell(columns.outboundBaseQuantity).value)
    rowCount += 1
    const documentNo = cellText(row.getCell(columns.documentNo).value)
    const store = columns.counterparty ? cellText(row.getCell(columns.counterparty).value) : ''
    if (documentNo) documents.add(documentNo)
    if (store) stores.add(store)
    if (code) skus.add(code.toUpperCase())
    const documentSku = `${documentNo}|${code}`
    documentSkus.set(documentSku, (documentSkus.get(documentSku) || 0) + 1)
    outboundQuantity += quantity
    const lineCost = columns.outboundCost ? numberCell(row.getCell(columns.outboundCost).value) : 0
    const lineSettlement = columns.outboundSettlement ? numberCell(row.getCell(columns.outboundSettlement).value) : 0
    costAmount += lineCost
    settlementAmount += lineSettlement
    grossProfit += columns.outboundGrossProfit ? numberCell(row.getCell(columns.outboundGrossProfit).value) : 0
    if (quantity > 0 && columns.outboundCost && lineCost === 0) zeroCostLineCount += 1

    const sourceUnit = cellText(row.getCell(columns.sourceUnit).value)
    const baseUnit = cellText(row.getCell(columns.baseUnit).value)
    const ledgerKey = `${code.toUpperCase()}|${sourceUnit}|${baseUnit}|${store}`
    const existing = ledger.get(ledgerKey) || {
      externalCode: code.toUpperCase(),
      externalName: name,
      sourceUnit,
      baseUnit,
      sourceSpec: (columns.spec ? cellText(row.getCell(columns.spec).value) : '') || null,
      quantity: 0,
      baseQuantity: 0,
      costAmount: 0,
      settlementAmount: 0,
      documents: new Set<string>(),
      stores: new Set<string>(),
      store,
      effectiveAt: null,
    }
    existing.quantity += numberCell(row.getCell(columns.outboundQuantity).value)
    existing.baseQuantity += numberCell(row.getCell(columns.outboundBaseQuantity).value)
    existing.costAmount += lineCost
    existing.settlementAmount += lineSettlement
    if (documentNo) existing.documents.add(documentNo)
    if (store) existing.stores.add(store)
    // 归属时点用单据审核时间:库存快照是某个时刻导出的，而单据审核散布全天，
    // 按「单据日期」归属会让当晚审核的流水错位到前一天(实测 8-11 快照 18:10，
    // 而当天 20:25~22:32 才审核的几笔全部落在了错误的一侧)。
    const rowEffectiveAt = (columns.auditedAt ? cellText(row.getCell(columns.auditedAt).value) : '')
      || (columns.documentDate ? cellText(row.getCell(columns.documentDate).value) : '')
    if (rowEffectiveAt && (!existing.effectiveAt || rowEffectiveAt > existing.effectiveAt)) existing.effectiveAt = rowEffectiveAt
    ledger.set(ledgerKey, existing)
  }
  if (unknownTypes.size > 0) {
    const detail = [...unknownTypes].map(([type, count]) => `${type}×${count}`).join('、')
    throw Object.assign(
      new Error(`出入库明细表出现未登记的出入库类型：${detail}。`
        + '请先确认这些类型该不该进出库台账，再重新上传——静默忽略会让总仓账面凭空少掉一批货。'),
      { statusCode: 400 },
    )
  }
  const roundedCost = round(costAmount)
  const roundedSettlement = round(settlementAmount)
  return {
    skippedTypes: [...skippedTypes].map(([type, count]) => ({ type, count })),
    summary: {
      rowCount,
      documentCount: documents.size,
      storeCount: stores.size,
      skuCount: skus.size,
      outboundQuantity: round(outboundQuantity, 3),
      costAmount: roundedCost,
      settlementAmount: roundedSettlement,
      grossProfit: round(grossProfit),
      grossMargin: roundedSettlement > 0 ? round(grossProfit / roundedSettlement * 100, 2) : null,
      zeroCostLineCount,
      splitDocumentSkuCount: [...documentSkus.values()].filter(count => count > 1).length,
    },
    ledger: [...ledger.values()].map(item => ({
      ...item,
      quantity: round(item.quantity, 6),
      baseQuantity: round(item.baseQuantity, 6),
      costAmount: round(item.costAmount),
      settlementAmount: round(item.settlementAmount),
      documents: [...item.documents].sort(),
      stores: [...item.stores].sort(),
    })),
  }
}

async function summarizePurchasing(buffer: Buffer) {
  const book = await workbook(buffer)
  const sheet = book.worksheets.find(candidate => findRow(candidate, ['供应商名称', '物品编码', '收货数量']))
  if (!sheet) throw Object.assign(new Error('采购文件缺少可识别的汇总表'), { statusCode: 400 })
  const headerRow = findRow(sheet, ['供应商名称', '物品编码', '收货数量'])!
  const headers = Array.from({ length: sheet.columnCount }, (_, index) => cellText(sheet.getRow(headerRow).getCell(index + 1).value))
  const index = (label: string) => headers.indexOf(label) + 1
  const suppliers = new Set<string>()
  const skus = new Set<string>()
  let rowCount = 0
  let receivedQuantity = 0
  let receivedAmount = 0
  let returnedQuantity = 0
  let returnedAmount = 0
  let receivedWithoutPurchaseCount = 0
  const ledger = new Map<string, {
    externalCode: string
    externalName: string
    sourceUnit: string
    sourceSpec: string | null
    quantity: number
    amount: number
    suppliers: Set<string>
  }>()
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const code = cellText(row.getCell(index('物品编码')).value)
    const name = cellText(row.getCell(index('物品名称')).value)
    if ((!code && !name) || code === '合计' || name === '合计') continue
    rowCount += 1
    const supplier = cellText(row.getCell(index('供应商名称')).value)
    if (supplier) suppliers.add(supplier)
    if (code) skus.add(code.toUpperCase())
    const purchaseQuantity = numberCell(row.getCell(index('采购数量')).value)
    const lineReceived = numberCell(row.getCell(index('收货数量')).value)
    receivedQuantity += lineReceived
    receivedAmount += numberCell(row.getCell(index('收货金额（含税）')).value)
    returnedQuantity += numberCell(row.getCell(index('退货数量')).value)
    returnedAmount += numberCell(row.getCell(index('退货金额（含税）')).value)
    if (purchaseQuantity === 0 && lineReceived > 0) receivedWithoutPurchaseCount += 1

    const sourceUnit = cellText(row.getCell(index('单位')).value)
    const key = `${code.toUpperCase()}|${sourceUnit}`
    const existing = ledger.get(key) || {
      externalCode: code.toUpperCase(),
      externalName: name,
      sourceUnit,
      sourceSpec: cellText(row.getCell(index('规格型号')).value) || null,
      quantity: 0,
      amount: 0,
      suppliers: new Set<string>(),
    }
    existing.quantity += lineReceived - numberCell(row.getCell(index('退货数量')).value)
    existing.amount += numberCell(row.getCell(index('收货金额（含税）')).value)
      - numberCell(row.getCell(index('退货金额（含税）')).value)
    if (supplier) existing.suppliers.add(supplier)
    ledger.set(key, existing)
  }
  return {
    summary: {
      rowCount,
      supplierCount: suppliers.size,
      skuCount: skus.size,
      receivedQuantity: round(receivedQuantity, 3),
      receivedAmount: round(receivedAmount),
      returnedQuantity: round(returnedQuantity, 3),
      returnedAmount: round(returnedAmount),
      receivedWithoutPurchaseCount,
    },
    skus,
    ledger: [...ledger.values()].filter(item => item.quantity !== 0 || item.amount !== 0).map(item => ({
      ...item,
      quantity: round(item.quantity, 6),
      amount: round(item.amount),
      suppliers: [...item.suppliers].sort(),
    })),
  }
}

export async function extractSupplyChainDailyPackage(buffer: Buffer): Promise<ExtractedSupplyChainDailyPackage> {
  const files = await extractArchive(buffer)
  const recognized = new Map<'inventory' | 'movements' | 'purchasing', { filename: string; buffer: Buffer }>()
  for (const file of files) {
    if (!file.filename.toLowerCase().endsWith('.xlsx')) continue
    const kind = classifyWorkbook(file.filename)
    if (!kind) continue
    if (recognized.has(kind)) throw Object.assign(new Error(`压缩包内包含多个${kind === 'inventory' ? '库存' : kind === 'movements' ? '出入库' : '采购'}文件`), { statusCode: 400 })
    recognized.set(kind, file)
  }
  const inventory = recognized.get('inventory')
  const movements = recognized.get('movements')
  const purchasing = recognized.get('purchasing')
  if (!inventory || !movements || !purchasing) {
    throw Object.assign(new Error('每日数据包必须同时包含：实时库存查询表、出入库明细表、采购汇总表'), { statusCode: 400 })
  }

  const fileDates = [inventory.filename, movements.filename, purchasing.filename].map(dateAndTimeFromFilename)
  const dates = new Set(fileDates.map(item => item.date).filter(Boolean))
  if (dates.size !== 1) throw Object.assign(new Error('每日数据包内三份表的日期不一致'), { statusCode: 400 })
  const packageDate = fileDates[0].date!
  const sourceSnapshotAt = fileDates[0].timestamp
  const [inventoryResult, movementResult, purchasingResult] = await Promise.all([
    summarizeInventory(inventory.buffer),
    summarizeMovements(movements.buffer),
    summarizePurchasing(purchasing.buffer),
  ])
  const missingPurchaseSkus = [...purchasingResult.skus].filter(code => !inventoryResult.codes.has(code))
  const issues: SupplyChainPackageIssue[] = []
  if (inventoryResult.summary.theoreticalNegativeCount > 0) {
    issues.push({ code: 'THEORETICAL_NEGATIVE_STOCK', message: `${inventoryResult.summary.theoreticalNegativeCount} 个商品理论库存为负`, detail: '不阻断快照校准，但需核对待入库、待出库或历史流水。' })
  }
  if (movementResult.skippedTypes.length > 0) {
    const detail = movementResult.skippedTypes.map(item => `${item.type}×${item.count}`).join('、')
    issues.push({
      code: 'NON_OUTBOUND_MOVEMENT_SKIPPED',
      message: `${movementResult.skippedTypes.reduce((sum, item) => sum + item.count, 0)} 行非配送出库明细未计入出库台账`,
      detail: `${detail}。入库以采购汇总表为准，这些行只作提示。`,
    })
  }
  if (movementResult.summary.zeroCostLineCount > 0) {
    issues.push({ code: 'ZERO_COST_OUTBOUND', message: `${movementResult.summary.zeroCostLineCount} 条配送出库成本为 0`, detail: '会造成配送毛利偏高，请补齐商品成本档案。' })
  }
  if (movementResult.summary.splitDocumentSkuCount > 0) {
    issues.push({ code: 'SPLIT_DOCUMENT_SKU', message: `${movementResult.summary.splitDocumentSkuCount} 个“单据+商品”存在拆分行`, detail: '系统按行汇总核对，不会误判为重复单据。' })
  }
  if (purchasingResult.summary.receivedWithoutPurchaseCount > 0) {
    issues.push({ code: 'RECEIPT_WITHOUT_PERIOD_PURCHASE', message: `${purchasingResult.summary.receivedWithoutPurchaseCount} 行本期采购数量为 0 但有收货`, detail: '系统按“日期+数据包+商品”汇总为幂等净入库流水，不依赖收货单号。' })
  }
  if (missingPurchaseSkus.length > 0) {
    issues.push({ code: 'PURCHASE_SKU_MISSING_FROM_SNAPSHOT', message: `${missingPurchaseSkus.length} 个当日收货商品未出现在期末库存表`, detail: `编码：${missingPurchaseSkus.slice(0, 8).join('、')}${missingPurchaseSkus.length > 8 ? '…' : ''}` })
  }

  return {
    inventoryFilename: inventory.filename,
    inventoryBuffer: inventory.buffer,
    summary: {
      packageDate,
      sourceSnapshotAt,
      sourceFiles: { inventory: inventory.filename, movements: movements.filename, purchasing: purchasing.filename },
      inventory: inventoryResult.summary,
      movements: movementResult.summary,
      purchasing: purchasingResult.summary,
      ledger: {
        inbound: purchasingResult.ledger,
        outbound: movementResult.ledger,
      },
      issues,
    },
  }
}
