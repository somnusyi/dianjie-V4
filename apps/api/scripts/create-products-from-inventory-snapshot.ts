/**
 * 从最近一次门店实物盘点建立商品主数据，并把盘点明细逐行绑定到商品。
 *
 * 默认 dry-run；增加 --commit 才写库。
 * 本脚本只允许本地 PREVIEW_MODE 隔离库运行，避免误写生产。
 *
 * Usage:
 *   PREVIEW_MODE=true DATABASE_URL=... pnpm --filter @dianjie/api exec tsx \
 *     scripts/create-products-from-inventory-snapshot.ts --tenant=yaohai-test --store=瑶海 --commit
 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 商品主数据导入仅允许本地 PREVIEW_MODE 隔离库')
  }
}

function normalize(value: string | null | undefined) {
  return String(value || '').normalize('NFKC').replace(/[\s·・]/g, '').toLowerCase()
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function quantityStep(unit: string) {
  return ['斤', 'kg', '公斤', '千克', '克', 'g', '升', 'l', '毫升', 'ml'].includes(unit.toLowerCase()) ? 0.1 : 1
}

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  const tenantSlug = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'yaohai-test'
  const storeKeyword = args.find(arg => arg.startsWith('--store='))?.slice('--store='.length) || '瑶海'
  if (commit) assertLocalOnly()

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const stores = await prisma.store.findMany({
    where: { tenantId: tenant.id, name: { contains: storeKeyword } },
    select: { id: true, no: true, name: true },
  })
  if (stores.length !== 1) throw new Error(`期望唯一门店，实际 ${stores.length} 家: ${stores.map(store => store.name).join(', ')}`)
  const store = stores[0]
  const snapshot = await prisma.inventorySnapshot.findFirst({
    where: { tenantId: tenant.id, storeId: store.id },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })
  if (!snapshot) throw new Error('该门店没有实物盘点基准')

  const existingProducts = await prisma.product.findMany({ where: { tenantId: tenant.id } })
  const byFingerprint = new Map<string, typeof existingProducts>()
  const byCode = new Map(existingProducts.map(product => [product.code, product]))
  for (const product of existingProducts) {
    const fingerprint = [normalize(product.name), normalize(product.spec), normalize(product.unit)].join('|')
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) || []), product])
  }

  const prefix = `${store.no.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}-INV`
  const assignments = snapshot.items.map(item => {
    const fingerprint = [normalize(item.rawName), normalize(item.rawSpec), normalize(item.unit)].join('|')
    const exact = byFingerprint.get(fingerprint) || []
    const code = `${prefix}-${String(item.sortOrder).padStart(4, '0')}`
    if (exact.length > 1) throw new Error(`同名同规格商品不唯一: ${item.rawName} ${item.rawSpec || ''}`)
    const coded = byCode.get(code)
    if (coded && normalize(coded.name) !== normalize(item.rawName)) {
      throw new Error(`商品编码冲突: ${code} 已被 ${coded.name} 使用，不能覆盖为 ${item.rawName}`)
    }
    return {
      item,
      productId: exact[0]?.id || coded?.id || null,
      code,
      action: exact[0] || coded ? 'REUSE' as const : 'CREATE' as const,
    }
  })

  const report = {
    mode: commit ? 'commit' : 'dry-run',
    tenant: tenant.slug,
    store: store.name,
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    sourceFilename: snapshot.sourceFilename,
    items: assignments.length,
    reuse: assignments.filter(item => item.action === 'REUSE').length,
    create: assignments.filter(item => item.action === 'CREATE').length,
    supplierPending: assignments.filter(item => item.action === 'CREATE').length,
    openingValue: Number(snapshot.totalValue),
    samples: assignments.slice(0, 8).map(({ item, code, action }) => ({
      code, action, name: item.rawName, spec: item.rawSpec, unit: item.unit, price: Number(item.unitPrice), category: item.section || '其他',
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!commit) return

  await prisma.$transaction(async tx => {
    for (const assignment of assignments) {
      let productId = assignment.productId
      if (!productId) {
        const item = assignment.item
        const step = quantityStep(item.unit)
        const created = await tx.product.create({
          data: {
            tenantId: tenant.id,
            code: assignment.code,
            name: item.rawName,
            spec: item.rawSpec,
            category: item.section || '其他',
            unit: item.unit,
            price: roundMoney(Number(item.unitPrice)),
            stock: 0,
            minStock: 0,
            minOrderQty: step,
            stepQty: step,
            shelfDays: 7,
            supplierId: null,
            status: 'ENABLED',
          },
        })
        productId = created.id
      }
      await tx.inventorySnapshotItem.update({ where: { id: assignment.item.id }, data: { productId } })
    }
    await tx.inventorySnapshot.update({ where: { id: snapshot.id }, data: { matchedCount: assignments.length } })
  }, { timeout: 60_000 })

  console.log(JSON.stringify({ ok: true, matchedCount: assignments.length, created: report.create, reused: report.reuse }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
