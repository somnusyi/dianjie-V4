/** Bind explicitly reviewed physical-count rows to purchasing SKUs. */
import 'dotenv/config'
import fs from 'node:fs/promises'
import { prisma } from '@dianjie/db'
import { normalizeInventoryQuantity } from '../src/services/inventoryUnits'

type BindingPayload = {
  tenantSlug: string
  targetStoreNo: string
  bindings: Array<{ rawName: string; productCode: string; note?: string }>
}

async function main() {
  const args = process.argv.slice(2)
  const payloadPath = args.find(arg => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  const confirm = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (!payloadPath) throw new Error('请传入绑定 JSON')
  if (commit && confirm !== 'bind-reviewed-snapshot-products') throw new Error('写入需 --confirm=bind-reviewed-snapshot-products')
  const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8')) as BindingPayload
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: payload.tenantSlug } })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: payload.targetStoreNo } },
  })
  const snapshot = await prisma.inventorySnapshot.findFirstOrThrow({
    where: { tenantId: tenant.id, storeId: store.id },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: { items: true },
  })
  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id, code: { in: payload.bindings.map(row => row.productCode) } },
  })
  const byCode = new Map(products.map(product => [product.code, product]))
  const rows = payload.bindings.map(binding => {
    const matches = snapshot.items.filter(item => item.rawName === binding.rawName)
    if (matches.length !== 1) throw new Error(`盘点品项 ${binding.rawName} 应唯一，实际 ${matches.length}`)
    const product = byCode.get(binding.productCode)
    if (!product) throw new Error(`商品编码不存在: ${binding.productCode}`)
    const item = matches[0]
    const normalization = normalizeInventoryQuantity({
      quantity: Number(item.quantity), rawUnit: item.unit, rawSpec: item.rawSpec,
      productUnit: product.unit, productSpec: product.spec,
    })
    if (normalization.status === 'PENDING') throw new Error(`${binding.rawName} 无法换算: ${normalization.note}`)
    return { binding, item, product, normalization }
  })
  console.log(JSON.stringify({
    mode: commit ? 'commit' : 'dry-run', tenant: tenant.slug, store: { no: store.no, name: store.name },
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    rows: rows.map(row => ({
      rawName: row.item.rawName, rawQuantity: Number(row.item.quantity), rawUnit: row.item.unit,
      productCode: row.product.code, productName: row.product.name,
      normalizedQuantity: row.normalization.normalizedQuantity, normalizedUnit: row.normalization.normalizedUnit,
      note: row.binding.note,
    })),
  }, null, 2))
  if (!commit) return
  await prisma.$transaction(async tx => {
    for (const row of rows) {
      await tx.inventorySnapshotItem.update({
        where: { id: row.item.id },
        data: {
          productId: row.product.id,
          normalizedQuantity: row.normalization.normalizedQuantity,
          normalizedUnit: row.normalization.normalizedUnit,
          normalizationFactor: row.normalization.factor,
          normalizationStatus: row.normalization.status,
          normalizationNote: `${row.normalization.note}${row.binding.note ? `；${row.binding.note}` : ''}`,
        },
      })
    }
    await tx.inventorySnapshot.update({
      where: { id: snapshot.id },
      data: { matchedCount: await tx.inventorySnapshotItem.count({ where: { snapshotId: snapshot.id, productId: { not: null } } }) },
    })
  })
  console.log(JSON.stringify({ ok: true, bound: rows.length }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
