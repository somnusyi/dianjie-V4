/**
 * 给昨天合并操作补写 SupplierStockMovement 流水
 *   - 「保乐肩(M2安格斯)」: +817.665 (from 安格斯M2-保乐肩)
 *   - 「冻青头」:           +68
 *   - 「米布粉」:           +0 (无变化但写 0 流水)
 *   - 「青芒酸木瓜汁」:      +0
 *   - 「安格斯M2-保乐肩 [已合并]」: -817.665 (转出)
 *   - 「冻青头菌 [已合并]」:        -68 (转出)
 *
 * 安全护栏: 只写从未写过 "合并迁移" 这条 reason 的 product, 避免重复回填
 *
 * 模式:
 *   node backfill-merge-movements.js          # dry-run
 *   node backfill-merge-movements.js --apply  # 真改
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

const REASON = '合并双轨 SKU 转账(脚本补流水)'

const ACTIONS = [
  // [Product.name, expected supplier substring, delta]
  ['保乐肩（M2安格斯）', '南京捌拾捌号', 817.665],
  ['冻青头', '南京捌拾捌号', 68],
  ['安格斯M2-保乐肩 [已合并]', '南京捌拾捌号', -817.665],
  ['冻青头菌 [已合并]', '南京捌拾捌号', -68],
  // 米布粉 / 青芒: delta=0 不需要补
]

;(async () => {
  console.log(`模式: ${APPLY ? '【真改】' : '【dry-run】'}\n`)
  const tenant = await p.tenant.findFirst({ where: { slug: 'dianjie' } })
  if (!tenant) { console.log('未找到 dianjie tenant'); return }

  let written = 0, skipped = 0
  for (const [name, supName, delta] of ACTIONS) {
    const prods = await p.product.findMany({
      where: { tenantId: tenant.id, name, supplier: { name: { contains: supName } } },
      select: { id: true, name: true, stock: true, supplierId: true },
    })
    if (prods.length === 0) {
      console.log(`  ✗ 找不到: 「${name}」`)
      continue
    }
    if (prods.length > 1) {
      console.log(`  ⚠ 找到 ${prods.length} 条, 跳过(歧义): ${name}`)
      skipped++
      continue
    }
    const r = prods[0]

    // 检查是否已经回填过
    const existed = await p.supplierStockMovement.findFirst({
      where: { productId: r.id, reason: REASON },
    })
    if (existed) {
      console.log(`  · 已有补流水, 跳过: ${name}`)
      skipped++
      continue
    }

    console.log(`  ${APPLY ? '✓ 补' : '· 待补'}: 「${name}」 delta=${delta} (当前 stock=${r.stock})`)

    if (APPLY) {
      await p.supplierStockMovement.create({
        data: {
          tenantId: tenant.id,
          supplierId: r.supplierId,
          productId: r.id,
          delta,
          balanceAfter: Number(r.stock), // 当前 stock 就是 after
          type: 'ADJUSTMENT',
          reason: REASON,
          sourceType: 'Adjustment',
          sourceId: null,
        },
      })
      written++
    }
  }

  console.log(`\n汇总: ${APPLY ? '已写' : '可写'} ${APPLY ? written : ACTIONS.length - skipped} 条 movement, 跳过 ${skipped} 条`)
  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
