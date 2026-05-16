require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: 'test' } })
  const sc = await p.stockConsumption.findMany({
    where: { tenantId: t.id, sourceType: 'dish_sale' },
    include: { product: { select: { name: true, unit: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  console.log(`dish_sale 来源消耗记录: ${sc.length} 条`)
  for (const c of sc) {
    console.log(`  ${c.date.toISOString().slice(0,10)} ${c.product.name} ${c.quantity} ${c.product.unit}  src=${c.sourceId.slice(0,10)} note="${c.note}"`)
  }
  const allDishSale = await p.dishSale.findMany({
    where: { tenantId: t.id },
    select: { id: true, quantity: true, date: true, dish: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  console.log(`\nDishSale 记录: ${allDishSale.length} 条`)
  for (const s of allDishSale) {
    console.log(`  ${s.id.slice(0,10)} ${s.dish.name} ${s.quantity} 份 ${s.date.toISOString().slice(0,10)}`)
  }
  await p.$disconnect()
})()
