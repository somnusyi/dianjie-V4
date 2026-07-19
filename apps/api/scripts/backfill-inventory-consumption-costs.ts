/** Rebuild moving-average cost snapshots after unit migration. Requires explicit confirmation. */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { revalueStoreConsumptionCosts } from '../src/services/inventoryCosting'

async function main() {
  const args = process.argv.slice(2)
  if (!args.includes('--commit') || !args.includes('--confirm=inventory-cost-backfill')) {
    throw new Error('写入必须提供 --commit --confirm=inventory-cost-backfill')
  }
  const tenantSlug = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const stores = await prisma.store.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true } })
  const results = []
  for (const store of stores) {
    results.push({ store: store.name, ...(await revalueStoreConsumptionCosts(tenant.id, store.id)) })
  }
  console.log(JSON.stringify({ ok: true, tenant: tenant.slug, results }, null, 2))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
