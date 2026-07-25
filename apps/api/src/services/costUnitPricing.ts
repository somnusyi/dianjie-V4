import { Prisma } from '@dianjie/db'
import type { ProductInventoryUnitLike } from './inventoryUnits'

type Decimalish = Prisma.Decimal | string | number

type CostUnitPricedProduct = ProductInventoryUnitLike & {
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
  const legacyIdentity = isLegacyIdentityContract(product)

  let orderFactor = new Prisma.Decimal(1)
  let costFactor = new Prisma.Decimal(1)
  if (!legacyIdentity) {
    const completeUnits = [
      product.purchaseUnit,
      product.inventoryUnit,
      product.orderUnit,
      product.costUnit,
    ].every(value => String(value ?? '').trim().length > 0)
    orderFactor = positiveFactor(product.inventoryUnitsPerOrderUnit) ?? new Prisma.Decimal(0)
    costFactor = positiveFactor(product.inventoryUnitsPerCostUnit) ?? new Prisma.Decimal(0)
    const purchaseFactor = positiveFactor(product.inventoryUnitsPerPurchaseUnit)
    if (
      !completeUnits
      || !purchaseFactor
      || !orderFactor.gt(0)
      || !costFactor.gt(0)
      || product.unitConversionStatus === 'PENDING'
      || !['INFERRED', 'VERIFIED'].includes(String(product.unitConversionStatus || ''))
    ) {
      throw new CostUnitPricingError(`${label} 的四单位换算待核验或不完整，不能创建订货行`)
    }
  }

  let costUnitPrice: Prisma.Decimal
  let quantity: Prisma.Decimal
  try {
    costUnitPrice = new Prisma.Decimal(product.price)
    quantity = new Prisma.Decimal(input.quantity)
  } catch {
    throw new CostUnitPricingError(`${label} 的采购成本单价或订货数量无效`)
  }
  if (!costUnitPrice.isFinite() || costUnitPrice.lt(0) || !quantity.isFinite() || quantity.lte(0)) {
    throw new CostUnitPricingError(`${label} 的采购成本单价或订货数量无效`)
  }

  const preciseOrderUnitPrice = costUnitPrice.mul(orderFactor).div(costFactor)
  const unitPrice = preciseOrderUnitPrice.toDecimalPlaces(2)
  if (unitPrice.gt(PURCHASE_ORDER_UNIT_PRICE_MAX)) {
    throw new CostUnitPricingError(`${label} 的每订货单位单价超过系统上限`)
  }

  const amount = quantity.mul(unitPrice).toDecimalPlaces(2)
  if (amount.gt(PURCHASE_ORDER_AMOUNT_MAX)) {
    throw new CostUnitPricingError(`${label} 的单行金额超过系统上限`)
  }
  return { unitPrice, amount }
}
