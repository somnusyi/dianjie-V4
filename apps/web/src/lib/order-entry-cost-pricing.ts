/**
 * 旧 PC 采购作战台的成本价预览。
 *
 * Product.price 是每 costUnit 的价格；订单持久化的是每 orderUnit 的价格。
 * 本文件用十进制字符串和 BigInt 计算，确保预览与 API 在两个金额边界上的
 * Decimal 四舍五入一致，且不会把待核验的四单位合同猜成 1:1。
 */

export type OrderEntryProductSnapshot = {
  name?: string | null
  price?: number | string | null
  unit?: string | null
  purchaseUnit?: string | null
  inventoryUnit?: string | null
  orderUnit?: string | null
  costUnit?: string | null
  inventoryUnitsPerPurchaseUnit?: number | string | null
  inventoryUnitsPerOrderUnit?: number | string | null
  inventoryUnitsPerCostUnit?: number | string | null
  unitConversionStatus?: string | null
}

export type OrderEntryCostPricing =
  | {
      status: 'READY'
      orderUnitPrice: string
      orderUnit: string
      unitLabel: string
      costPriceSource: string
    }
  | {
      status: 'PENDING'
      message: string
    }

type DecimalValue = {
  coefficient: bigint
  scale: number
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/
const MAX_SUPPORTED_EXPONENT = 100
const BIG_ZERO = BigInt(0)
const BIG_ONE = BigInt(1)
const BIG_TWO = BigInt(2)
const BIG_TEN = BigInt(10)
const BIG_HUNDRED = BigInt(100)

function productLabel(product: OrderEntryProductSnapshot): string {
  return String(product.name || '该商品').trim() || '该商品'
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim()
}

function parseDecimal(value: unknown): DecimalValue | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null

  const text = trimmed(value)
  const match = DECIMAL_PATTERN.exec(text)
  if (!match) return null

  const exponent = Number(match[4] || 0)
  if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_SUPPORTED_EXPONENT) return null

  const fraction = match[3] || ''
  let coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`)
  let scale = fraction.length - exponent
  if (scale < 0) {
    coefficient *= BIG_TEN ** BigInt(-scale)
    scale = 0
  }
  return { coefficient, scale }
}

function isPositive(value: DecimalValue | null): value is DecimalValue {
  return value !== null && value.coefficient > BIG_ZERO
}

function isNonNegative(value: DecimalValue | null): value is DecimalValue {
  return value !== null && value.coefficient >= BIG_ZERO
}

function decimalEqualsOne(value: unknown): boolean {
  const parsed = parseDecimal(value)
  return parsed !== null && parsed.coefficient === BIG_TEN ** BigInt(parsed.scale)
}

function roundDivision(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return remainder * BIG_TWO >= denominator ? quotient + BIG_ONE : quotient
}

function toCents(value: DecimalValue): bigint {
  if (value.scale <= 2) {
    return value.coefficient * BIG_TEN ** BigInt(2 - value.scale)
  }
  return roundDivision(value.coefficient, BIG_TEN ** BigInt(value.scale - 2))
}

function formatCents(cents: bigint): string {
  const whole = cents / BIG_HUNDRED
  const fraction = (cents % BIG_HUNDRED).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}

function moneyText(value: DecimalValue): string {
  return formatCents(toCents(value))
}

function pending(product: OrderEntryProductSnapshot): OrderEntryCostPricing {
  return {
    status: 'PENDING',
    message: `${productLabel(product)} 的四单位换算待核验或不完整，暂不能计算订货价格`,
  }
}

function isLegacyIdentityContract(product: OrderEntryProductSnapshot): boolean {
  const legacyUnit = trimmed(product.unit)
  if (!legacyUnit) return false

  const units = [
    product.purchaseUnit,
    product.inventoryUnit,
    product.orderUnit,
    product.costUnit,
  ]
  const factors = [
    product.inventoryUnitsPerPurchaseUnit,
    product.inventoryUnitsPerOrderUnit,
    product.inventoryUnitsPerCostUnit,
  ]
  const hasNoStructuredContract = [...units, ...factors].every(value => trimmed(value) === '')
  if (hasNoStructuredContract) return true

  return (
    units.every(value => trimmed(value) === legacyUnit)
    && factors.every(decimalEqualsOne)
  )
}

function readyPricing(
  product: OrderEntryProductSnapshot,
  price: DecimalValue,
  orderUnit: string,
  costUnit: string,
  orderFactor: DecimalValue,
  costFactor: DecimalValue,
): OrderEntryCostPricing {
  const numerator = price.coefficient
    * orderFactor.coefficient
    * BIG_TEN ** BigInt(costFactor.scale)
    * BIG_HUNDRED
  const denominator = costFactor.coefficient
    * BIG_TEN ** BigInt(price.scale + orderFactor.scale)
  const orderUnitPrice = formatCents(roundDivision(numerator, denominator))

  return {
    status: 'READY',
    orderUnitPrice,
    orderUnit,
    unitLabel: `元 / ${orderUnit}`,
    costPriceSource: `成本价来源：¥${moneyText(price)} / ${costUnit}`,
  }
}

/**
 * 从商品快照解析采购订单价格。
 *
 * 仅两类兼容合同可绕过核验状态：
 * 1. 只有 legacy unit、完全没有结构化四单位字段；
 * 2. 四个结构化单位均与 legacy unit 同名，三个因子均严格为 1。
 */
export function resolveOrderEntryCostPricing(
  product: OrderEntryProductSnapshot,
): OrderEntryCostPricing {
  const price = parseDecimal(product.price)
  if (!isNonNegative(price)) {
    return {
      status: 'PENDING',
      message: `${productLabel(product)} 的采购成本单价无效，暂不能计算订货价格`,
    }
  }

  const legacyUnit = trimmed(product.unit)
  if (isLegacyIdentityContract(product)) {
    const identityFactor = { coefficient: BIG_ONE, scale: 0 }
    return readyPricing(product, price, legacyUnit, legacyUnit, identityFactor, identityFactor)
  }

  const units = [
    trimmed(product.purchaseUnit),
    trimmed(product.inventoryUnit),
    trimmed(product.orderUnit),
    trimmed(product.costUnit),
  ]
  const purchaseFactor = parseDecimal(product.inventoryUnitsPerPurchaseUnit)
  const orderFactor = parseDecimal(product.inventoryUnitsPerOrderUnit)
  const costFactor = parseDecimal(product.inventoryUnitsPerCostUnit)
  const status = trimmed(product.unitConversionStatus)

  if (
    units.some(unit => unit === '')
    || !isPositive(purchaseFactor)
    || !isPositive(orderFactor)
    || !isPositive(costFactor)
    || !['INFERRED', 'VERIFIED'].includes(status)
  ) {
    return pending(product)
  }

  return readyPricing(product, price, units[2], units[3], orderFactor, costFactor)
}

/** 按 API 的顺序，用已舍入到分的订货单价计算并舍入行金额。 */
export function calculateOrderEntryLineAmount(
  quantity: number | string,
  orderUnitPrice: number | string,
): string | null {
  const parsedQuantity = parseDecimal(quantity)
  const parsedPrice = parseDecimal(orderUnitPrice)
  if (!isPositive(parsedQuantity) || !isNonNegative(parsedPrice)) return null

  const numerator = parsedQuantity.coefficient * parsedPrice.coefficient * BIG_HUNDRED
  const denominator = BIG_TEN ** BigInt(parsedQuantity.scale + parsedPrice.scale)
  return formatCents(roundDivision(numerator, denominator))
}

/** 合计已经舍入到分的行金额；任一行无效时不返回可能误导的部分合计。 */
export function sumOrderEntryLineAmounts(
  amounts: Array<string | null>,
): string | null {
  let total = BIG_ZERO
  for (const amount of amounts) {
    const parsed = parseDecimal(amount)
    if (!isNonNegative(parsed)) return null
    total += toCents(parsed)
  }
  return formatCents(total)
}
