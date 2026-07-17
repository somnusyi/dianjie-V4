export type InventoryUnitNormalization = {
  status: 'EXACT' | 'CONVERTED' | 'PENDING'
  normalizedQuantity: number | null
  normalizedUnit: string
  factor: number | null
  note: string
}

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
  const amountThenCount = spec.match(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)(?:[*\/])(\d+(?:\.\d+)?)(?:包|袋|瓶|盒|桶|罐|个|枚|支|片)/)
  if (amountThenCount) {
    const base = quantityTokenToBase(Number(amountThenCount[1]), amountThenCount[2])
    if (base) return { dimension: base.dimension, value: base.value * Number(amountThenCount[3]) }
  }

  // 20包/500g, 24瓶/330ml
  const countThenAmount = spec.match(/(\d+(?:\.\d+)?)(?:包|袋|瓶|盒|桶|罐|个|枚|支|片)[*\/](\d+(?:\.\d+)?)(kg|g|斤|ml|l)/)
  if (countThenAmount) {
    const base = quantityTokenToBase(Number(countThenAmount[2]), countThenAmount[3])
    if (base) return { dimension: base.dimension, value: base.value * Number(countThenAmount[1]) }
  }

  // If several physical amounts are present (e.g. 箱/10斤/500g), the largest
  // one is the package total and the smaller one is normally a per-bag hint.
  const candidates = [...spec.matchAll(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)/g)]
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
  const amountThenCount = spec.match(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)[*\/](\d+(?:\.\d+)?)(包|袋|瓶|盒|桶|罐|个|枚|支|片)(?:\/(?:箱|件))?/)
  if (amountThenCount) {
    const oneInner = quantityTokenToBase(Number(amountThenCount[1]), amountThenCount[2])
    if (oneInner) {
      if (packageUnitsEquivalent(productUnit, amountThenCount[4])) return oneInner
      return { dimension: oneInner.dimension, value: oneInner.value * Number(amountThenCount[3]) }
    }
  }

  // 箱/20包/500g, 件/24瓶/330ml
  const countThenAmount = spec.match(/(\d+(?:\.\d+)?)(包|袋|瓶|盒|桶|罐|个|枚|支|片)[*\/](\d+(?:\.\d+)?)(kg|g|斤|ml|l)/)
  if (countThenAmount) {
    const oneInner = quantityTokenToBase(Number(countThenAmount[3]), countThenAmount[4])
    if (oneInner) {
      if (packageUnitsEquivalent(productUnit, countThenAmount[2])) return oneInner
      return { dimension: oneInner.dimension, value: oneInner.value * Number(countThenAmount[1]) }
    }
  }

  // 1.5kg*6/箱.  Here the inner unit label is omitted; 箱/件 is the outer unit.
  const amountTimesBareCount = spec.match(/(\d+(?:\.\d+)?)(kg|g|斤|ml|l)\*(\d+(?:\.\d+)?)\/(?:箱|件)/)
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
