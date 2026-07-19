/** Import the audited finance monthly-close workbook without overwriting daily operating data. */
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import { Prisma, prisma } from '@dianjie/db'
import { monthRangeForDateCol } from '../src/lib/dateRange'

type ExpenseLine = { category: 'LABOR' | 'SALES' | 'MGMT' | 'FINANCE'; item: string; amount: number }

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const num = (value: ExcelJS.CellValue) => {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return value
  if (typeof value === 'object' && 'result' in value) return Number(value.result || 0)
  return Number(String(value).replace(/,/g, '')) || 0
}
const text = (value: ExcelJS.CellValue) => String(value ?? '').trim()

function expenseLines(sheet: ExcelJS.Worksheet, column: number): ExpenseLine[] {
  const groups: Array<{ category: ExpenseLine['category']; start: number; end: number }> = [
    { category: 'LABOR', start: 23, end: 28 },
    { category: 'SALES', start: 30, end: 52 },
    { category: 'MGMT', start: 54, end: 65 },
    { category: 'FINANCE', start: 67, end: 68 },
  ]
  return groups.flatMap(group => {
    const rows: ExpenseLine[] = []
    for (let row = group.start; row <= group.end; row += 1) {
      const amount = round(num(sheet.getCell(row, column).value))
      if (amount === 0) continue
      let item = text(sheet.getCell(row, 3).value) || text(sheet.getCell(row, 2).value)
      item = item.replace(/^\d+[、.]\s*/, '')
      if (group.category === 'SALES' && item === '其他') item = '其他销售费用'
      if (group.category === 'MGMT' && item === '总部管理费') item = '总部管理费2%'
      if (group.category === 'MGMT' && item === '运营服务费') item = '运营服务费5%'
      rows.push({ category: group.category, item, amount })
    }
    return rows
  })
}

async function main() {
  const args = process.argv.slice(2)
  const file = args.find(arg => arg.startsWith('--file='))?.slice('--file='.length)
  if (!file) throw new Error('必须提供 --file=/absolute/path/to/月度利润表.xlsx')
  const commit = args.includes('--commit')
  if (commit && !args.includes('--confirm=store-monthly-close')) {
    throw new Error('写入必须提供 --commit --confirm=store-monthly-close')
  }
  const tenantSlug = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const storeNo = args.find(arg => arg.startsWith('--store-no='))?.slice('--store-no='.length) || 'DJ001'
  const source = await fs.readFile(file)
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(source as any)
  const sheet = workbook.worksheets[0]
  if (!sheet || !text(sheet.getCell('A1').value).includes('月度利润表')) throw new Error('不是受支持的门店月度利润表')
  const yearMatch = text(sheet.getCell('A2').value).match(/(20\d{2})年/)
  if (!yearMatch) throw new Error('无法识别所属年份')
  const year = Number(yearMatch[1])
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id, no: storeNo } })
  const actor = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: { in: ['FINANCE', 'SUPER_ADMIN', 'ADMIN'] } }, orderBy: { createdAt: 'asc' },
  })
  if (commit && !actor) throw new Error('租户没有财务或管理员账号，无法记录月结确认人')

  const closes = []
  for (let column = 4; column <= 6; column += 1) {
    const header = text(sheet.getCell(3, column).value)
    const monthNumber = Number(header.match(/(\d+)月/)?.[1])
    if (!(monthNumber >= 1 && monthNumber <= 12)) continue
    const month = `${year}-${String(monthNumber).padStart(2, '0')}`
    const lines = expenseLines(sheet, column)
    const close = {
      month,
      operatingRevenue: round(num(sheet.getCell(4, column).value)),
      revenueExTax: round(num(sheet.getCell(7, column).value)),
      vat: round(num(sheet.getCell(8, column).value)),
      surcharge: round(num(sheet.getCell(9, column).value)),
      foodCost: round(num(sheet.getCell(18, column).value)),
      beverageCost: round(num(sheet.getCell(19, column).value)),
      consumablesCost: round(num(sheet.getCell(20, column).value)),
      laborCost: round(num(sheet.getCell(22, column).value)),
      salesExpense: round(num(sheet.getCell(29, column).value)),
      managementExpense: round(num(sheet.getCell(53, column).value)),
      financeExpense: round(num(sheet.getCell(66, column).value)),
      nonOperatingIncome: round(num(sheet.getCell(71, column).value)),
      nonOperatingExpense: round(num(sheet.getCell(72, column).value)),
      profitBeforeTax: round(num(sheet.getCell(73, column).value)),
      incomeTax: round(num(sheet.getCell(74, column).value)),
      netProfit: round(num(sheet.getCell(75, column).value)),
      expenseLines: lines,
    }
    const calculatedNet = round(close.revenueExTax - close.surcharge - close.foodCost - close.beverageCost
      - close.consumablesCost - close.laborCost - close.salesExpense - close.managementExpense
      - close.financeExpense + close.nonOperatingIncome - close.nonOperatingExpense - close.incomeTax)
    if (Math.abs(calculatedNet - close.netProfit) > 0.02) {
      throw new Error(`${month} 月结勾稽不平：计算净利 ${calculatedNet}，表内净利 ${close.netProfit}`)
    }
    const { start, end } = monthRangeForDateCol(month)
    const operationalRows = await prisma.revenueRecord.findMany({ where: { storeId: store.id, date: { gte: start, lte: end } } })
    const operationalRevenue = round(operationalRows.reduce((sum, row) => sum + Number((row.rawData as any)?.netRevenue ?? row.amount), 0))
    closes.push({ ...close, operationalRevenue, reconciliationDifference: round(close.operatingRevenue - operationalRevenue) })
  }
  const report = { mode: commit ? 'commit' : 'dry-run', tenant: tenant.slug, store: { no: store.no, name: store.name },
    source: { filename: path.basename(file), sha256: sourceHash }, closes }
  console.log(JSON.stringify(report, null, 2))
  if (!commit) return
  if (!actor) throw new Error('缺少月结确认人')

  let imported = 0
  let skipped = 0
  await prisma.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`store-monthly-close:${store.id}`}))`)
    for (const close of closes) {
      const existing = await tx.storeMonthlyClose.findUnique({ where: { storeId_month: { storeId: store.id, month: close.month } } })
      if (existing) {
        if (existing.sourceHash === sourceHash) { skipped += 1; continue }
        throw new Error(`${close.month} 已存在其他来源的月结，禁止静默覆盖`)
      }
      await tx.storeMonthlyClose.create({
        data: {
          tenantId: tenant.id, storeId: store.id, month: close.month, status: 'CONFIRMED',
          operatingRevenue: close.operatingRevenue, revenueExTax: close.revenueExTax,
          vat: close.vat, surcharge: close.surcharge, foodCost: close.foodCost,
          beverageCost: close.beverageCost, consumablesCost: close.consumablesCost,
          laborCost: close.laborCost, salesExpense: close.salesExpense,
          managementExpense: close.managementExpense, financeExpense: close.financeExpense,
          nonOperatingIncome: close.nonOperatingIncome, nonOperatingExpense: close.nonOperatingExpense,
          profitBeforeTax: close.profitBeforeTax, incomeTax: close.incomeTax, netProfit: close.netProfit,
          detail: { expenseLines: close.expenseLines, operationalRevenue: close.operationalRevenue,
            reconciliationDifference: close.reconciliationDifference },
          sourceFilename: path.basename(file), sourceHash, confirmedAt: new Date(), confirmedById: actor.id,
        },
      })
      for (const line of close.expenseLines) {
        await tx.storeExpense.upsert({
          where: { storeId_month_item: { storeId: store.id, month: close.month, item: line.item } },
          update: { category: line.category, amount: line.amount,
            note: `财务月结导入：${path.basename(file)} · ${sourceHash.slice(0, 12)}` },
          create: { tenantId: tenant.id, storeId: store.id, month: close.month,
            category: line.category, item: line.item, amount: line.amount,
            note: `财务月结导入：${path.basename(file)} · ${sourceHash.slice(0, 12)}` },
        })
      }
      imported += 1
    }
    if (imported > 0) {
      await tx.opLog.create({ data: { tenantId: tenant.id, userId: actor.id, role: actor.role,
        action: `导入门店财务月结 ${closes.map(close => close.month).join('、')}`, entityType: 'StoreMonthlyClose',
        target: store.name, targetId: store.id, metadata: report as any } })
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
  console.log(JSON.stringify({ ok: true, imported, skipped, sourceHash }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
