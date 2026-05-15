require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
;(async () => {
  const tenant = await p.tenant.findFirst({ where: { slug: 'dianjie' } })
  const all = await p.product.count({
    where: { tenantId: tenant.id, supplierId: { not: null }, NOT: { name: { endsWith: '[已合并]' } } },
  })
  const zeroOrderable = await p.product.findMany({
    where: {
      tenantId: tenant.id,
      supplierId: { not: null },
      stock: { lte: 0 },
      price: { gt: 0 },
      NOT: { name: { endsWith: '[已合并]' } },
    },
    select: { name: true, stock: true, price: true, unit: true, category: true },
    orderBy: { price: 'desc' },
  })
  console.log(`总 SKU: ${all}, 其中 stock<=0 且 price>0 (可下单但供应商断货): ${zeroOrderable.length}\n`)
  const byCat = {}
  zeroOrderable.forEach((p) => { byCat[p.category || '未分类'] = (byCat[p.category || '未分类'] || 0) + 1 })
  console.log('按品类分布:')
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`))
  console.log('\nTop 30 高单价缺货:')
  zeroOrderable.slice(0, 30).forEach((p) => console.log(`  ¥${p.price}/${p.unit} ${p.name}  (stock=${p.stock})`))
  await p.$disconnect()
})()
