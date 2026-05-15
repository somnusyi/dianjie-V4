/**
 * 全量库存自查:
 *   对每个 dianjie tenant Product (有 supplier):
 *     - 当前 Product.stock
 *     - SupplierStockMovement.delta 累加 (理应等于 stock 如果初始为 0)
 *     - 关联的 PurchaseOrderItem 实发量累加 (出库)
 *     - 关联的 LossClaimItem 同意了的累加 (退回)
 *     - 比对一致性
 *
 *   分类:
 *     A. 流水累加 == stock  ✅ 完全对账
 *     B. stock != 0, 但流水累加 = 0  ⚠ 库存是 bare-set 进去的, 无 audit trail
 *     C. 流水累加 != stock  ❌ 数据不一致, 需要查
 *     D. stock < 0  ❌ 负库存 (应该 0)
 *     E. stock = 0, 流水累加 != 0  ❌ 流水显示有货但 stock 是 0
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

;(async () => {
  // 只查 dianjie tenant 的真实数据
  const tenant = await p.tenant.findFirst({ where: { slug: 'dianjie' } })
  if (!tenant) { console.log('未找到 dianjie tenant'); return }
  console.log(`Tenant: dianjie (${tenant.id.slice(0,10)})\n`)

  const products = await p.product.findMany({
    where: { tenantId: tenant.id, supplierId: { not: null } },
    select: { id: true, name: true, stock: true, price: true, unit: true, supplierId: true, supplier: { select: { name: true } } },
  })
  console.log(`供应商商品总数: ${products.length}\n`)

  const buckets = { A: [], B: [], C: [], D: [], E: [] }

  for (const r of products) {
    const stock = Number(r.stock || 0)
    const movs = await p.supplierStockMovement.findMany({
      where: { productId: r.id },
      select: { delta: true, type: true, sourceType: true, reason: true, createdAt: true },
    })
    const sumDelta = movs.reduce((s, m) => s + Number(m.delta), 0)

    const items = await p.purchaseOrderItem.findMany({
      where: { productId: r.id, purchaseOrder: { status: { in: ['DELIVERING','PENDING_CONFIRM','RECEIVED','COMPLETED'] } } },
      select: { quantity: true, shippedQty: true, purchaseOrder: { select: { no: true, status: true } } },
    })
    const totalShipped = items.reduce((s, it) => s + Number(it.shippedQty ?? it.quantity ?? 0), 0)

    const lcItems = await p.lossClaimItem.findMany({
      where: { productId: r.id, lossClaim: { status: { in: ['APPROVED','RESOLVED'] } } },
      select: { lossQty: true },
    })
    const totalLossRefund = lcItems.reduce((s, lc) => s + Number(lc.lossQty || 0), 0)

    // 期望: sumDelta ≈ stock (假设无 bare-set)
    // 业务等式: 入库 - 出库 + 报损退回 = sumDelta
    const drift = Math.abs(sumDelta - stock)

    const entry = { ...r, stock, sumDelta, totalShipped, totalLossRefund, drift, movCount: movs.length }

    if (stock < 0) buckets.D.push(entry)
    else if (movs.length === 0 && stock > 0) buckets.B.push(entry)
    else if (drift < 0.01) buckets.A.push(entry)
    else if (stock === 0 && Math.abs(sumDelta) > 0.01) buckets.E.push(entry)
    else buckets.C.push(entry)
  }

  function fmt(e) {
    return `    [${e.stock.toFixed(2).padStart(10)}] ΣΔ=${e.sumDelta.toFixed(2).padStart(10)} 发=${e.totalShipped.toFixed(2).padStart(6)} 损=${e.totalLossRefund.toFixed(2).padStart(4)} mov=${String(e.movCount).padStart(2)} | ${e.name.slice(0,30)}`
  }

  console.log(`✅ A. 对账平 (stock = 累加流水): ${buckets.A.length} 条`)
  console.log(`⚠  B. 无 movement 但 stock>0 (bare-set, 无 audit): ${buckets.B.length} 条`)
  buckets.B.slice(0, 10).forEach((e) => console.log(fmt(e)))
  if (buckets.B.length > 10) console.log(`    ... 还有 ${buckets.B.length - 10}`)

  console.log(`\n❌ C. 流水 ≠ stock (账目不一致): ${buckets.C.length} 条`)
  buckets.C.slice(0, 30).forEach((e) => console.log(fmt(e)))
  if (buckets.C.length > 30) console.log(`    ... 还有 ${buckets.C.length - 30}`)

  console.log(`\n❌ D. 负库存: ${buckets.D.length} 条`)
  buckets.D.forEach((e) => console.log(fmt(e)))

  console.log(`\n❌ E. stock=0 但流水非零: ${buckets.E.length} 条`)
  buckets.E.slice(0, 20).forEach((e) => console.log(fmt(e)))
  if (buckets.E.length > 20) console.log(`    ... 还有 ${buckets.E.length - 20}`)

  console.log('\n--- 总结 ---')
  console.log(`A 对账平: ${buckets.A.length} 条 (${(buckets.A.length/products.length*100).toFixed(0)}%)`)
  console.log(`B 无审计 bare-set: ${buckets.B.length} 条`)
  console.log(`C 账不平: ${buckets.C.length} 条 ⚠`)
  console.log(`D 负库存: ${buckets.D.length} 条 ❌`)
  console.log(`E 应有库存但 stock=0: ${buckets.E.length} 条 ❌`)

  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
