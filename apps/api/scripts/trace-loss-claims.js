require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const tenant = await p.tenant.findFirst({ where: { slug: 'dianjie' } })
  const claims = await p.lossClaim.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: 'desc' },
    include: {
      items: { include: { product: { select: { name: true } } } },
      purchaseOrder: { select: { no: true } },
      handledBy: { select: { name: true } },
    },
  })
  console.log(`报损单 ${claims.length} 条:\n`)
  for (const c of claims) {
    console.log(`【${c.no}】 ${c.status}  PO=${c.purchaseOrder?.no}  总额=¥${c.totalLossAmount}`)
    console.log(`  created=${c.createdAt.toISOString().slice(0,16)}`)
    console.log(`  updated=${c.updatedAt.toISOString().slice(0,16)}`)
    if (c.handledAt) console.log(`  handled=${c.handledAt.toISOString().slice(0,16)} by ${c.handledBy?.name || '?'}`)
    if (c.handlerNote) console.log(`  note=${c.handlerNote}`)
    c.items.forEach(it => console.log(`    - ${it.product?.name} 损 ${it.lossQty} = ¥${it.lossAmount}`))
  }
  await p.$disconnect()
})()
