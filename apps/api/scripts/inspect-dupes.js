require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const targets = ['保乐肩（M2安格斯）', '冻青头', '米布粉', '青芒酸木瓜汁（果汁包）']
  for (const t of targets) {
    const rs = await p.product.findMany({
      where: { name: t },
      select: { id: true, name: true, stock: true, price: true, supplierId: true, tenantId: true, createdAt: true },
    })
    console.log(`\n「${t}」 ${rs.length} 条:`)
    rs.forEach((r) => console.log(`  id=${r.id.slice(0,10)} sup=${r.supplierId?.slice(0,10)} tenant=${r.tenantId?.slice(0,10)} stock=${r.stock} price=${r.price} ${r.createdAt}`))
  }
  await p.$disconnect()
})()
