/**
 * 单 SKU 完整生命周期追踪:
 *   - 当前 Product 记录(可能多份)
 *   - 库存流水 SupplierStockMovement (delta + 来源)
 *   - 关联的订单项 PurchaseOrderItem (谁下的, 实发多少, 是否报损)
 *   - 关联的报损 LossClaimItem
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const NAME = process.argv[2] || '保乐肩'

;(async () => {
  console.log(`\n=== 追踪 SKU: contains "${NAME}" ===\n`)

  const prods = await p.product.findMany({
    where: { name: { contains: NAME } },
    include: { supplier: { select: { name: true } }, tenant: { select: { slug: true } } },
  })
  console.log(`找到 ${prods.length} 条 Product:`)
  for (const r of prods) {
    console.log(`  [${r.tenant?.slug}] [${r.supplier?.name?.slice(0,15)}] ${r.name}`)
    console.log(`    id=${r.id} unit=${r.unit} price=${r.price} stock=${r.stock} created=${r.createdAt.toISOString().slice(0,16)}`)
  }

  for (const r of prods) {
    if (r.tenant?.slug !== 'dianjie') continue
    console.log(`\n--- 追踪 dianjie [${r.name}] id=${r.id.slice(0,10)} 当前 stock=${r.stock} ---`)

    const movs = await p.supplierStockMovement.findMany({
      where: { productId: r.id },
      orderBy: { createdAt: 'asc' },
      select: { delta: true, balanceAfter: true, type: true, reason: true, createdAt: true, sourceType: true, sourceId: true },
    })
    console.log(`  StockMovement ${movs.length} 条:`)
    let sum = 0
    movs.forEach((m) => {
      sum += Number(m.delta)
      console.log(`    ${m.createdAt.toISOString().slice(0,16)} delta=${m.delta} → ${m.balanceAfter} | ${m.type} ${m.sourceType || ''} | ${m.reason || ''}`)
    })
    console.log(`  delta 累加 = ${sum}  (理论上 = 当前 stock 如果初始为 0; 否则 当前 - 初始 = 累加)`)

    const items = await p.purchaseOrderItem.findMany({
      where: { productId: r.id },
      include: { purchaseOrder: { select: { no: true, status: true, createdAt: true } } },
    })
    console.log(`  PurchaseOrderItem ${items.length} 条:`)
    items.forEach((it) => {
      console.log(`    ${it.purchaseOrder?.createdAt?.toISOString().slice(0,16)} [${it.purchaseOrder?.status}] ${it.purchaseOrder?.no} 订 ${it.quantity} 实发 ${it.shippedQty ?? '-'} 单价 ${it.price}`)
    })

    const lcItems = await p.lossClaimItem.findMany({
      where: { productId: r.id },
      include: { lossClaim: { select: { no: true, status: true } } },
    })
    if (lcItems.length) {
      console.log(`  LossClaimItem ${lcItems.length} 条:`)
      lcItems.forEach((lc) => console.log(`    [${lc.lossClaim.status}] ${lc.lossClaim.no} 损 ${lc.lossQty}`))
    }
  }

  await p.$disconnect()
})().catch((e) => { console.error(e); process.exit(1) })
