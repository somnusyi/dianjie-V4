/**
 * P2 历史回填：台账 sourceName 文本 → supplierId 结构化。
 *
 * 匹配逻辑与增量解析一致（services/supplierAliases）：
 * 1) 精确匹配供应商档案名（ENABLED 优先，双 ENABLED 同名视为歧义跳过）
 * 2) 命中供应商名称别名表
 * 多供应商拼合文本（含「、」）和多义名不猜，留在待认领队列。
 *
 * 用法：
 *   预览：npx tsx scripts/backfill-ledger-supplier.ts --tenant=dianjie
 *   写入：npx tsx scripts/backfill-ledger-supplier.ts --tenant=dianjie --commit --confirm=ledger-supplier-backfill
 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { resolveSupplierIdsByNames } from '../src/services/supplierAliases'

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  if (commit && !args.includes('--confirm=ledger-supplier-backfill')) {
    throw new Error('写入必须提供 --commit --confirm=ledger-supplier-backfill')
  }
  const tenantSlug = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })

  const grouped = await prisma.warehouseLedgerMovement.groupBy({
    by: ['sourceName'],
    where: { tenantId: tenant.id, type: 'MANUAL_INBOUND', supplierId: null, sourceName: { not: null } },
    _count: { _all: true },
  })
  const names = grouped.map(row => String(row.sourceName || '').trim()).filter(Boolean)
  const resolved = await resolveSupplierIdsByNames(tenant.id, names)

  const plan = grouped.map(row => {
    const name = String(row.sourceName || '').trim()
    const supplierId = resolved.get(name) || null
    return {
      sourceName: name,
      rows: row._count._all,
      supplierId,
      action: supplierId ? 'backfill' : (name.includes('、') ? 'skip-multi-supplier' : 'skip-unclaimed'),
    }
  })
  const fillable = plan.filter(item => item.supplierId)
  const totalRows = fillable.reduce((sum, item) => sum + item.rows, 0)

  if (!commit) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', tenant: tenant.slug, names: names.length, fillableNames: fillable.length, fillableRows: totalRows, plan }, null, 2))
    return
  }

  const results = []
  for (const item of fillable) {
    const result = await prisma.warehouseLedgerMovement.updateMany({
      where: { tenantId: tenant.id, type: 'MANUAL_INBOUND', supplierId: null, sourceName: item.sourceName },
      data: { supplierId: item.supplierId! },
    })
    results.push({ sourceName: item.sourceName, supplierId: item.supplierId, updated: result.count })
  }
  await prisma.opLog.create({
    data: {
      tenantId: tenant.id,
      userId: null,
      action: `台账供应商历史回填：${results.length} 个来源名 / ${results.reduce((sum, item) => sum + item.updated, 0)} 行`,
      target: 'ledger-supplier-backfill',
      entityType: 'WarehouseLedgerMovement',
      targetId: 'ledger-supplier-backfill',
      metadata: { script: 'backfill-ledger-supplier', results },
    },
  })
  console.log(JSON.stringify({ ok: true, mode: 'commit', tenant: tenant.slug, results, skipped: plan.filter(item => !item.supplierId) }, null, 2))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
