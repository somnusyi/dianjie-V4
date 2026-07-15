import 'dotenv/config'
import assert from 'node:assert/strict'
import { prisma } from '@dianjie/db'
import { estimatedStoreInventory } from '../src/services/storeInventory'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 库存主数据验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function main() {
  assertLocalOnly()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'yaohai-test' } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id, no: 'YH001' } })
  const snapshot = await prisma.inventorySnapshot.findFirstOrThrow({
    where: { tenantId: tenant.id, storeId: store.id },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: { items: { select: { productId: true } } },
  })
  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id, code: { startsWith: 'YH001-INV-' } },
    select: { id: true, supplierId: true, stock: true },
  })
  const estimate = await estimatedStoreInventory(tenant.id, store.id)

  assert.equal(snapshot.itemCount, 167)
  assert.equal(snapshot.matchedCount, 167)
  assert.equal(snapshot.items.filter(item => item.productId).length, 167)
  assert.equal(products.length, 167)
  assert.equal(products.filter(product => product.supplierId).length, 0, '未确认供应商前不得虚构商品归属')
  assert.equal(products.reduce((sum, product) => sum + Number(product.stock), 0), 0, '门店盘点不得写入供应商库存')
  assert.equal(estimate.summary.itemCount, 167)
  assert.equal(estimate.summary.nonzeroCount, 126)
  assert.equal(estimate.summary.zeroCount, 41)
  assert.ok(Math.abs(Number(estimate.summary.totalValue) - 31649.586) < 0.001)

  console.log(JSON.stringify({
    ok: true,
    products: products.length,
    matched: snapshot.matchedCount,
    estimatedItems: estimate.summary.itemCount,
    nonzero: estimate.summary.nonzeroCount,
    zero: estimate.summary.zeroCount,
    estimatedValue: estimate.summary.totalValue,
    supplierStock: 0,
  }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
