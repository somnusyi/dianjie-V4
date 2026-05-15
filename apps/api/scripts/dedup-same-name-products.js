/**
 * 同名 SKU 合并 (精确匹配, 不做模糊):
 *   按 (supplierId, name) 分组, 多于 1 条就合并:
 *     - 保留: 有任何业务引用的那条 (订单/收货/报损/消耗); 都没引用就保留 price>0 那条; 都没 price 就保留最早创建
 *     - 其余: stock 累加到保留条, 自己 stock=0, name 加 [已合并] 后缀
 *
 * 模式:
 *   node dedup-same-name-products.js          # dry-run
 *   node dedup-same-name-products.js --apply  # 真改
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

;(async () => {
  console.log(`模式: ${APPLY ? '【真改】' : '【dry-run 只看不改】'}\n`)

  // 1. 找同名 (supplier, name) 重复组
  const groups = await p.product.groupBy({
    by: ['supplierId', 'name'],
    where: { NOT: { name: { endsWith: '[已合并]' } } },
    _count: { _all: true },
    having: { id: { _count: { gt: 1 } } },
  })
  // 按重复数 desc
  groups.sort((a, b) => b._count._all - a._count._all)
  console.log(`重复组数: ${groups.length}\n`)

  let mergedGroups = 0, totalMerged = 0, totalSkipped = 0

  for (const g of groups) {
    const dupes = await p.product.findMany({
      where: { supplierId: g.supplierId, name: g.name },
      select: {
        id: true, name: true, stock: true, price: true, createdAt: true,
        _count: {
          select: {
            purchaseOrderItems: true,
            receiptItems: true,
            lossClaimItems: true,
            consumptions: true,
            stockMovements: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    // 排名: refCount desc, price desc, createdAt asc
    const scored = dupes.map((d) => ({
      ...d,
      refCount: d._count.purchaseOrderItems + d._count.receiptItems + d._count.lossClaimItems + d._count.consumptions + d._count.stockMovements,
    }))
    scored.sort((a, b) => (b.refCount - a.refCount) || (Number(b.price) - Number(a.price)) || (a.createdAt - b.createdAt))

    const keep = scored[0]
    const drops = scored.slice(1)
    const sumStock = drops.reduce((s, d) => s + Number(d.stock || 0), 0)
    const totalStock = Number(keep.stock || 0) + sumStock

    console.log(`  ${g.name} (${dupes.length} 条):`)
    console.log(`    保留: id=${keep.id.slice(0,8)} price=${keep.price} stock=${keep.stock} refs=${keep.refCount}`)
    drops.forEach((d) => {
      console.log(`    丢弃: id=${d.id.slice(0,8)} price=${d.price} stock=${d.stock} refs=${d.refCount}  → 累加 ${d.stock}`)
    })
    console.log(`    最终保留条 stock: ${keep.stock} + ${sumStock} = ${totalStock}`)

    if (APPLY) {
      await p.product.update({ where: { id: keep.id }, data: { stock: totalStock } })
      for (const d of drops) {
        await p.product.update({ where: { id: d.id }, data: { stock: 0, name: d.name + ' [已合并]' } })
        totalMerged++
      }
      mergedGroups++
    }
  }

  console.log(`\n汇总: ${groups.length} 组同名重复 | ${APPLY ? `已合并 ${totalMerged} 条 (${mergedGroups} 组)` : `可合并`}`)
  if (!APPLY) console.log('\n[dry-run] 真改: node scripts/dedup-same-name-products.js --apply')
  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
