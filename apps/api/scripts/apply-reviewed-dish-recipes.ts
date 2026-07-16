/** Apply the portable, reviewed POS-variant BOM catalog. Dry-run by default. */
import 'dotenv/config'
import fs from 'node:fs/promises'
import { prisma } from '@dianjie/db'
import { normalizeDishName, normalizeVariantKey } from '../src/services/dailyBusinessImport'

type CatalogItem = {
  productCode: string
  productName: string
  productUnit: string
  quantity: number
  rawIngredient: string
  rawQuantity: number
  rawUnit: string
  note: string
}
type CatalogRule = {
  dishName: string
  spec: string
  variantKey: string
  policy: 'BOM' | 'EXCLUDE' | 'PENDING'
  note?: string | null
  items: CatalogItem[]
}
type Catalog = {
  version: number
  tenantSlug: string
  source: string
  productsToCreate: Array<{ code: string; name: string; unit: string; category: string; spec: string | null }>
  rules: CatalogRule[]
  audit: { rules: number; pendingRules: string[]; productsToCreate: number }
}

function quantityStep(unit: string) {
  return ['斤', 'kg', '公斤', '千克', '克', 'g', '升', 'l', '毫升', 'ml'].includes(unit.toLowerCase()) ? 0.001 : 1
}

async function main() {
  const args = process.argv.slice(2)
  const path = args.find(arg => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  const confirm = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (!path) throw new Error('请传入配方 catalog JSON')
  if (commit && confirm !== 'apply-reviewed-dish-recipes') throw new Error('写入需 --confirm=apply-reviewed-dish-recipes')
  const catalog = JSON.parse(await fs.readFile(path, 'utf8')) as Catalog
  if (catalog.version !== 1 || catalog.rules.length !== catalog.audit.rules) throw new Error('配方 catalog 版本或规则数不正确')
  const tenantOverride = args.find(arg => arg.startsWith('--tenant='))?.slice('--tenant='.length)
  const tenantSlug = tenantOverride || catalog.tenantSlug
  if (tenantOverride && process.env.PREVIEW_MODE !== 'true') throw new Error('--tenant 仅允许本地 PREVIEW_MODE 使用')
  if (tenantOverride && tenantOverride !== process.env.PREVIEW_TENANT_SLUG) throw new Error('--tenant 必须是 PREVIEW_TENANT_SLUG')
  const localPreview = Boolean(tenantOverride)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const [dishes, existingProducts] = await Promise.all([
    prisma.dish.findMany({ where: { tenantId: tenant.id } }),
    prisma.product.findMany({ where: { tenantId: tenant.id } }),
  ])
  const dishesByName = new Map<string, typeof dishes>()
  for (const dish of dishes) {
    const key = normalizeDishName(dish.name)
    dishesByName.set(key, [...(dishesByName.get(key) || []), dish])
  }
  const productsByCode = new Map(existingProducts.map(product => [product.code, product]))
  const productDrafts = new Map(catalog.productsToCreate.map(product => [product.code, product]))
  // 本地预览租户不复制生产主数据 ID/编码；为了能完整走 E2E，只按 catalog
  // 中已经审核过的商品名和单位镜像缺失 SKU。真实租户仍严格要求引用商品已存在。
  if (localPreview) {
    for (const item of catalog.rules.flatMap(rule => rule.items)) {
      if (!productsByCode.has(item.productCode) && !productDrafts.has(item.productCode)) {
        productDrafts.set(item.productCode, {
          code: item.productCode, name: item.productName, unit: item.productUnit,
          category: '本地配方镜像', spec: null,
        })
      }
    }
  }
  const missingDishes: string[] = []
  const ambiguousDishes: string[] = []
  const missingProducts = new Set<string>()
  const invalid: string[] = []
  const resolvedRules = catalog.rules.map(rule => {
    const candidates = dishesByName.get(normalizeDishName(rule.dishName)) || []
    if (candidates.length === 0) missingDishes.push(rule.dishName)
    if (candidates.length > 1) ambiguousDishes.push(rule.dishName)
    if (rule.variantKey !== normalizeVariantKey(rule.spec)) invalid.push(`${rule.dishName}: variantKey 漂移`)
    for (const item of rule.items) {
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) invalid.push(`${rule.dishName}: ${item.productName} 用量无效`)
      if (!productsByCode.has(item.productCode) && !productDrafts.has(item.productCode)) missingProducts.add(item.productCode)
    }
    return { rule, dish: candidates.length === 1 ? candidates[0] : null }
  })
  const ruleKeys = catalog.rules.map(rule => `${normalizeDishName(rule.dishName)}\u0000${rule.variantKey}`)
  if (new Set(ruleKeys).size !== ruleKeys.length) invalid.push('菜品规格规则重复')
  const report = {
    mode: commit ? 'commit' : 'dry-run',
    tenant: tenant.slug,
    source: catalog.source,
    rules: catalog.rules.length,
    bomRules: catalog.rules.filter(rule => rule.policy === 'BOM').length,
    excludedRules: catalog.rules.filter(rule => rule.policy === 'EXCLUDE').length,
    pendingRules: catalog.rules.filter(rule => rule.policy === 'PENDING').map(rule => `${rule.dishName}${rule.spec ? `(${rule.spec})` : ''}`),
    recipeItems: catalog.rules.reduce((sum, rule) => sum + rule.items.length, 0),
    existingProducts: new Set(catalog.rules.flatMap(rule => rule.items).filter(item => productsByCode.has(item.productCode)).map(item => item.productCode)).size,
    productsToCreate: [...productDrafts.values()].filter(product => !productsByCode.has(product.code)).length,
    missingDishes: [...new Set(missingDishes)],
    ambiguousDishes: [...new Set(ambiguousDishes)],
    missingProducts: [...missingProducts],
    invalid,
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.missingDishes.length || report.ambiguousDishes.length || report.missingProducts.length || report.invalid.length) {
    throw new Error('配方 catalog 校验未通过，禁止写入')
  }
  if (!commit) return

  await prisma.$transaction(async tx => {
    for (const draft of productDrafts.values()) {
      if (productsByCode.has(draft.code)) continue
      const created = await tx.product.create({
        data: {
          tenantId: tenant.id, code: draft.code, name: draft.name, spec: draft.spec,
          category: draft.category, unit: draft.unit, price: 0, stock: 0, minStock: 0,
          minOrderQty: quantityStep(draft.unit), stepQty: quantityStep(draft.unit), shelfDays: 7,
          supplierId: null, status: 'ENABLED',
        },
      })
      productsByCode.set(created.code, created)
    }
    for (const { rule, dish } of resolvedRules) {
      if (!dish) throw new Error(`菜品不存在: ${rule.dishName}`)
      if (rule.policy === 'EXCLUDE') {
        await tx.dish.update({
          where: { id: dish.id },
          data: { inventoryPolicy: 'EXCLUDE', inventoryPolicyNote: rule.note || '已确认不扣库存' },
        })
        await tx.dishRecipe.deleteMany({ where: { dishId: dish.id, variantKey: rule.variantKey } })
        continue
      }
      await tx.dish.update({ where: { id: dish.id }, data: { inventoryPolicy: 'BOM' } })
      if (rule.policy === 'PENDING') continue
      await tx.dishRecipe.deleteMany({ where: { dishId: dish.id, variantKey: rule.variantKey } })
      if (rule.items.length > 0) {
        await tx.dishRecipe.createMany({
          data: rule.items.map(item => {
            const product = productsByCode.get(item.productCode)
            if (!product) throw new Error(`商品不存在: ${item.productCode}`)
            if (product.unit.trim().toLowerCase() !== item.productUnit.trim().toLowerCase()) {
              throw new Error(`商品单位漂移: ${item.productName} ${product.unit} != ${item.productUnit}`)
            }
            return {
              dishId: dish.id, productId: product.id, variantKey: rule.variantKey,
              quantity: item.quantity, unit: item.productUnit, lossRate: 0,
              note: `${item.rawIngredient} ${item.rawQuantity}${item.rawUnit}；${item.note}`.slice(0, 100),
            }
          }),
        })
      }
    }
  }, { timeout: 60_000 })
  console.log(JSON.stringify({ ok: true, appliedRules: catalog.rules.filter(rule => rule.policy !== 'PENDING').length, pendingRules: report.pendingRules }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
