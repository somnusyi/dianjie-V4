/** Read-only invariants for the purchasing-unit -> inventory-base-unit migration. */
import 'dotenv/config'
import { prisma } from '@dianjie/db'

function number(value: unknown) {
  return Number(value ?? 0)
}

async function main() {
  const tenantSlug = process.argv.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || 'dianjie'
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const [products, receipts, recipes, bomItems, snapshots, consumptions, manualLosses, stores] = await Promise.all([
    prisma.product.findMany({ where: { tenantId: tenant.id } }),
    prisma.receiptItem.findMany({ where: { receipt: { tenantId: tenant.id } } }),
    prisma.dishRecipe.findMany({ where: { dish: { tenantId: tenant.id } }, include: { product: true, dish: { select: { name: true } } } }),
    prisma.dishBomItem.findMany({ where: { version: { tenantId: tenant.id } }, include: { product: true, version: { include: { dish: { select: { name: true } } } } } }),
    prisma.inventorySnapshotItem.findMany({ where: { snapshot: { tenantId: tenant.id }, productId: { not: null } }, include: { product: true } }),
    prisma.stockConsumption.findMany({ where: { tenantId: tenant.id }, include: { product: true } }),
    prisma.lossClaimItem.findMany({ where: { lossClaim: { tenantId: tenant.id, isManual: true } }, include: { product: true } }),
    prisma.store.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true } }),
  ])
  const productById = new Map(products.map(product => [product.id, product]))
  const missingContracts = products.filter(product => !product.inventoryUnit || !(number(product.inventoryUnitsPerPurchaseUnit) > 0))
  const pending = products.filter(product => product.unitConversionStatus === 'PENDING')
  const inferred = products.filter(product => product.unitConversionStatus === 'INFERRED')

  const receiptErrors = receipts.flatMap(row => {
    const product = productById.get(row.productId)
    if (!product || row.inventoryQuantity == null || !row.inventoryUnitSnapshot
      || row.inventoryUnitsPerPurchaseUnitSnapshot == null || row.inventoryUnitCostSnapshot == null) {
      return [{ id: row.id, reason: 'missing snapshot' }]
    }
    // Linked supply-chain receipts hold quantity in the order unit and freeze
    // all three factors. Historical/manual rows predate that snapshot and keep
    // the original purchase-factor invariant.
    const quantityFactor = row.inventoryUnitsPerOrderUnitSnapshot
      ?? row.inventoryUnitsPerPurchaseUnitSnapshot
    const expectedQuantity = number(row.quantity) * number(quantityFactor)
    const quantityDrift = Math.abs(number(row.inventoryQuantity) - expectedQuantity)
    const valueDrift = Math.abs(number(row.amount) - number(row.inventoryQuantity) * number(row.inventoryUnitCostSnapshot))
    return quantityDrift > 0.000001 || valueDrift > 0.011
      ? [{ id: row.id, reason: `quantity drift=${quantityDrift}, value drift=${valueDrift}` }]
      : []
  })
  const recipeErrors = recipes.filter(row => !row.product.inventoryUnit || row.unit !== row.product.inventoryUnit)
    .map(row => ({ id: row.id, dish: row.dish.name, unit: row.unit, expected: row.product.inventoryUnit }))
  const bomErrors = bomItems.filter(row => !row.product.inventoryUnit || row.unit !== row.product.inventoryUnit)
    .map(row => ({ id: row.id, dish: row.version.dish.name, unit: row.unit, expected: row.product.inventoryUnit }))
  const snapshotErrors = snapshots.filter(row => row.normalizedQuantity == null || !row.product?.inventoryUnit
      || row.normalizedUnit !== row.product.inventoryUnit)
    .map(row => ({ id: row.id, rawName: row.rawName, unit: row.normalizedUnit, expected: row.product?.inventoryUnit }))
  const consumptionErrors = consumptions.filter(row => row.inventoryQuantity == null || !row.product.inventoryUnit
      || row.inventoryUnitSnapshot !== row.product.inventoryUnit)
    .map(row => ({ id: row.id, product: row.product.name, unit: row.inventoryUnitSnapshot, expected: row.product.inventoryUnit }))
  const manualLossErrors = manualLosses.filter(row => row.inventoryQuantity == null || !row.product.inventoryUnit
      || row.inventoryUnitSnapshot !== row.product.inventoryUnit)
    .map(row => ({ id: row.id, product: row.product.name, unit: row.inventoryUnitSnapshot, expected: row.product.inventoryUnit }))

  const uncostedByStore: Array<{ store: string; after: string; count: number }> = []
  for (const store of stores) {
    const baseline = await prisma.inventorySnapshot.findFirst({
      where: { tenantId: tenant.id, storeId: store.id }, orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    })
    if (!baseline) continue
    const after = new Date(baseline.snapshotDate)
    after.setUTCDate(after.getUTCDate() + 1)
    const count = await prisma.stockConsumption.count({
      where: { tenantId: tenant.id, storeId: store.id, date: { gte: after }, costAmountSnapshot: null },
    })
    if (count > 0) uncostedByStore.push({ store: store.name, after: after.toISOString().slice(0, 10), count })
  }

  const exactProducts = products.filter(product => ['ZZ9M-2DYL8C', 'ZZ9M-2DYLBF'].includes(product.code))
    .map(product => ({ code: product.code, name: product.name, purchaseUnit: product.unit,
      inventoryUnit: product.inventoryUnit, factor: number(product.inventoryUnitsPerPurchaseUnit), status: product.unitConversionStatus }))
  const report = {
    ok: missingContracts.length === 0 && pending.length === 0 && receiptErrors.length === 0
      && recipeErrors.length === 0 && bomErrors.length === 0 && snapshotErrors.length === 0
      && consumptionErrors.length === 0 && manualLossErrors.length === 0 && uncostedByStore.length === 0,
    tenant: tenant.slug,
    totals: { products: products.length, receipts: receipts.length, recipes: recipes.length, bomItems: bomItems.length,
      snapshots: snapshots.length, consumptions: consumptions.length, manualLosses: manualLosses.length },
    governance: { missingContracts: missingContracts.length, pending: pending.length, inferred: inferred.length,
      inferredSample: inferred.slice(0, 20).map(product => ({ code: product.code, name: product.name, unit: product.unit })) },
    errors: { receiptErrors: receiptErrors.slice(0, 20), recipeErrors: recipeErrors.slice(0, 20),
      bomErrors: bomErrors.slice(0, 20), snapshotErrors: snapshotErrors.slice(0, 20),
      consumptionErrors: consumptionErrors.slice(0, 20), manualLossErrors: manualLossErrors.slice(0, 20), uncostedByStore },
    exactProducts,
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

main().finally(() => prisma.$disconnect())
