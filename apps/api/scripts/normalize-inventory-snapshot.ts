/**
 * 将最近一次盘点的原始单位换算到采购 SKU 单位。
 * 默认 dry-run；写入需要 --commit 和 --confirm=normalize-snapshot-units。
 * 原始 quantity/unit/spec 永不覆盖，所有换算均可审计和重复执行。
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @dianjie/api exec tsx scripts/normalize-inventory-snapshot.ts \
 *     --tenant=dianjie --store-no=DJ001
 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { normalizeInventoryQuantity } from '../src/services/inventoryUnits'

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  const confirm = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  const tenantSlug = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const storeNo = args.find(arg => arg.startsWith('--store-no='))?.slice('--store-no='.length)
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置')
  if (!storeNo) throw new Error('必须显式传入 --store-no，禁止按重名门店写库存')
  if (commit && confirm !== 'normalize-snapshot-units') {
    throw new Error('写入需增加 --confirm=normalize-snapshot-units')
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: storeNo } },
    select: { id: true, no: true, name: true },
  })
  const snapshot = await prisma.inventorySnapshot.findFirst({
    where: { tenantId: tenant.id, storeId: store.id },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { product: { select: { id: true, code: true, name: true, spec: true, unit: true } } },
      },
    },
  })
  if (!snapshot) throw new Error('目标门店没有盘点快照')

  const rows = snapshot.items.map(item => {
    if (!item.product) {
      return { item, result: null, status: 'UNMATCHED' as const, note: '未绑定采购SKU' }
    }
    const result = normalizeInventoryQuantity({
      quantity: Number(item.quantity),
      rawUnit: item.unit,
      rawSpec: item.rawSpec,
      productUnit: item.product.unit,
      productSpec: item.product.spec,
    })
    return { item, result, status: result.status, note: result.note }
  })

  const report = {
    mode: commit ? 'commit' : 'dry-run',
    tenant: tenant.slug,
    store,
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    total: rows.length,
    unmatched: rows.filter(row => row.status === 'UNMATCHED').length,
    exact: rows.filter(row => row.status === 'EXACT').length,
    converted: rows.filter(row => row.status === 'CONVERTED').length,
    pending: rows.filter(row => row.status === 'PENDING').length,
    pendingRows: rows.filter(row => row.status === 'PENDING').map(row => ({
      name: row.item.rawName,
      raw: `${row.item.quantity} ${row.item.unit} / ${row.item.rawSpec || '-'}`,
      product: row.item.product ? `${row.item.product.name} ${row.item.product.unit} / ${row.item.product.spec || '-'}` : null,
      note: row.note,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!commit) return

  await prisma.$transaction(async tx => {
    for (const row of rows) {
      if (!row.result) continue
      await tx.inventorySnapshotItem.update({
        where: { id: row.item.id },
        data: {
          normalizedQuantity: row.result.normalizedQuantity,
          normalizedUnit: row.result.normalizedUnit,
          normalizationFactor: row.result.factor,
          normalizationStatus: row.result.status,
          normalizationNote: row.result.note,
        },
      })
    }
  }, { timeout: 60_000 })
  console.log(JSON.stringify({ ok: true, updated: rows.filter(row => row.result).length, pending: report.pending }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
