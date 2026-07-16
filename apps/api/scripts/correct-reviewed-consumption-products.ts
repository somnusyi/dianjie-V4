/** Correct reviewed duplicate-SKU choices in imported BOM consumptions. */
import 'dotenv/config'
import { prisma } from '@dianjie/db'

const RULES = [
  {
    fromCode: 'ZZ9M-2FQEH2-BL',
    toCode: 'ZZ9M-2DYL69',
    factor: 1,
    note: '灰虎掌归并到有采购和7月13日盘点记录的人工灰虎掌；1件1000g=1kg',
  },
  {
    fromCode: 'ZZ9M-2FQE0G-D5',
    toCode: 'ZZ9M-2DYLDZ',
    factor: 12,
    note: '甄选马蹄爆爆珠归并到有采购和7月13日盘点记录的马蹄爆爆珠；1件=12罐',
  },
] as const

const SOURCE_IDS = ['meituan-bom:2026-07-14:v1', 'meituan-bom:2026-07-15:v1']

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  const confirm = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (commit && confirm !== 'correct-reviewed-consumption-products') {
    throw new Error('写入需 --confirm=correct-reviewed-consumption-products')
  }
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'dianjie' } })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: 'DJ001' } },
  })
  const codes = RULES.flatMap(rule => [rule.fromCode, rule.toCode])
  const products = await prisma.product.findMany({ where: { tenantId: tenant.id, code: { in: codes } } })
  const byCode = new Map(products.map(product => [product.code, product]))

  const corrections = []
  for (const rule of RULES) {
    const from = byCode.get(rule.fromCode)
    const to = byCode.get(rule.toCode)
    if (!from || !to) throw new Error(`商品不存在: ${rule.fromCode} → ${rule.toCode}`)
    const rows = await prisma.stockConsumption.findMany({
      where: {
        tenantId: tenant.id,
        storeId: store.id,
        productId: from.id,
        sourceType: 'bom_import',
        sourceId: { in: SOURCE_IDS },
      },
      orderBy: { date: 'asc' },
    })
    for (const row of rows) {
      const target = await prisma.stockConsumption.findFirst({
        where: { sourceType: row.sourceType, sourceId: row.sourceId, productId: to.id },
      })
      corrections.push({
        rule, from, to, row, target,
        correctedQuantity: Number(row.quantity) * rule.factor,
      })
    }
  }

  console.log(JSON.stringify({
    mode: commit ? 'commit' : 'dry-run',
    rows: corrections.length,
    corrections: corrections.map(item => ({
      date: item.row.date.toISOString().slice(0, 10),
      sourceId: item.row.sourceId,
      from: { code: item.from.code, name: item.from.name, quantity: Number(item.row.quantity), unit: item.from.unit },
      to: { code: item.to.code, name: item.to.name, quantity: item.correctedQuantity, unit: item.to.unit },
      mergeIntoExisting: Boolean(item.target),
      note: item.rule.note,
    })),
  }, null, 2))
  if (!commit) return

  await prisma.$transaction(async tx => {
    for (const item of corrections) {
      const correctionNote = `${item.row.note || ''}；SKU纠正：${item.rule.note}`.slice(0, 1000)
      if (item.target) {
        if (item.target.date.getTime() !== item.row.date.getTime()) {
          throw new Error(`同一来源目标消耗日期不一致: ${item.row.sourceId}`)
        }
        await tx.stockConsumption.update({
          where: { id: item.target.id },
          data: {
            quantity: Number(item.target.quantity) + item.correctedQuantity,
            note: `${item.target.note || ''}；${correctionNote}`.slice(0, 1000),
          },
        })
        await tx.stockConsumption.delete({ where: { id: item.row.id } })
      } else {
        await tx.stockConsumption.update({
          where: { id: item.row.id },
          data: { productId: item.to.id, quantity: item.correctedQuantity, note: correctionNote },
        })
      }
    }
  })
  console.log(JSON.stringify({ ok: true, corrected: corrections.length }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
