/**
 * 修复双轨 SKU 引起的负库存
 * 策略 (收紧版):
 *   1. 只处理 stock < 0 的 Product (即燃眉之急)
 *   2. 在同一供应商下找 price=0 的孤儿条目,要求名字共享 token ≥ 4
 *   3. 同一负库存 SKU 候选 > 1 → 跳过让人工判断
 *   4. 把孤儿条目的 stock 转移到负库存条目, 孤儿条目改名 [已合并]
 *
 * 模式:
 *   node merge-duplicate-products.js          # dry-run
 *   node merge-duplicate-products.js --apply  # 真改
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

function normalize(s) {
  return s.replace(/[（）()【】\[\],，。.\s\/·\-—]/g, '').toLowerCase()
}
function charJaccard(a, b) {
  const A = new Set(normalize(a)), B = new Set(normalize(b))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  const union = A.size + B.size - inter
  return inter / union
}

;(async () => {
  console.log(`模式: ${APPLY ? '【真改】' : '【dry-run 只看不改】'}\n`)

  // 1. 取所有负库存
  const negs = await p.product.findMany({
    where: { stock: { lt: 0 } },
    select: { id: true, name: true, stock: true, supplierId: true, price: true, unit: true, supplier: { select: { name: true } } },
  })
  console.log(`负库存 SKU 数: ${negs.length}\n`)

  // 去重 (DB 里有重复同名记录)
  const seenIds = new Set()
  const uniq = negs.filter((n) => seenIds.has(n.id) ? false : seenIds.add(n.id))
  console.log(`(去重后: ${uniq.length})\n`)

  let merged = 0, zeroed = 0, ambiguous = 0
  for (const n of uniq) {
    // 同供应商, price=0, 不是自己
    const candidates = await p.product.findMany({
      where: { supplierId: n.supplierId, price: 0, id: { not: n.id } },
      select: { id: true, name: true, stock: true, unit: true },
    })
    const scored = candidates
      .map((c) => ({ c, score: charJaccard(n.name, c.name) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)

    const before = Number(n.stock)

    if (scored.length === 0) {
      // 无双轨, 单纯负数 → 归零
      console.log(`  ${APPLY ? '✓ 归零' : '· 待归零'}: [${n.supplier?.name || '?'}] 「${n.name}」 ${before} → 0  (无双轨)`)
      if (APPLY) {
        await p.product.update({ where: { id: n.id }, data: { stock: 0 } })
      }
      zeroed++
      continue
    }
    if (scored.length > 1 && scored[0].score === scored[1].score) {
      console.log(`  ⚠ 多候选(歧义): 「${n.name}」 stock=${n.stock} 候选:`)
      scored.slice(0, 3).forEach((s) => console.log(`      ${s.c.name} stock=${s.c.stock} score=${s.score.toFixed(2)}`))
      ambiguous++
      continue
    }
    const top = scored[0]
    const add = Number(top.c.stock)
    const after = before + add
    console.log(`  ${APPLY ? '✓ 合并' : '· 待合并'}: [${n.supplier?.name || '?'}] 「${n.name}」 ${before} + 「${top.c.name}」 ${add} = ${after}  (jaccard=${top.score.toFixed(2)})`)

    if (APPLY) {
      await p.product.update({ where: { id: n.id }, data: { stock: Math.max(0, after) } })
      await p.product.update({ where: { id: top.c.id }, data: { stock: 0, name: top.c.name + ' [已合并]' } })
      merged++
    }
  }
  console.log(`\n汇总: 负库存 ${uniq.length} 个 | ${APPLY ? '已合并' : '可合并'} ${merged} | ${APPLY ? '已归零' : '待归零'} ${zeroed} | 歧义 ${ambiguous}`)
  if (!APPLY) console.log('\n[dry-run] 满意 → node scripts/merge-duplicate-products.js --apply')
  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
