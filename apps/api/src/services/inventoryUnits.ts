export type InventoryUnitNormalization = {
  status: 'EXACT' | 'CONVERTED' | 'PENDING'
  normalizedQuantity: number | null
  normalizedUnit: string
  factor: number | null
  note: string
}

export type ProductInventoryUnitLike = {
  unit: string
  purchaseUnit?: string | null
  inventoryUnit?: string | null
  orderUnit?: string | null
  costUnit?: string | null
  inventoryUnitsPerPurchaseUnit?: number | string | { toString(): string } | null
  inventoryUnitsPerOrderUnit?: number | string | { toString(): string } | null
  inventoryUnitsPerCostUnit?: number | string | { toString(): string } | null
  unitConversionStatus?: 'PENDING' | 'INFERRED' | 'VERIFIED' | string | null
}

export type ProductUnitRole = 'purchase' | 'inventory' | 'order' | 'cost'

export type ResolvedProductFourUnits = {
  legacyUnit: string
  purchaseUnit: string
  inventoryUnit: string
  orderUnit: string
  costUnit: string
  inventoryUnitsPerPurchaseUnit: number
  inventoryUnitsPerOrderUnit: number
  inventoryUnitsPerCostUnit: number
  status: 'PENDING' | 'INFERRED' | 'VERIFIED'
  structured: Record<Exclude<ProductUnitRole, 'inventory'>, boolean>
}

export type ResolvedProductInventoryUnit = {
  purchaseUnit: string
  inventoryUnit: string
  inventoryUnitsPerPurchaseUnit: number
  status: 'PENDING' | 'INFERRED' | 'VERIFIED'
  structured: boolean
}

export const PRODUCT_UNIT_NAME_MAX_LENGTH = 16
export const PRODUCT_UNIT_FACTOR_MAX_DECIMAL_PLACES = 6
export const PRODUCT_UNIT_FACTOR_MAX = 999_999_999_999.999999

const MASS_TO_GRAMS: Record<string, number> = {
  g: 1,
  克: 1,
  kg: 1000,
  公斤: 1000,
  千克: 1000,
  斤: 500,
}

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  毫升: 1,
  l: 1000,
  升: 1000,
}

const PACKAGE_UNITS = new Set(['箱', '件', '袋', '包', '瓶', '罐', '盒', '桶', '个', '枚', '支', '片', '套'])

function cleanUnit(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase().replace('公斤', 'kg').replace('千克', 'kg').replace('毫升', 'ml')
}

function cleanSpec(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('×', '*')
    .replaceAll('x', '*')
    .replaceAll('／', '/')
    .replaceAll('公斤', 'kg')
    .replaceAll('千克', 'kg')
    .replaceAll('克', 'g')
    .replaceAll('毫升', 'ml')
    .replaceAll('升', 'l')
    .replace(/\s+/g, '')
}

function massUnitFactor(unit: string) {
  return MASS_TO_GRAMS[cleanUnit(unit)] || null
}

function volumeUnitFactor(unit: string) {
  return VOLUME_TO_ML[cleanUnit(unit)] || null
}

function amountToBase(value: number, unit: string) {
  const mass = massUnitFactor(unit)
  if (mass) return { dimension: 'mass' as const, value: value * mass }
  const volume = volumeUnitFactor(unit)
  if (volume) return { dimension: 'volume' as const, value: value * volume }
  return null
}

function hasAtMostSixDecimalPlaces(value: unknown) {
  const match = String(value).trim().match(/^[+-]?\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/i)
  if (!match) return false
  const fractionLength = match[1]?.length || 0
  const exponent = Number(match[2] || 0)
  return Math.max(0, fractionLength - exponent) <= PRODUCT_UNIT_FACTOR_MAX_DECIMAL_PLACES
}

export function isValidProductUnitFactor(value: unknown): boolean {
  const number = Number(value)
  return Number.isFinite(number)
    && number > 0
    && number <= PRODUCT_UNIT_FACTOR_MAX
    && hasAtMostSixDecimalPlaces(value)
}

function positiveNumber(value: unknown) {
  return isValidProductUnitFactor(value) ? Number(value) : null
}

export function normalizeProductUnitName(value: unknown): string {
  const unit = String(value ?? '').trim()
  if (!unit) throw new Error('单位名不能为空')
  if (unit.length > PRODUCT_UNIT_NAME_MAX_LENGTH) {
    throw new Error(`单位名不能超过 ${PRODUCT_UNIT_NAME_MAX_LENGTH} 个字符`)
  }
  return unit
}

function optionalValidUnit(value: unknown): string | null {
  const unit = String(value ?? '').trim()
  return unit && unit.length <= PRODUCT_UNIT_NAME_MAX_LENGTH ? unit : null
}

function conversionStatus(value: unknown): ResolvedProductFourUnits['status'] {
  const rawStatus = String(value || 'PENDING')
  return rawStatus === 'VERIFIED' ? 'VERIFIED' : rawStatus === 'INFERRED' ? 'INFERRED' : 'PENDING'
}

/**
 * Resolve all four master-data units. Every factor means:
 * `1 corresponding unit = factor inventory units`.
 *
 * Missing V5 fields use only deterministic legacy compatibility values. No
 * specification text or historical document is inspected or guessed.
 */
export function resolveProductFourUnits(product: ProductInventoryUnitLike): ResolvedProductFourUnits {
  const legacyUnit = optionalValidUnit(product.unit) || ''
  const purchaseUnit = optionalValidUnit(product.purchaseUnit) || legacyUnit
  const inventoryUnit = optionalValidUnit(product.inventoryUnit) || legacyUnit
  const orderUnit = optionalValidUnit(product.orderUnit) || legacyUnit
  const costUnit = optionalValidUnit(product.costUnit) || legacyUnit
  const purchaseFactor = positiveNumber(product.inventoryUnitsPerPurchaseUnit)
  const orderFactor = positiveNumber(product.inventoryUnitsPerOrderUnit)
  const costFactor = positiveNumber(product.inventoryUnitsPerCostUnit)

  return {
    legacyUnit,
    purchaseUnit,
    inventoryUnit,
    orderUnit,
    costUnit,
    inventoryUnitsPerPurchaseUnit: purchaseFactor || 1,
    inventoryUnitsPerOrderUnit: orderFactor || purchaseFactor || 1,
    inventoryUnitsPerCostUnit: costFactor || purchaseFactor || 1,
    status: conversionStatus(product.unitConversionStatus),
    structured: {
      purchase: Boolean(optionalValidUnit(product.inventoryUnit) && purchaseFactor),
      order: Boolean(optionalValidUnit(product.inventoryUnit) && orderFactor),
      cost: Boolean(optionalValidUnit(product.inventoryUnit) && costFactor),
    },
  }
}

function factorForRole(contract: ResolvedProductFourUnits, role: ProductUnitRole): number {
  if (role === 'purchase') return contract.inventoryUnitsPerPurchaseUnit
  if (role === 'order') return contract.inventoryUnitsPerOrderUnit
  if (role === 'cost') return contract.inventoryUnitsPerCostUnit
  return 1
}

function unitForRole(contract: ResolvedProductFourUnits, role: ProductUnitRole): string {
  if (role === 'purchase') return contract.purchaseUnit
  if (role === 'order') return contract.orderUnit
  if (role === 'cost') return contract.costUnit
  return contract.inventoryUnit
}

/** Convert a quantity between named roles through the inventory-unit basis. */
export function convertQuantityBetweenProductUnits(input: {
  quantity: number
  source: ProductUnitRole
  target: ProductUnitRole
  product: ProductInventoryUnitLike
}): InventoryUnitNormalization {
  const contract = resolveProductFourUnits(input.product)
  const normalizedUnit = unitForRole(contract, input.target)
  if (!Number.isFinite(input.quantity)) {
    return { status: 'PENDING', normalizedQuantity: null, normalizedUnit, factor: null, note: '数量无效' }
  }
  const factor = factorForRole(contract, input.source) / factorForRole(contract, input.target)
  return {
    status: factor === 1 ? 'EXACT' : 'CONVERTED',
    normalizedQuantity: input.quantity * factor,
    normalizedUnit,
    factor,
    note: `按四单位主数据 ${unitForRole(contract, input.source)} → ${normalizedUnit} 换算`,
  }
}

/**
 * Resolve the authoritative unit contract for one purchasing SKU.
 *
 * Legacy products deliberately fall back to 1 purchase unit = 1 inventory unit
 * with status PENDING.  That preserves historical reads without pretending the
 * master data has been verified.
 */
export function resolveProductInventoryUnit(product: ProductInventoryUnitLike): ResolvedProductInventoryUnit {
  const contract = resolveProductFourUnits(product)
  if (contract.structured.purchase) {
    return {
      purchaseUnit: contract.purchaseUnit,
      inventoryUnit: contract.inventoryUnit,
      inventoryUnitsPerPurchaseUnit: contract.inventoryUnitsPerPurchaseUnit,
      status: contract.status,
      structured: true,
    }
  }
  return {
    purchaseUnit: contract.purchaseUnit,
    inventoryUnit: contract.purchaseUnit,
    inventoryUnitsPerPurchaseUnit: 1,
    status: 'PENDING',
    structured: false,
  }
}

/** Convert a quantity expressed in sourceUnit to the product inventory unit. */
export function convertQuantityToInventoryUnit(input: {
  quantity: number
  sourceUnit: string
  product: ProductInventoryUnitLike
  productSpec?: string | null
}): InventoryUnitNormalization {
  const contract = resolveProductInventoryUnit(input.product)
  const fourUnits = resolveProductFourUnits(input.product)
  const sourceUnit = cleanUnit(input.sourceUnit)
  const inventoryUnit = cleanUnit(contract.inventoryUnit)
  const purchaseUnit = cleanUnit(contract.purchaseUnit)
  if (!Number.isFinite(input.quantity)) {
    return {
      status: 'PENDING', normalizedQuantity: null, normalizedUnit: contract.inventoryUnit,
      factor: null, note: '数量无效',
    }
  }
  if (sourceUnit === inventoryUnit) {
    return {
      status: 'EXACT', normalizedQuantity: input.quantity, normalizedUnit: contract.inventoryUnit,
      factor: 1, note: '已使用库存基础单位',
    }
  }
  if (sourceUnit === purchaseUnit && contract.structured) {
    return {
      status: 'CONVERTED',
      normalizedQuantity: input.quantity * contract.inventoryUnitsPerPurchaseUnit,
      normalizedUnit: contract.inventoryUnit,
      factor: contract.inventoryUnitsPerPurchaseUnit,
      note: `按主数据 1${contract.purchaseUnit}=${contract.inventoryUnitsPerPurchaseUnit}${contract.inventoryUnit} 换算`,
    }
  }
  if (sourceUnit === cleanUnit(fourUnits.orderUnit) && fourUnits.structured.order) {
    return {
      status: 'CONVERTED',
      normalizedQuantity: input.quantity * fourUnits.inventoryUnitsPerOrderUnit,
      normalizedUnit: fourUnits.inventoryUnit,
      factor: fourUnits.inventoryUnitsPerOrderUnit,
      note: `按主数据 1${fourUnits.orderUnit}=${fourUnits.inventoryUnitsPerOrderUnit}${fourUnits.inventoryUnit} 换算`,
    }
  }
  if (sourceUnit === cleanUnit(fourUnits.costUnit) && fourUnits.structured.cost) {
    return {
      status: 'CONVERTED',
      normalizedQuantity: input.quantity * fourUnits.inventoryUnitsPerCostUnit,
      normalizedUnit: fourUnits.inventoryUnit,
      factor: fourUnits.inventoryUnitsPerCostUnit,
      note: `按主数据 1${fourUnits.costUnit}=${fourUnits.inventoryUnitsPerCostUnit}${fourUnits.inventoryUnit} 换算`,
    }
  }

  const sourcePhysical = amountToBase(input.quantity, input.sourceUnit)
  const oneSourcePhysical = amountToBase(1, input.sourceUnit)
  const oneInventoryPhysical = amountToBase(1, contract.inventoryUnit)
  if (sourcePhysical && oneSourcePhysical && oneInventoryPhysical
    && sourcePhysical.dimension === oneInventoryPhysical.dimension) {
    const factor = oneSourcePhysical.value / oneInventoryPhysical.value
    return {
      status: 'CONVERTED', normalizedQuantity: input.quantity * factor,
      normalizedUnit: contract.inventoryUnit, factor,
      note: `${input.sourceUnit}换算为${contract.inventoryUnit}`,
    }
  }

  // A structured contract is authoritative.  A VERIFIED purchasing SKU may
  // still use a BOM unit below the four commercial units (for example g or an
  // inner bag while inventory is kept by bottle/case).  In that specific case
  // the reviewed package specification is the missing bridge.  PENDING and
  // INFERRED contracts remain fail-closed so an unreviewed spec typo can never
  // change inventory silently.
  if (contract.structured) {
    if (contract.status === 'VERIFIED' && input.productSpec) {
      const verifiedSpecConversion = normalizeInventoryQuantity({
        quantity: input.quantity,
        rawUnit: input.sourceUnit,
        rawSpec: null,
        productUnit: contract.inventoryUnit,
        productSpec: input.productSpec,
      })
      if (verifiedSpecConversion.normalizedQuantity != null) {
        return {
          ...verifiedSpecConversion,
          note: `按已核验采购规格 ${input.productSpec} 换算`,
        }
      }
    }
    return {
      status: 'PENDING', normalizedQuantity: null, normalizedUnit: contract.inventoryUnit,
      factor: null,
      note: `无法按主数据换算 ${input.sourceUnit} → ${contract.inventoryUnit}`,
    }
  }

  // Compatibility for unmigrated products only.  The result remains PENDING at
  // governance level even when the old spec parser can calculate a quantity.
  return normalizeInventoryQuantity({
    quantity: input.quantity,
    rawUnit: input.sourceUnit,
    productUnit: contract.purchaseUnit,
    productSpec: input.productSpec,
  })
}

export function purchasePriceToInventoryUnitCost(input: {
  purchaseUnitPrice: number
  product: ProductInventoryUnitLike
}) {
  const contract = resolveProductInventoryUnit(input.product)
  if (!Number.isFinite(input.purchaseUnitPrice) || input.purchaseUnitPrice < 0) return null
  if (!contract.structured || contract.inventoryUnitsPerPurchaseUnit <= 0) return null
  return input.purchaseUnitPrice / contract.inventoryUnitsPerPurchaseUnit
}

function quantityTokenToBase(value: number, unit: string) {
  const normalized = cleanUnit(unit)
  const mass = MASS_TO_GRAMS[normalized]
  if (mass) return { dimension: 'mass' as const, value: value * mass }
  const volume = VOLUME_TO_ML[normalized]
  if (volume) return { dimension: 'volume' as const, value: value * volume }
  return null
}

function packageUnitsEquivalent(left: string, right: string) {
  const a = cleanUnit(left)
  const b = cleanUnit(right)
  if (a === b) return true
  const groups = [new Set(['箱', '件']), new Set(['包', '袋']), new Set(['个', '枚'])]
  return groups.some(group => group.has(a) && group.has(b))
}

/** Returns the physical mass/volume represented by one purchasing package. */
export function physicalAmountPerPackage(specValue: string | null | undefined) {
  const spec = cleanSpec(specValue)
  if (!spec) return null

  // 500g*20包, 2kg/6袋, 1l*12瓶
  const amountThenCount = spec.match(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?![a-z])(?:[*\/])(\d+(?:\.\d+)?)(?:包|袋|瓶|盒|桶|罐|个|枚|支|片)/)
  if (amountThenCount) {
    const base = quantityTokenToBase(Number(amountThenCount[1]), amountThenCount[2])
    if (base) return { dimension: base.dimension, value: base.value * Number(amountThenCount[3]) }
  }

  // 20包/500g, 24瓶/330ml
  const countThenAmount = spec.match(/(\d+(?:\.\d+)?)(?:包|袋|瓶|盒|桶|罐|个|枚|支|片)[*\/](\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?![a-z])/)
  if (countThenAmount) {
    const base = quantityTokenToBase(Number(countThenAmount[2]), countThenAmount[3])
    if (base) return { dimension: base.dimension, value: base.value * Number(countThenAmount[1]) }
  }

  // If several physical amounts are present (e.g. 箱/10斤/500g), the largest
  // one is the package total and the smaller one is normally a per-bag hint.
  // Unit tokens must end cleanly.  Previously `3Gg/桶` was lower-cased to
  // `3gg/桶` and the first `g` was silently accepted as grams, turning 55g into
  // 18.333333 purchasing buckets.  Invalid specifications must remain pending
  // instead of being guessed.
  const candidates = [...spec.matchAll(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?![a-z])/g)]
    .map(match => quantityTokenToBase(Number(match[1]), match[2]))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
  if (candidates.length === 0) return null
  const dimension = candidates[0].dimension
  const sameDimension = candidates.filter(item => item.dimension === dimension)
  return sameDimension.reduce((largest, item) => item.value > largest.value ? item : largest)
}

/**
 * Returns the physical amount represented by one Product.unit.
 *
 * A supplier spec can describe both an outer case and an inner selling unit,
 * for example `箱/10包/2500g`.  `physicalAmountPerPackage` intentionally returns
 * the outer-case total (25kg), while a Product whose unit is `包` represents only
 * the inner 2500g.  BOM conversion must respect that distinction or consumption is
 * understated by the inner package count.
 */
function physicalAmountPerProductUnit(specValue: string | null | undefined, productUnitValue: string) {
  const spec = cleanSpec(specValue)
  const productUnit = cleanUnit(productUnitValue)
  if (!spec || !productUnit) return null

  // 500g*20包/箱, 1l*12瓶/件
  const amountThenCount = spec.match(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?![a-z])[*\/](\d+(?:\.\d+)?)(包|袋|瓶|盒|桶|罐|个|枚|支|片)(?:\/(?:箱|件))?/)
  if (amountThenCount) {
    const oneInner = quantityTokenToBase(Number(amountThenCount[1]), amountThenCount[2])
    if (oneInner) {
      if (packageUnitsEquivalent(productUnit, amountThenCount[4])) return oneInner
      return { dimension: oneInner.dimension, value: oneInner.value * Number(amountThenCount[3]) }
    }
  }

  // 箱/20包/500g, 件/24瓶/330ml
  const countThenAmount = spec.match(/(\d+(?:\.\d+)?)(包|袋|瓶|盒|桶|罐|个|枚|支|片)[*\/](\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?![a-z])/)
  if (countThenAmount) {
    const oneInner = quantityTokenToBase(Number(countThenAmount[3]), countThenAmount[4])
    if (oneInner) {
      if (packageUnitsEquivalent(productUnit, countThenAmount[2])) return oneInner
      return { dimension: oneInner.dimension, value: oneInner.value * Number(countThenAmount[1]) }
    }
  }

  // 1.5kg*6/箱.  Here the inner unit label is omitted; 箱/件 is the outer unit.
  const amountTimesBareCount = spec.match(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?![a-z])\*(\d+(?:\.\d+)?)\/(?:箱|件)/)
  if (amountTimesBareCount && (productUnit === '箱' || productUnit === '件')) {
    const oneInner = quantityTokenToBase(Number(amountTimesBareCount[1]), amountTimesBareCount[2])
    if (oneInner) return { dimension: oneInner.dimension, value: oneInner.value * Number(amountTimesBareCount[3]) }
  }

  return physicalAmountPerPackage(specValue)
}

function countPerPackage(specValue: string | null | undefined, rawUnit: string) {
  const spec = cleanSpec(specValue)
  const unit = cleanUnit(rawUnit)
  if (!spec || !unit || !PACKAGE_UNITS.has(unit)) return null
  const equivalentUnits: Record<string, string[]> = {
    袋: ['袋', '包'],
    包: ['包', '袋'],
    个: ['个', '枚'],
    枚: ['枚', '个'],
  }
  const alternatives = equivalentUnits[unit] || [unit]
  const escaped = alternatives.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const matches = [...spec.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)(?:${escaped})`, 'g'))]
  if (matches.length > 0) return Math.max(...matches.map(match => Number(match[1])))
  // Beverage specs are often abbreviated as 330*24/箱 or 470ml*12.
  const bareMultiplier = spec.match(/\*(\d+(?:\.\d+)?)(?:\/(?:箱|件))?$/)
  return bareMultiplier ? Number(bareMultiplier[1]) : null
}

/**
 * Convert a physical-count row into Product.unit.
 * PENDING is deliberate: uncertain rows must not silently corrupt rolling stock.
 */
export function normalizeInventoryQuantity(input: {
  quantity: number
  rawUnit: string
  rawSpec?: string | null
  productUnit: string
  productSpec?: string | null
}): InventoryUnitNormalization {
  const rawUnit = cleanUnit(input.rawUnit)
  const productUnit = cleanUnit(input.productUnit)
  const normalizedUnit = input.productUnit
  if (!Number.isFinite(input.quantity)) {
    return { status: 'PENDING', normalizedQuantity: null, normalizedUnit, factor: null, note: '盘点数量无效' }
  }
  if (rawUnit === productUnit) {
    return { status: 'EXACT', normalizedQuantity: input.quantity, normalizedUnit, factor: 1, note: '盘点单位与采购SKU单位一致' }
  }

  const rawPhysical = amountToBase(input.quantity, rawUnit)
  const rawUnitPhysical = amountToBase(1, rawUnit)
  const productPhysical = amountToBase(1, productUnit)
  if (rawPhysical && productPhysical && rawPhysical.dimension === productPhysical.dimension) {
    const factor = rawUnitPhysical!.value / productPhysical.value
    return {
      status: 'CONVERTED', normalizedQuantity: rawPhysical.value / productPhysical.value,
      normalizedUnit, factor, note: `${input.rawUnit}换算为${input.productUnit}`,
    }
  }

  const productPackage = physicalAmountPerProductUnit(input.productSpec, productUnit)
  if (rawPhysical && productPackage && rawPhysical.dimension === productPackage.dimension) {
    const factor = rawUnitPhysical!.value / productPackage.value
    const normalizedQuantity = input.quantity * factor
    return {
      status: 'CONVERTED', normalizedQuantity, normalizedUnit,
      factor,
      note: `按采购规格 ${input.productSpec || '-'} 换算`,
    }
  }

  if (PACKAGE_UNITS.has(rawUnit) && PACKAGE_UNITS.has(productUnit)) {
    const count = countPerPackage(input.productSpec, rawUnit) || countPerPackage(input.rawSpec, rawUnit)
    if (count && count > 0) {
      const normalizedQuantity = input.quantity / count
      return {
        status: 'CONVERTED', normalizedQuantity, normalizedUnit,
        factor: 1 / count, note: `按每${input.productUnit}${count}${input.rawUnit}换算`,
      }
    }
    // 件/箱 commonly denote the same outer package. Accept only when both specs
    // expose the same physical package size; the physical branch above handles it.
  }

  const rawPackage = physicalAmountPerPackage(input.rawSpec)
  if (rawPackage && productPackage && rawPackage.dimension === productPackage.dimension && PACKAGE_UNITS.has(rawUnit)) {
    const factor = rawPackage.value / productPackage.value
    const normalizedQuantity = input.quantity * factor
    return {
      status: 'CONVERTED', normalizedQuantity, normalizedUnit,
      factor,
      note: `按盘点规格 ${input.rawSpec || '-'} 与采购规格 ${input.productSpec || '-'} 换算`,
    }
  }

  return {
    status: 'PENDING', normalizedQuantity: null, normalizedUnit, factor: null,
    note: `无法可靠换算 ${input.rawUnit} → ${input.productUnit}；需补充包装规格`,
  }
}

/** Convert BOM gross usage (g/kg/ml/count) into Product.unit. */
export function convertBomUsageToProductUnit(input: {
  quantity: number
  bomUnit: string
  productUnit: string
  productSpec?: string | null
}) {
  return normalizeInventoryQuantity({
    quantity: input.quantity,
    rawUnit: input.bomUnit,
    rawSpec: null,
    productUnit: input.productUnit,
    productSpec: input.productSpec,
  })
}
