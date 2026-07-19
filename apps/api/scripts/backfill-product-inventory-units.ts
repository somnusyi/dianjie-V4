/** Backfill purchasing-unit -> inventory-base-unit contracts. Dry-run by default. */
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Prisma, prisma } from '@dianjie/db'
import { normalizeDishName } from '../src/services/dailyBusinessImport'
import { physicalAmountPerPackage } from '../src/services/inventoryUnits'

type CatalogItem = {
  productCode: string
  productName: string
  productUnit: string
  quantity: number
  rawQuantity: number
  rawUnit: string
}
type CatalogRule = { dishName: string; variantKey: string; policy: string; items: CatalogItem[] }
type Catalog = { tenantSlug: string; rules: CatalogRule[] }
type Mapping = {
  inventoryUnit: string
  factor: number
  status: 'INFERRED' | 'VERIFIED'
  note: string
}

function baseQuantity(quantity: number, unit: string) {
  const normalized = unit.trim().toLowerCase()
  if (normalized === 'kg' || normalized === '公斤' || normalized === '千克') return { quantity: quantity * 1000, unit: 'g' }
  if (normalized === '斤') return { quantity: quantity * 500, unit: 'g' }
  if (normalized === '克' || normalized === 'g') return { quantity, unit: 'g' }
  if (normalized === 'l' || normalized === '升') return { quantity: quantity * 1000, unit: 'ml' }
  if (normalized === '毫升' || normalized === 'ml') return { quantity, unit: 'ml' }
  return { quantity, unit: unit.trim() }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function directPhysicalMapping(unit: string): Mapping | null {
  const base = baseQuantity(1, unit)
  if (base.unit === unit.trim() && base.quantity === 1) return null
  return { inventoryUnit: base.unit, factor: base.quantity, status: 'VERIFIED', note: '物理计量单位标准换算' }
}

function catalogMappings(catalog: Catalog) {
  const evidence = new Map<string, Array<{ factor: number; unit: string }>>()
  for (const item of catalog.rules.filter(rule => rule.policy === 'BOM').flatMap(rule => rule.items)) {
    if (!(item.quantity > 0) || !(item.rawQuantity > 0)) continue
    const raw = baseQuantity(item.rawQuantity, item.rawUnit)
    const rows = evidence.get(item.productCode) || []
    rows.push({ factor: raw.quantity / item.quantity, unit: raw.unit })
    evidence.set(item.productCode, rows)
  }
  const mappings = new Map<string, Mapping>()
  for (const [code, rows] of evidence) {
    const units = new Set(rows.map(row => row.unit))
    if (units.size !== 1) continue
    const factor = median(rows.map(row => row.factor))
    mappings.set(code, {
      inventoryUnit: rows[0].unit,
      factor,
      status: 'VERIFIED',
      note: `由已审核菜品 BOM 的 ${rows.length} 条原始用量核验`,
    })
  }
  // 客户已明确的包装换算。
  mappings.set('ZZ9M-2DYL8C', { inventoryUnit: '个', factor: 18, status: 'VERIFIED', note: '客户确认：生蚝 1箱=18个' })
  mappings.set('ZZ9M-2DYLBF', { inventoryUnit: '罐', factor: 6, status: 'VERIFIED', note: '客户确认：乌苏 1箱=6罐' })
  return mappings
}

async function main() {
  const args = process.argv.slice(2)
  const commit = args.includes('--commit')
  const confirmation = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (commit && confirmation !== 'inventory-unit-backfill') {
    throw new Error('写入必须提供 --commit --confirm=inventory-unit-backfill')
  }
  const requestedCatalog = args.find(arg => arg.startsWith('--catalog='))?.slice('--catalog='.length)
  const defaultCandidates = [
    path.resolve(process.cwd(), 'data/yaohai-reviewed-dish-recipes.json'),
    path.resolve(process.cwd(), 'apps/api/data/yaohai-reviewed-dish-recipes.json'),
  ]
  const catalogPath = requestedCatalog || await (async () => {
    for (const candidate of defaultCandidates) {
      try { await fs.access(candidate); return candidate } catch { /* try next package-root shape */ }
    }
    throw new Error(`找不到已审核 BOM 目录：${defaultCandidates.join(' / ')}`)
  })()
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as Catalog
  const tenantSlug = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length) || catalog.tenantSlug
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const [products, dishes, recipes, bomItems, receiptItems, snapshotItems, consumptions, manualLossItems] = await Promise.all([
    prisma.product.findMany({ where: { tenantId: tenant.id } }),
    prisma.dish.findMany({ where: { tenantId: tenant.id } }),
    prisma.dishRecipe.findMany({ where: { dish: { tenantId: tenant.id } }, include: { product: true, dish: true } }),
    prisma.dishBomItem.findMany({ where: { version: { tenantId: tenant.id } }, include: { product: true, version: { include: { dish: true } } } }),
    prisma.receiptItem.findMany({ where: { receipt: { tenantId: tenant.id } }, include: { product: true } }),
    prisma.inventorySnapshotItem.findMany({ where: { snapshot: { tenantId: tenant.id }, productId: { not: null } }, include: { product: true } }),
    prisma.stockConsumption.findMany({ where: { tenantId: tenant.id }, include: { product: true } }),
    prisma.lossClaimItem.findMany({ where: { lossClaim: { tenantId: tenant.id, isManual: true } }, include: { product: true } }),
  ])
  const evidenceMappings = catalogMappings(catalog)
  const mappings = new Map<string, Mapping>()
  for (const product of products) {
    const reviewed = evidenceMappings.get(product.code)
    if (reviewed) {
      // If conflicting rounded catalog rows exist, the audited package spec is
      // more reliable than the median of already-converted legacy quantities.
      const physical = physicalAmountPerPackage(product.spec)
      if (physical && ((physical.dimension === 'mass' && reviewed.inventoryUnit === 'g')
        || (physical.dimension === 'volume' && reviewed.inventoryUnit === 'ml'))) {
        mappings.set(product.id, {
          inventoryUnit: reviewed.inventoryUnit,
          factor: physical.value,
          status: 'VERIFIED',
          note: `${reviewed.note}；并与采购规格复核`,
        })
      } else mappings.set(product.id, reviewed)
      continue
    }
    const direct = directPhysicalMapping(product.unit)
    if (direct) {
      mappings.set(product.id, direct)
      continue
    }
    // Unreviewed free-text specifications are not safe evidence.  Clothing
    // sizes such as “120-135斤” and model numbers can look like food package
    // weights.  Keep an identity contract until a human or reviewed BOM gives
    // us domain-specific evidence.
    mappings.set(product.id, {
      inventoryUnit: product.unit,
      factor: 1,
      status: 'INFERRED',
      note: '暂按采购单位等同库存单位，待业务复核',
    })
  }

  const productByCode = new Map(products.map(product => [product.code, product]))
  const dishByName = new Map(dishes.map(dish => [normalizeDishName(dish.name), dish]))
  const exactBom = new Map<string, { quantity: number; unit: string }>()
  for (const rule of catalog.rules.filter(rule => rule.policy === 'BOM')) {
    const dish = dishByName.get(normalizeDishName(rule.dishName))
    if (!dish) continue
    for (const item of rule.items) {
      const product = productByCode.get(item.productCode)
      if (!product) continue
      const raw = baseQuantity(item.rawQuantity, item.rawUnit)
      exactBom.set(`${dish.id}\u0000${rule.variantKey}\u0000${product.id}`, raw)
    }
  }
  const report = {
    mode: commit ? 'commit' : 'dry-run',
    tenant: tenant.slug,
    products: products.length,
    verified: [...mappings.values()].filter(mapping => mapping.status === 'VERIFIED').length,
    inferred: [...mappings.values()].filter(mapping => mapping.status === 'INFERRED').length,
    recipeRows: recipes.length,
    bomItemRows: bomItems.length,
    receiptRows: receiptItems.length,
    snapshotRows: snapshotItems.length,
    consumptionRows: consumptions.length,
    manualLossRows: manualLossItems.length,
    samples: products.slice(0, 8).map(product => ({ code: product.code, name: product.name, purchaseUnit: product.unit, ...mappings.get(product.id) })),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!commit) return

  const actor = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
  })
    || await prisma.user.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' } })
    || (process.env.PREVIEW_MODE === 'true'
      ? await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
      : null)
  if (!actor) throw new Error('租户缺少任何用户，无法记录迁移审计')
  await prisma.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-unit-backfill:${tenant.id}`}))`)
    const prior = await tx.opLog.findFirst({
      where: { tenantId: tenant.id, action: '库存基础单位迁移 v1', entityType: 'Tenant', targetId: tenant.id },
    })
    if (prior) throw new Error('库存基础单位迁移 v1 已执行，禁止重复写入')
    const now = new Date()
    for (const product of products) {
      const mapping = mappings.get(product.id)!
      await tx.product.update({
        where: { id: product.id },
        data: {
          inventoryUnit: mapping.inventoryUnit,
          inventoryUnitsPerPurchaseUnit: mapping.factor,
          unitConversionStatus: mapping.status,
          unitConversionNote: mapping.note,
          unitConversionVerifiedAt: mapping.status === 'VERIFIED' ? now : null,
        },
      })
    }
    for (const row of recipes) {
      const mapping = mappings.get(row.productId)!
      const exact = exactBom.get(`${row.dishId}\u0000${row.variantKey}\u0000${row.productId}`)
      const quantity = exact?.quantity ?? (row.unit === mapping.inventoryUnit ? Number(row.quantity) : Number(row.quantity) * mapping.factor)
      await tx.dishRecipe.update({ where: { id: row.id }, data: { quantity, unit: exact?.unit || mapping.inventoryUnit } })
    }
    for (const row of bomItems) {
      const mapping = mappings.get(row.productId)!
      const exact = exactBom.get(`${row.version.dishId}\u0000${row.version.variantKey}\u0000${row.productId}`)
      const quantity = exact?.quantity ?? (row.unit === mapping.inventoryUnit ? Number(row.quantity) : Number(row.quantity) * mapping.factor)
      await tx.dishBomItem.update({ where: { id: row.id }, data: { quantity, unit: exact?.unit || mapping.inventoryUnit } })
    }
    for (const row of receiptItems) {
      const mapping = mappings.get(row.productId)!
      const inventoryQuantity = Number(row.quantity) * mapping.factor
      await tx.receiptItem.update({
        where: { id: row.id },
        data: {
          inventoryQuantity,
          inventoryUnitSnapshot: mapping.inventoryUnit,
          inventoryUnitsPerPurchaseUnitSnapshot: mapping.factor,
          // Historical line amount is the payable accounting fact.  A few old
          // adjusted deliveries intentionally differ from quantity*list price.
          inventoryUnitCostSnapshot: inventoryQuantity > 0 ? Number(row.amount) / inventoryQuantity : Number(row.unitPrice) / mapping.factor,
        },
      })
    }
    for (const row of snapshotItems) {
      if (!row.productId) continue
      const mapping = mappings.get(row.productId)!
      const alreadyBase = row.normalizedUnit === mapping.inventoryUnit
      const quantity = row.normalizedQuantity == null
        ? Number(row.quantity) * mapping.factor
        : Number(row.normalizedQuantity) * (alreadyBase ? 1 : mapping.factor)
      await tx.inventorySnapshotItem.update({
        where: { id: row.id },
        data: {
          normalizedQuantity: quantity,
          normalizedUnit: mapping.inventoryUnit,
          normalizationFactor: quantity / Number(row.quantity || 1),
          normalizationStatus: mapping.status === 'VERIFIED' ? 'EXACT' : 'CONVERTED',
          normalizationNote: `库存基础单位迁移：1${row.product!.unit}=${mapping.factor}${mapping.inventoryUnit}`,
        },
      })
    }
    for (const row of consumptions) {
      const mapping = mappings.get(row.productId)!
      const alreadyBase = row.inventoryUnitSnapshot === mapping.inventoryUnit && row.inventoryQuantity != null
      await tx.stockConsumption.update({
        where: { id: row.id },
        data: {
          unitSnapshot: row.unitSnapshot || row.product.unit,
          inventoryQuantity: alreadyBase ? row.inventoryQuantity : Number(row.quantity) * mapping.factor,
          inventoryUnitSnapshot: mapping.inventoryUnit,
        },
      })
    }
    for (const row of manualLossItems) {
      const mapping = mappings.get(row.productId)!
      await tx.lossClaimItem.update({
        where: { id: row.id },
        data: {
          inventoryQuantity: Number(row.lossQty) * mapping.factor,
          inventoryUnitSnapshot: mapping.inventoryUnit,
          inventoryUnitCostSnapshot: Number(row.unitPrice) / mapping.factor,
        },
      })
    }
    await tx.opLog.create({
      data: {
        tenantId: tenant.id,
        userId: actor.id,
        role: actor.role,
        action: '库存基础单位迁移 v1',
        target: tenant.name,
        targetId: tenant.id,
        entityType: 'Tenant',
        metadata: report,
      },
    })
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000 })
  console.log(JSON.stringify({ ok: true, ...report }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
