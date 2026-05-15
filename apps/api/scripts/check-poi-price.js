require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const tenant = await p.tenant.findFirst({ where: { slug: 'dianjie' } })
  const items = await p.purchaseOrderItem.findMany({
    where: { purchaseOrder: { tenantId: tenant.id } },
    include: { product: { select: { name: true, price: true } } },
  })
  console.log(`PurchaseOrderItem 共 ${items.length} 条:\n`)
  let mismatch = 0, nullPrice = 0
  for (const it of items) {
    const snap = Number(it.unitPrice)
    const cur = Number(it.product?.price)
    const drift = Math.abs(snap - cur)
    const flag = !it.unitPrice ? '❌ NULL' : drift > 0.01 ? `⚠ snap=${snap} cur=${cur}` : '✓'
    if (!it.unitPrice) nullPrice++
    if (drift > 0.01) mismatch++
    console.log(`  ${flag} ${it.product?.name?.slice(0, 30)?.padEnd(30)} qty=${it.quantity} snap=${it.unitPrice} cur_product=${cur} amt=${it.amount}`)
  }
  console.log(`\n汇总: null snapshot ${nullPrice}, 价格漂移 ${mismatch}`)
  await p.$disconnect()
})()
