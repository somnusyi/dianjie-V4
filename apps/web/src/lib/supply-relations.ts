/**
 * 供货关系总表 + 供应商供货商品管理的纯逻辑。
 *
 * 数据源：
 * - GET /api/upstream-relations       → 全部生效绑定（商品×供应商扁平行）
 * - GET /api/upstream-relations/unbound → 未绑定商品
 * - GET /api/products（全量）          → 添加商品选择器
 */

export type RelationProduct = {
  id: string; code: string; name: string; category: string | null
  spec: string | null; unit: string
  purchaseUnit: string | null; inventoryUnit: string | null
  inventoryUnitsPerPurchaseUnit: number | null
  price: number | null; status: string
}

export type RelationSupplier = { id: string; no: string; name: string; status: string }

export type SupplyRelation = {
  id: string; productId: string; supplierId: string
  isPrimary: boolean; supplierSku: string | null
  purchaseUnit: string; inventoryUnitsPerPurchaseUnit: number
  quotedUnitPrice: number | null; minOrderQty: number
  leadTimeDays: number; note: string | null
  product: RelationProduct | null
  supplier?: RelationSupplier
}

export type UnboundProduct = Omit<RelationProduct, never>

export type RelationFilter = { q: string; category: string }

function matchesKeyword(q: string, ...fields: Array<string | null | undefined>): boolean {
  const keyword = q.trim().toLowerCase()
  if (!keyword) return true
  return fields.some(field => (field || '').toLowerCase().includes(keyword))
}

/** 关系行筛选：关键字命中商品名/编码/供应商名，分类精确匹配商品分类。 */
export function filterRelations(relations: SupplyRelation[], filter: RelationFilter): SupplyRelation[] {
  return relations.filter(row =>
    matchesKeyword(filter.q, row.product?.name, row.product?.code, row.supplier?.name)
    && (!filter.category || (row.product?.category || '其他') === filter.category))
}

export function filterUnboundProducts(products: UnboundProduct[], filter: RelationFilter): UnboundProduct[] {
  return products.filter(product =>
    matchesKeyword(filter.q, product.name, product.code)
    && (!filter.category || (product.category || '其他') === filter.category))
}

export type SupplierGroup = { supplier: RelationSupplier; rows: SupplyRelation[] }
export type ProductGroup = { product: RelationProduct; rows: SupplyRelation[] }

/** 按供应商分组（组内主供置顶），组序按供应商编号。 */
export function groupRelationsBySupplier(relations: SupplyRelation[]): SupplierGroup[] {
  const map = new Map<string, SupplierGroup>()
  for (const row of relations) {
    if (!row.supplier) continue
    let group = map.get(row.supplierId)
    if (!group) {
      group = { supplier: row.supplier, rows: [] }
      map.set(row.supplierId, group)
    }
    group.rows.push(row)
  }
  const groups = [...map.values()].sort((a, b) => a.supplier.no.localeCompare(b.supplier.no))
  for (const group of groups) {
    group.rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  }
  return groups
}

/** 按商品分组（组内主供置顶），组序按分类再按编码。 */
export function groupRelationsByProduct(relations: SupplyRelation[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>()
  for (const row of relations) {
    if (!row.product) continue
    let group = map.get(row.productId)
    if (!group) {
      group = { product: row.product, rows: [] }
      map.set(row.productId, group)
    }
    group.rows.push(row)
  }
  const groups = [...map.values()].sort((a, b) =>
    (a.product.category || '其他').localeCompare(b.product.category || '其他')
    || a.product.code.localeCompare(b.product.code))
  for (const group of groups) {
    group.rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  }
  return groups
}

/** 未绑定清单按分类分组，保持分类间字典序、类内按编码。 */
export function groupUnboundByCategory(products: UnboundProduct[]): Array<{ category: string; rows: UnboundProduct[] }> {
  const map = new Map<string, UnboundProduct[]>()
  for (const product of products) {
    const category = product.category || '其他'
    const list = map.get(category) || []
    list.push(product)
    map.set(category, list)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, rows]) => ({
      category,
      rows: rows.sort((a, b) => a.code.localeCompare(b.code)),
    }))
}

/** 从全量商品列表提取分类名（按出现顺序去重，空分类归「其他」）。 */
export function categoriesOfProducts(products: Array<{ category: string | null }>): string[] {
  const seen = new Set<string>()
  for (const product of products) seen.add(product.category || '其他')
  return [...seen]
}

export type BindItemDraft = {
  productId: string
  purchaseUnit: string
  inventoryUnitsPerPurchaseUnit: number
  quotedUnitPrice: number | null
  isPrimary: boolean
}

/**
 * 勾选商品 → 批量绑定请求体。
 * 默认值预填商品档案（采购单位/换算比/档案价），换算比缺失的商品跳过并回报，
 * 因为换算比是入库成本折算的命门，不能瞎猜成 1。
 */
export function buildBindItems(
  products: Array<Pick<RelationProduct, 'id' | 'purchaseUnit' | 'inventoryUnitsPerPurchaseUnit' | 'price' | 'unit'>>,
  options: { isPrimary?: boolean } = {},
): { items: BindItemDraft[]; missingConversion: string[] } {
  const items: BindItemDraft[] = []
  const missingConversion: string[] = []
  for (const product of products) {
    const factor = Number(product.inventoryUnitsPerPurchaseUnit)
    if (!Number.isFinite(factor) || factor <= 0) {
      missingConversion.push(product.id)
      continue
    }
    items.push({
      productId: product.id,
      purchaseUnit: product.purchaseUnit || product.unit,
      inventoryUnitsPerPurchaseUnit: factor,
      quotedUnitPrice: product.price === null ? null : Number(product.price),
      isPrimary: options.isPrimary ?? false,
    })
  }
  return { items, missingConversion }
}
