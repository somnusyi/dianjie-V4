/**
 * 门店实物盘点快照导入。
 * 默认只 dry-run；--commit 才写库，已有同日快照需额外 --replace。
 *
 * Usage:
 *   pnpm --filter @dianjie/api exec tsx scripts/import-store-inventory-snapshot.ts \
 *     /path/to/盘点.xlsx --date=2026-07-13 --store=瑶海
 */
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { prisma } from '@dianjie/db'
import { normalizeInventoryQuantity, type InventoryUnitNormalization } from '../src/services/inventoryUnits'

type ParsedItem = {
  section: string | null
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  amount: number
  sortOrder: number
  productId?: string
  normalization?: InventoryUnitNormalization
}

function numeric(value: ExcelJS.CellValue): number {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return value
  if (typeof value === 'object' && 'result' in value) return numeric(value.result as ExcelJS.CellValue)
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    if ('text' in value) return String(value.text || '').trim()
    if ('result' in value) return text(value.result as ExcelJS.CellValue)
  }
  return String(value).trim()
}

function normalizeName(value: string) {
  return value.normalize('NFKC').replace(/[\s·・]/g, '').replace(/[（）]/g, (c) => c === '（' ? '(' : ')').toLowerCase()
}

function dateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`盘点日期格式错误: ${value}`)
  return new Date(`${value}T00:00:00.000Z`)
}

async function main() {
  const args = process.argv.slice(2)
  const sourcePath = args.find((arg) => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  const replace = args.includes('--replace')
  const offline = args.includes('--offline')
  const date = args.find((arg) => arg.startsWith('--date='))?.slice('--date='.length) || '2026-07-13'
  const storeKeyword = args.find((arg) => arg.startsWith('--store='))?.slice('--store='.length) || '瑶海'
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  if (!sourcePath) throw new Error('请传入盘点 Excel 文件路径')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置')

  const bytes = await fs.readFile(sourcePath)
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer)
  const sheet = workbook.getWorksheet('Sheet1') || workbook.worksheets[0]
  if (!sheet) throw new Error('盘点文件没有工作表')

  const items: ParsedItem[] = []
  let currentSection: string | null = null
  let sourceTotal = 0
  for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo++) {
    const sectionText = text(sheet.getCell(rowNo, 1).value)
    const name = text(sheet.getCell(rowNo, 2).value)
    if (sectionText === '合计金额') {
      sourceTotal = numeric(sheet.getCell(rowNo, 7).value)
      break
    }
    if (sectionText) currentSection = sectionText
    if (!name) continue
    const quantity = numeric(sheet.getCell(rowNo, 6).value)
    const unitPrice = numeric(sheet.getCell(rowNo, 4).value)
    const amount = numeric(sheet.getCell(rowNo, 7).value)
    items.push({
      section: currentSection,
      name,
      spec: text(sheet.getCell(rowNo, 3).value) || null,
      unit: text(sheet.getCell(rowNo, 5).value) || '未记录',
      quantity,
      unitPrice,
      amount,
      sortOrder: items.length + 1,
    })
  }
  if (items.length === 0) throw new Error('没有读取到盘点品项')

  const calculatedTotal = items.reduce((sum, item) => sum + item.amount, 0)
  if (Math.abs(calculatedTotal - sourceTotal) > 0.001) {
    throw new Error(`盘点金额不勾稽: 明细 ${calculatedTotal.toFixed(3)} / 表尾 ${sourceTotal.toFixed(3)}`)
  }

  const nonzeroCount = items.filter((item) => item.quantity > 0).length
  const sourceReport = {
    mode: offline ? 'offline-dry-run' : commit ? 'commit' : 'dry-run',
    source: path.basename(sourcePath),
    sourceHash,
    snapshotDate: date,
    itemCount: items.length,
    nonzeroCount,
    zeroCount: items.length - nonzeroCount,
    totalValue: Number(calculatedTotal.toFixed(3)),
  }
  if (offline) {
    console.log(JSON.stringify({ ...sourceReport, note: '离线模式未连接数据库，未执行门店和采购 SKU 匹配' }, null, 2))
    return
  }

  const stores = await prisma.store.findMany({
    where: { tenant: { slug: tenantSlug }, name: { contains: storeKeyword } },
    select: { id: true, tenantId: true, no: true, name: true },
  })
  if (stores.length !== 1) throw new Error(`期望唯一门店，实际 ${stores.length} 家: ${stores.map((s) => s.name).join(', ')}`)
  const store = stores[0]

  const products = await prisma.product.findMany({
    where: { tenantId: store.tenantId },
    select: { id: true, code: true, name: true, spec: true, unit: true },
  })
  const productByName = new Map<string, typeof products>()
  for (const product of products) {
    const key = normalizeName(product.name)
    productByName.set(key, [...(productByName.get(key) || []), product])
  }
  const ambiguous: Array<{ name: string; candidates: string[] }> = []
  for (const item of items) {
    const candidates = productByName.get(normalizeName(item.name)) || []
    if (candidates.length === 1) {
      item.productId = candidates[0].id
      item.normalization = normalizeInventoryQuantity({
        quantity: item.quantity,
        rawUnit: item.unit,
        rawSpec: item.spec,
        productUnit: candidates[0].unit,
        productSpec: candidates[0].spec,
      })
    }
    else if (candidates.length > 1) ambiguous.push({ name: item.name, candidates: candidates.map((p) => `${p.code}:${p.name}`) })
  }

  const matchedCount = items.filter((item) => item.productId).length
  const report = {
    ...sourceReport,
    store,
    matchedCount,
    unmatchedCount: items.length - matchedCount,
    ambiguousCount: ambiguous.length,
    normalizationPendingCount: items.filter(item => item.normalization?.status === 'PENDING').length,
    ambiguous: ambiguous.slice(0, 20),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!commit) return

  const snapshotDate = dateOnly(date)
  const existing = await prisma.inventorySnapshot.findUnique({
    where: { storeId_snapshotDate: { storeId: store.id, snapshotDate } },
    select: { id: true, sourceHash: true },
  })
  if (existing && !replace) {
    throw new Error(`该门店 ${date} 已有盘点快照；确认替换请增加 --replace`)
  }

  await prisma.$transaction(async (tx) => {
    if (existing) await tx.inventorySnapshot.delete({ where: { id: existing.id } })
    await tx.inventorySnapshot.create({
      data: {
        tenantId: store.tenantId,
        storeId: store.id,
        snapshotDate,
        sourceFilename: path.basename(sourcePath),
        sourceHash,
        totalValue: calculatedTotal.toFixed(3),
        itemCount: items.length,
        nonzeroCount,
        zeroCount: items.length - nonzeroCount,
        matchedCount,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            section: item.section,
            rawName: item.name,
            rawSpec: item.spec,
            unit: item.unit,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            amount: item.amount.toFixed(3),
            normalizedQuantity: item.normalization?.normalizedQuantity,
            normalizedUnit: item.normalization?.normalizedUnit,
            normalizationFactor: item.normalization?.factor,
            normalizationStatus: item.normalization?.status,
            normalizationNote: item.normalization?.note,
            sortOrder: item.sortOrder,
          })),
        },
      },
    })
  }, { timeout: 60_000 })
  console.log(`导入完成：${store.name} ${date} 实物盘点 ${items.length} 项，金额 ¥${calculatedTotal.toFixed(3)}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
