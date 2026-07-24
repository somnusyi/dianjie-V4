/**
 * 门店实物盘点快照导入。
 * 默认只 dry-run；--commit 才写库，已有同日快照需额外 --replace。
 *
 * Usage:
 *   pnpm --filter @dianjie/api exec tsx scripts/import-store-inventory-snapshot.ts \
 *     /path/to/盘点.xlsx --date=2026-07-13 --tenant=dianjie --store-no=DJ001
 */
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import {
  buildInventorySnapshotImportPlan,
  type ReviewedInventorySnapshotBinding,
  type InventorySnapshotSourceItem,
} from '../src/services/inventorySnapshotImport'

type ParsedItem = InventorySnapshotSourceItem
type ReviewedBindingsPayload = {
  tenantSlug: string
  targetStoreNo: string
  snapshotDate: string
  sourceHash: string
  bindings: ReviewedInventorySnapshotBinding[]
}

const reviewedBindingsSchema = z.object({
  tenantSlug: z.string().min(1),
  targetStoreNo: z.string().min(1),
  snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  bindings: z.array(z.object({
    sortOrder: z.number().int().positive(),
    rawName: z.string().min(1),
    productCode: z.string().min(1),
    normalizedUnit: z.string().min(1).optional(),
    factorOverride: z.number().positive().optional(),
    note: z.string().min(1),
  })).default([]),
})

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
    if ('richText' in value) {
      return value.richText.map(part => part.text).join('').trim()
    }
  }
  return String(value).trim()
}

function dateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`盘点日期格式错误: ${value}`)
  return new Date(`${value}T00:00:00.000Z`)
}

export async function runInventorySnapshotImport(args = process.argv.slice(2)) {
  const sourcePath = args.find((arg) => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  const replace = args.includes('--replace')
  const offline = args.includes('--offline')
  const date = args.find((arg) => arg.startsWith('--date='))?.slice('--date='.length) || '2026-07-13'
  const storeNo = args.find((arg) => arg.startsWith('--store-no='))?.slice('--store-no='.length)
  const tenantSlug = args.find((arg) => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const confirm = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  const reviewedBindingsPath = args.find((arg) => arg.startsWith('--reviewed-bindings='))?.slice('--reviewed-bindings='.length)
  if (!sourcePath) throw new Error('请传入盘点 Excel 文件路径')
  if (!offline && !process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置')
  if (!offline && !storeNo) throw new Error('必须显式传入 --store-no，禁止按门店名称模糊匹配库存')
  if (commit && confirm !== 'import-reviewed-inventory-snapshot') {
    throw new Error('写入需增加 --confirm=import-reviewed-inventory-snapshot')
  }

  const bytes = await fs.readFile(sourcePath)
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex')
  const snapshotDate = dateOnly(date)
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
      const totalCell = sheet.getCell(rowNo, 7).value
      sourceTotal = text(totalCell)
        ? numeric(totalCell)
        : numeric(sheet.getCell(rowNo - 1, 7).value)
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
    return { ...sourceReport, canCommit: false }
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { slug: tenantSlug },
    select: { id: true, slug: true },
  })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: storeNo! } },
    select: { id: true, tenantId: true, no: true, name: true },
  })

  const products = await prisma.product.findMany({
    where: { tenantId: store.tenantId },
    select: {
      id: true, tenantId: true, code: true, name: true, spec: true, unit: true,
      inventoryUnit: true, inventoryUnitsPerPurchaseUnit: true, unitConversionStatus: true,
      status: true,
    },
  })
  const previousSnapshot = await prisma.inventorySnapshot.findFirst({
    where: { tenantId: store.tenantId, storeId: store.id, snapshotDate: { lt: snapshotDate } },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      snapshotDate: true,
      items: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          sortOrder: true, rawName: true, rawSpec: true, unit: true, productId: true,
          normalizedUnit: true, normalizationFactor: true,
        },
      },
    },
  })

  let reviewedBindings: ReviewedBindingsPayload | null = null
  if (reviewedBindingsPath) {
    reviewedBindings = reviewedBindingsSchema.parse(
      JSON.parse(await fs.readFile(reviewedBindingsPath, 'utf8'))
    ) as ReviewedBindingsPayload
    const metadataIssues = [
      reviewedBindings.tenantSlug !== tenantSlug ? `tenantSlug 应为 ${tenantSlug}` : null,
      reviewedBindings.targetStoreNo !== store.no ? `targetStoreNo 应为 ${store.no}` : null,
      reviewedBindings.snapshotDate !== date ? `snapshotDate 应为 ${date}` : null,
      reviewedBindings.sourceHash.toLowerCase() !== sourceHash.toLowerCase() ? 'sourceHash 与盘点文件不一致' : null,
    ].filter((issue): issue is string => Boolean(issue))
    if (metadataIssues.length > 0) {
      throw new Error(`复核绑定元数据不匹配: ${metadataIssues.join('；')}`)
    }
  }

  const plan = buildInventorySnapshotImportPlan({
    tenantId: store.tenantId,
    items,
    products,
    previousItems: previousSnapshot?.items,
    reviewedBindings: reviewedBindings?.bindings,
  })
  const blockingRows = plan.items.filter(item => item.blockingIssue).map(item => ({
    sortOrder: item.sortOrder,
    name: item.name,
    raw: `${item.quantity} ${item.unit} / ${item.spec || '-'}`,
    matchSource: item.matchSource,
    product: item.productCode ? `${item.productCode}:${item.productName}` : null,
    candidates: item.candidates,
    issue: item.blockingIssue,
  }))
  const report = {
    ...sourceReport,
    store,
    previousSnapshotDate: previousSnapshot?.snapshotDate.toISOString().slice(0, 10) || null,
    matchedCount: plan.matchedCount,
    unmatchedCount: plan.unmatchedCount,
    ambiguousCount: plan.ambiguousCount,
    normalizationPendingCount: plan.normalizationPendingCount,
    reviewedCount: plan.reviewedCount,
    previousSnapshotCount: plan.previousSnapshotCount,
    exactNameCount: plan.exactNameCount,
    configurationIssues: plan.configurationIssues,
    blockingRows,
    canCommit: plan.canCommit,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!commit) return report
  if (!plan.canCommit) {
    throw new Error(
      `盘点导入被门禁阻止: unmatched=${plan.unmatchedCount}, ambiguous=${plan.ambiguousCount}, `
      + `pending=${plan.normalizationPendingCount}, configuration=${plan.configurationIssues.length}`
    )
  }

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
        matchedCount: plan.matchedCount,
        items: {
          create: plan.items.map((item) => ({
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
            normalizationNote: item.normalizationNote,
            sortOrder: item.sortOrder,
          })),
        },
      },
    })
  }, { timeout: 60_000 })
  console.log(`导入完成：${store.name} ${date} 实物盘点 ${items.length} 项，金额 ¥${calculatedTotal.toFixed(3)}`)
  return { ...report, committed: true }
}

if (require.main === module) {
  runInventorySnapshotImport()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
