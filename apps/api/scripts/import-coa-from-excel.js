/**
 * 从 Excel 文件导入会计科目到指定 tenant
 *
 * 用法: node import-coa-from-excel.js <excel-path> <tenant-slug>
 *
 * Excel 必须含列: 科目编码, 科目名称, 方向 (借/贷)
 * 方向 → AccountType:
 *   借 + code 1xxx          → ASSET
 *   借 + code 2xxx          → ASSET (其实是负债的借方科目, 如累计折旧, 这里仍归 ASSET)
 *   贷 + code 2xxx          → LIABILITY
 *   贷 + code 3xxx-4xxx     → EQUITY
 *   贷 + code 5001-5301     → REVENUE
 *   借 + code 5401-5901     → EXPENSE
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const XLSX = require('exceljs')
const p = new PrismaClient()

const [, , filePath, tenantSlug] = process.argv
if (!filePath || !tenantSlug) {
  console.error('用法: node import-coa-from-excel.js <excel-path> <tenant-slug>')
  process.exit(1)
}

function inferType(code, direction) {
  const head = code[0]
  if (head === '1') return 'ASSET'
  if (head === '2') return direction === '借' ? 'ASSET' : 'LIABILITY'
  if (head === '3' || head === '4') return 'EQUITY'
  if (head === '5') {
    // 5001/5051/5111/5301 收入类; 5401/5601/5602/5603/5711/5801/5901 费用类
    const n = parseInt(code.slice(0, 4))
    if (n <= 5301) return 'REVENUE'
    return 'EXPENSE'
  }
  return 'ASSET'
}

;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: tenantSlug } })
  if (!t) { console.error(`tenant ${tenantSlug} 不存在`); process.exit(1) }

  const wb = new XLSX.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.worksheets[0]

  let imported = 0, skipped = 0
  const rows = []
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return  // header
    const code = String(row.getCell(1).value || '').trim()
    const name = String(row.getCell(2).value || '').trim()
    const direction = String(row.getCell(3).value || '').trim()
    if (!code || !name) return
    rows.push({ code, name, direction })
  })

  // 先标记历史 builtin 为非 builtin (避免误认为系统预置)
  await p.chartOfAccount.updateMany({
    where: { tenantId: t.id, builtin: true },
    data: { builtin: false },
  })

  for (const r of rows) {
    const parentCode = r.code.length > 4 ? r.code.slice(0, r.code.length - 2) : null
    // 判断是否末级 (无下级)
    const hasChild = rows.some((x) => x.code !== r.code && x.code.startsWith(r.code))
    await p.chartOfAccount.upsert({
      where: { tenantId_code: { tenantId: t.id, code: r.code } },
      create: {
        tenantId: t.id, code: r.code, name: r.name,
        type: inferType(r.code, r.direction),
        parentCode: parentCode,
        isDetail: !hasChild,
        builtin: true,
      },
      update: {
        name: r.name,
        type: inferType(r.code, r.direction),
        parentCode: parentCode,
        isDetail: !hasChild,
        builtin: true,
      },
    })
    imported++
  }
  console.log(`✓ tenant=${tenantSlug} 导入 ${imported} 条科目`)
  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
