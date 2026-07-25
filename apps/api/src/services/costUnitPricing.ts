import { Prisma } from '@dianjie/db'
import type { ProductInventoryUnitLike } from './inventoryUnits'

type Decimalish = Prisma.Decimal | string | number

export type CostUnitPricedProduct = ProductInventoryUnitLike & {
  price: Decimalish
  name?: string | null
}

export const PURCHASE_ORDER_AMOUNT_MAX = new Prisma.Decimal('9999999999.99')
const PURCHASE_ORDER_UNIT_PRICE_MAX = new Prisma.Decimal('99999999.99')

export class CostUnitPricingError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'CostUnitPricingError'
  }
}

function costUnitPrice(product: CostUnitPricedProduct): Prisma.Decimal {
  const label = productLabel(product)
  try {
    const price = new Prisma.Decimal(product.price)
    if (price.isFinite() && price.gte(0)) return price
  } catch {
    // Normalized to the same public validation error below.
  }
  throw new CostUnitPricingError(`${label} 的采购成本单价无效`)
}

function conversionFactors(product: CostUnitPricedProduct): {
  orderFactor: Prisma.Decimal
  costFactor: Prisma.Decimal
} {
  if (isLegacyIdentityContract(product)) {
    return {
      orderFactor: new Prisma.Decimal(1),
      costFactor: new Prisma.Decimal(1),
    }
  }

  const completeUnits = [
    product.purchaseUnit,
    product.inventoryUnit,
    product.orderUnit,
    product.costUnit,
  ].every(value => String(value ?? '').trim().length > 0)
  const orderFactor = positiveFactor(product.inventoryUnitsPerOrderUnit)
  const costFactor = positiveFactor(product.inventoryUnitsPerCostUnit)
  const purchaseFactor = positiveFactor(product.inventoryUnitsPerPurchaseUnit)
  if (
    !completeUnits
    || !purchaseFactor
    || !orderFactor
    || !costFactor
    || product.unitConversionStatus === 'PENDING'
    || !['INFERRED', 'VERIFIED'].includes(String(product.unitConversionStatus || ''))
  ) {
    throw new CostUnitPricingError(`${productLabel(product)} 的四单位换算待核验或不完整，不能折算价格`)
  }
  return { orderFactor, costFactor }
}

function productLabel(product: CostUnitPricedProduct): string {
  return String(product.name || '商品')
}

function isLegacyIdentityContract(product: CostUnitPricedProduct): boolean {
  const legacyUnit = String(product.unit || '').trim()
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

  const hasNoStructuredContract = [...units, ...factors].every(
    value => value === null || value === undefined || String(value).trim() === '',
  )
  if (hasNoStructuredContract) return true

  const hasCompleteIdentityUnits = units.every(value => String(value ?? '').trim() === legacyUnit)
  if (!hasCompleteIdentityUnits) return false
  return factors.every(value => {
    if (value === null || value === undefined || String(value).trim() === '') return false
    try {
      return new Prisma.Decimal(value.toString()).equals(1)
    } catch {
      return false
    }
  })
}

function positiveFactor(value: ProductInventoryUnitLike['inventoryUnitsPerOrderUnit']): Prisma.Decimal | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  try {
    const factor = new Prisma.Decimal(value.toString())
    return factor.isFinite() && factor.gt(0) ? factor : null
  } catch {
    return null
  }
}

/**
 * Convert Product.price (the cost-unit price) into the persisted order-unit
 * price and line amount. All arithmetic stays in Decimal; rounding happens
 * only at the two persisted money-field boundaries.
 */
export function costUnitPricedOrderLine(input: {
  product: CostUnitPricedProduct
  quantity: Decimalish
}): { unitPrice: Prisma.Decimal; amount: Prisma.Decimal } {
  const { product } = input
  const label = productLabel(product)
  let quantity: Prisma.Decimal
  try {
    quantity = new Prisma.Decimal(input.quantity)
  } catch {
    throw new CostUnitPricingError(`${label} 的订货数量无效`)
  }
  if (!quantity.isFinite() || quantity.lte(0)) {
    throw new CostUnitPricingError(`${label} 的订货数量无效`)
  }

  const unitPrice = costUnitPriceToOrderUnitPrice(product)
  const amount = quantity.mul(unitPrice).toDecimalPlaces(2)
  if (amount.gt(PURCHASE_ORDER_AMOUNT_MAX)) {
    throw new CostUnitPricingError(`${label} 的单行金额超过系统上限`)
  }
  return { unitPrice, amount }
}

/** Product.stock 以 legacy unit（即 orderUnit）计量，估值前必须先折算成本单位单价。 */
export function costUnitPriceToOrderUnitPrice(
  product: CostUnitPricedProduct,
): Prisma.Decimal {
  const { orderFactor, costFactor } = conversionFactors(product)
  const unitPrice = costUnitPrice(product).mul(orderFactor).div(costFactor).toDecimalPlaces(2)
  if (unitPrice.gt(PURCHASE_ORDER_UNIT_PRICE_MAX)) {
    throw new CostUnitPricingError(`${productLabel(product)} 的每订货单位单价超过系统上限`)
  }
  return unitPrice
}

/** 汇总接口不得因单个待核验商品整体失败；null 表示该 SKU 暂不参与货值。 */
export function tryCostUnitPriceToOrderUnitPrice(
  product: CostUnitPricedProduct,
): Prisma.Decimal | null {
  try {
    return costUnitPriceToOrderUnitPrice(product)
  } catch (error) {
    if (error instanceof CostUnitPricingError) return null
    throw error
  }
}
