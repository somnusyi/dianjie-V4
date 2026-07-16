/**
 * Apply a reviewed set of physical-count bindings and inventory-only products.
 *
 * Safety:
 * - dry-run by default;
 * - commit requires an explicit confirmation token;
 * - tenant, store, snapshot date and rule count must all match the payload;
 * - every row must normalize into the purchasing SKU unit before any write;
 * - the transaction is idempotent: deterministic product codes are reused only
 *   when their identity fields still match the reviewed payload.
 */
import 'dotenv/config'
import fs from 'node:fs/promises'
import { prisma } from '@dianjie/db'
import { normalizeInventoryQuantity, type InventoryUnitNormalization } from '../src/services/inventoryUnits'

type ProductDraft = {
  name: string
  spec: string
  unit: string
  category: string
}

type ReviewedRule = {
  rawName: string
  action: 'BIND' | 'CREATE'
  productCode?: string
  product?: ProductDraft
  factorOverride?: number
  note?: string
}

type ReviewedPayload = {
  tenantSlug: string
  targetStoreNo: string
  snapshotDate: string
  expectedRuleCount: number
  rules: ReviewedRule[]
}

function normalizeText(value: string | null | undefined) {
  return String(value || '').normalize('NFKC').replace(/[\s·・]/g, '').toLowerCase()
}

function quantityStep(unit: string) {
  return ['斤', 'kg', '公斤', '千克', '克', 'g', '升', 'l', '毫升', 'ml'].includes(unit.toLowerCase()) ? 0.1 : 1
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function reviewedNormalization(input: {
  quantity: number
  rawUnit: string
  rawSpec: string | null
  productUnit: string
  productSpec: string | null
  factorOverride?: number
  note?: string
}): InventoryUnitNormalization {
  if (input.factorOverride !== undefined) {
    if (!Number.isFinite(input.factorOverride) || input.factorOverride <= 0) {
      return {
        status: 'PENDING', normalizedQuantity: null, normalizedUnit: input.productUnit,
        factor: null, note: '人工换算系数必须大于0',
      }
    }
    return {
      status: input.factorOverride === 1 && normalizeText(input.rawUnit) === normalizeText(input.productUnit) ? 'EXACT' : 'CONVERTED',
      normalizedQuantity: input.quantity * input.factorOverride,
      normalizedUnit: input.productUnit,
      factor: input.factorOverride,
      note: `按已复核系数 ${input.factorOverride} 换算${input.note ? `；${input.note}` : ''}`,
    }
  }
  const normalized = normalizeInventoryQuantity(input)
  return {
    ...normalized,
    note: `${normalized.note}${input.note ? `；${input.note}` : ''}`,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const payloadPath = args.find(arg => !arg.startsWith('--'))
  const commit = args.includes('--commit')
  const confirm = args.find(arg => arg.startsWith('--confirm='))?.slice('--confirm='.length)
  if (!payloadPath) throw new Error('请传入复核规则 JSON')
  if (commit && confirm !== 'apply-reviewed-inventory-rules') {
    throw new Error('写入需 --confirm=apply-reviewed-inventory-rules')
  }

  const payload = JSON.parse(await fs.readFile(payloadPath, 'utf8')) as ReviewedPayload
  if (payload.rules.length !== payload.expectedRuleCount) {
    throw new Error(`规则数不符: 期望 ${payload.expectedRuleCount}, 实际 ${payload.rules.length}`)
  }
  const uniqueRawNames = new Set(payload.rules.map(rule => rule.rawName))
  if (uniqueRawNames.size !== payload.rules.length) throw new Error('规则中存在重复 rawName')

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: payload.tenantSlug } })
  const store = await prisma.store.findUniqueOrThrow({
    where: { tenantId_no: { tenantId: tenant.id, no: payload.targetStoreNo } },
  })
  const snapshot = await prisma.inventorySnapshot.findUniqueOrThrow({
    where: { storeId_snapshotDate: { storeId: store.id, snapshotDate: new Date(`${payload.snapshotDate}T00:00:00.000Z`) } },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })

  const bindingCodes = payload.rules.filter(rule => rule.action === 'BIND').map(rule => rule.productCode || '')
  const proposedCodes = payload.rules.filter(rule => rule.action === 'CREATE').map(rule => {
    const item = snapshot.items.find(snapshotItem => snapshotItem.rawName === rule.rawName)
    if (!item) throw new Error(`盘点品项不存在: ${rule.rawName}`)
    return `${store.no.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}-INV-${String(item.sortOrder).padStart(4, '0')}`
  })
  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id, code: { in: [...bindingCodes, ...proposedCodes] } },
  })
  const productsByCode = new Map(products.map(product => [product.code, product]))
  const allTenantProducts = await prisma.product.findMany({ where: { tenantId: tenant.id } })

  const rows = payload.rules.map(rule => {
    const matches = snapshot.items.filter(item => item.rawName === rule.rawName)
    if (matches.length !== 1) throw new Error(`盘点品项 ${rule.rawName} 应唯一，实际 ${matches.length}`)
    const item = matches[0]
    let action: 'BIND' | 'CREATE' | 'REUSE_CREATED_CODE' = rule.action
    let productId: string | null = null
    let productCode: string
    let productName: string
    let productSpec: string | null
    let productUnit: string
    let productCategory: string

    if (rule.action === 'BIND') {
      if (!rule.productCode) throw new Error(`${rule.rawName} 缺少 productCode`)
      const product = productsByCode.get(rule.productCode)
      if (!product) throw new Error(`商品编码不存在: ${rule.productCode}`)
      productId = product.id
      productCode = product.code
      productName = product.name
      productSpec = product.spec
      productUnit = product.unit
      productCategory = product.category
    } else {
      if (!rule.product) throw new Error(`${rule.rawName} 缺少新商品定义`)
      productCode = `${store.no.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}-INV-${String(item.sortOrder).padStart(4, '0')}`
      productName = rule.product.name
      productSpec = rule.product.spec
      productUnit = rule.product.unit
      productCategory = rule.product.category
      const coded = productsByCode.get(productCode)
      if (coded) {
        const identityMatches = normalizeText(coded.name) === normalizeText(productName)
          && normalizeText(coded.spec) === normalizeText(productSpec)
          && normalizeText(coded.unit) === normalizeText(productUnit)
        if (!identityMatches) throw new Error(`确定性编码冲突: ${productCode} 已属于 ${coded.name}`)
        productId = coded.id
        action = 'REUSE_CREATED_CODE'
      } else {
        const sameName = allTenantProducts.filter(product => normalizeText(product.name) === normalizeText(productName))
        if (sameName.length > 0) {
          throw new Error(`新商品 ${productName} 与现有商品同名，需先人工复核: ${sameName.map(product => product.code).join(',')}`)
        }
      }
    }

    const normalization = reviewedNormalization({
      quantity: Number(item.quantity), rawUnit: item.unit, rawSpec: item.rawSpec,
      productUnit, productSpec, factorOverride: rule.factorOverride, note: rule.note,
    })
    const normalizedQuantity = normalization.normalizedQuantity
    const price = normalizedQuantity && normalizedQuantity > 0
      ? roundMoney(Number(item.amount) / normalizedQuantity)
      : 0
    return {
      rule, item, action, productId, productCode, productName, productSpec,
      productUnit, productCategory, normalization, price,
    }
  })

  const pending = rows.filter(row => row.normalization.status === 'PENDING')
  const report = {
    mode: commit ? 'commit' : 'dry-run',
    tenant: tenant.slug,
    store: { no: store.no, name: store.name },
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    rules: rows.length,
    bind: rows.filter(row => row.action === 'BIND').length,
    create: rows.filter(row => row.action === 'CREATE').length,
    reuseCreatedCode: rows.filter(row => row.action === 'REUSE_CREATED_CODE').length,
    normalized: {
      exact: rows.filter(row => row.normalization.status === 'EXACT').length,
      converted: rows.filter(row => row.normalization.status === 'CONVERTED').length,
      pending: pending.length,
    },
    rows: rows.map(row => ({
      rawName: row.item.rawName,
      rawQuantity: Number(row.item.quantity),
      rawUnit: row.item.unit,
      action: row.action,
      productCode: row.productCode,
      productName: row.productName,
      normalizedQuantity: row.normalization.normalizedQuantity,
      normalizedUnit: row.normalization.normalizedUnit,
      factor: row.normalization.factor,
      priceIfCreated: row.action === 'CREATE' ? row.price : undefined,
      note: row.normalization.note,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  if (pending.length > 0) {
    throw new Error(`仍有 ${pending.length} 项无法可靠换算，禁止写入: ${pending.map(row => row.item.rawName).join('、')}`)
  }
  if (!commit) return

  await prisma.$transaction(async tx => {
    for (const row of rows) {
      let productId = row.productId
      if (!productId) {
        const step = quantityStep(row.productUnit)
        const created = await tx.product.create({
          data: {
            tenantId: tenant.id,
            code: row.productCode,
            name: row.productName,
            spec: row.productSpec,
            category: row.productCategory,
            unit: row.productUnit,
            price: row.price,
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
      await tx.inventorySnapshotItem.update({
        where: { id: row.item.id },
        data: {
          productId,
          normalizedQuantity: row.normalization.normalizedQuantity,
          normalizedUnit: row.normalization.normalizedUnit,
          normalizationFactor: row.normalization.factor,
          normalizationStatus: row.normalization.status,
          normalizationNote: row.normalization.note,
        },
      })
    }
    const matchedCount = await tx.inventorySnapshotItem.count({
      where: { snapshotId: snapshot.id, productId: { not: null } },
    })
    await tx.inventorySnapshot.update({ where: { id: snapshot.id }, data: { matchedCount } })
  }, { timeout: 60_000 })

  console.log(JSON.stringify({
    ok: true,
    created: rows.filter(row => row.action === 'CREATE').length,
    bound: rows.length,
  }))
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
