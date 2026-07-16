/** Read-only audit for physical-count-based store inventory estimates. */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { estimatedStoreInventory } from '../src/services/storeInventory'

async function main() {
  const tenantSlug = process.argv.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const storeNo = process.argv.find(arg => arg.startsWith('--store='))?.slice('--store='.length) || 'DJ001'
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: storeNo } },
  })
  const estimate = await estimatedStoreInventory(tenant.id, store.id)
  const snapshot = await prisma.inventorySnapshot.findFirstOrThrow({
    where: { tenantId: tenant.id, storeId: store.id },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })
  const openingDate = dayjs(snapshot.snapshotDate).add(1, 'day').toDate()
  const consumptions = await prisma.stockConsumption.findMany({
    where: { tenantId: tenant.id, storeId: store.id, date: { gte: openingDate } },
    orderBy: [{ date: 'asc' }, { productId: 'asc' }],
    select: { productId: true, date: true, quantity: true, sourceType: true, sourceId: true, note: true },
  })
  const baselineByProduct = new Map<string, typeof snapshot.items>()
  for (const item of snapshot.items) {
    if (!item.productId) continue
    baselineByProduct.set(item.productId, [...(baselineByProduct.get(item.productId) || []), item])
  }
  const consumptionByProduct = new Map<string, typeof consumptions>()
  for (const item of consumptions) {
    consumptionByProduct.set(item.productId, [...(consumptionByProduct.get(item.productId) || []), item])
  }
  const negative = estimate.items
    .filter(item => item.hasDataIssue)
    .sort((a, b) => a.stock - b.stock)
    .map(item => ({
      code: item.code,
      name: item.name,
      spec: item.spec,
      unit: item.unit,
      estimatedStock: item.stock,
      monthIn: item.monthIn,
      monthOut: item.monthOut,
      avgUnitCost: item.avgUnitCost,
      baseline: (baselineByProduct.get(item.id) || []).map(row => ({
        rawName: row.rawName,
        rawQuantity: Number(row.quantity),
        rawUnit: row.unit,
        normalizedQuantity: row.normalizedQuantity == null ? null : Number(row.normalizedQuantity),
        normalizedUnit: row.normalizedUnit,
        normalizationStatus: row.normalizationStatus,
      })),
      consumptions: (consumptionByProduct.get(item.id) || []).map(row => ({
        date: row.date.toISOString().slice(0, 10),
        quantity: Number(row.quantity),
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        note: row.note,
      })),
    }))
  const normalizationPending = snapshot.items
    .filter(item => item.productId && item.normalizationStatus === 'PENDING')
    .map(item => ({ rawName: item.rawName, rawSpec: item.rawSpec, unit: item.unit, quantity: Number(item.quantity) }))
  console.log(JSON.stringify({
    tenant: tenant.slug,
    store: { no: store.no, name: store.name },
    summary: estimate.summary,
    normalizationPending,
    negativeCount: negative.length,
    negative,
  }, null, 2))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
