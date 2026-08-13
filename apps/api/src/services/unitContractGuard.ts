import { Prisma } from '@dianjie/db'

/**
 * 单位契约护栏。
 *
 * 背景(2026-08 真实事故):有人把商品成本单位从「件」改成最小库存单位「g」，
 * 把每成本单位库存量从 1000 改成 1，却没有同步把 price 从「元/件」折算成
 * 「元/g」。折算公式忠实执行 price × 每订货单位 ÷ 每成本单位，于是每件单价
 * 从 ¥122 变成 ¥122,000，一张收货单直接给门店库存灌进 ¥610,000。
 *
 * 根因是 price 是个不带单位的裸数字，它的含义由 costUnit 决定，而两者之间
 * 没有任何绑定。这里补上绑定。
 *
 * 判定基准统一用「每最小库存单位成本」= price ÷ 每成本单位库存量:
 * 它是包装方式的不变量。订货单位从「箱」换成「托」会让每订货单位单价翻 12 倍，
 * 那是正确的算术，不该拦；而每克成本从 ¥0.122 跳到 ¥122，任何包装变更都
 * 解释不了，那才是错。
 */

export type UnitContractPricing = {
  price: Prisma.Decimal | number | string | null | undefined
  inventoryUnitsPerCostUnit: Prisma.Decimal | number | string | null | undefined
}

/** 每库存单位成本与历史成交成本的最大允许倍差。 */
export const COST_OUTLIER_MULTIPLE = 5

/** 相对容差:千分之一以内视为没变，容纳既有小数位的舍入。 */
const RELATIVE_TOLERANCE = new Prisma.Decimal('0.001')

function toDecimal(value: UnitContractPricing['price']): Prisma.Decimal | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  try {
    const decimal = new Prisma.Decimal(value as any)
    return decimal.isFinite() ? decimal : null
  } catch {
    return null
  }
}

/**
 * 每最小库存单位成本。契约不完整时返回 null（交给既有的四单位校验去报错，
 * 这里不重复判断）。
 */
export function inventoryUnitCost(pricing: UnitContractPricing): Prisma.Decimal | null {
  const price = toDecimal(pricing.price)
  const perCost = toDecimal(pricing.inventoryUnitsPerCostUnit)
  if (!price || !perCost || perCost.lte(0)) return null
  return price.div(perCost)
}

/**
 * Product.price 折算成每最小库存单位成本的数值版本，供成本兜底路径使用。
 *
 * price 的单位含义由 costUnit 决定，所以分母只能是 inventoryUnitsPerCostUnit。
 * 历史上有几处兜底写成 price ÷ inventoryUnitsPerPurchaseUnit——今天全部商品的
 * 这两个换算率恰好相等所以结果一致，但只要有人把成本单位设成与采购单位不同
 * (项目规则「成本单位=最小库存单位」正是要求这么做)，两者立刻差出几个数量级。
 */
export function productInventoryUnitCost(product: UnitContractPricing): number | null {
  const cost = inventoryUnitCost(product)
  return cost ? Number(cost) : null
}

function formatCost(value: Prisma.Decimal) {
  const fixed = value.gte(1) ? value.toFixed(2) : value.toSignificantDigits(4).toString()
  return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function relativeGap(before: Prisma.Decimal, next: Prisma.Decimal) {
  if (before.isZero()) return next.isZero() ? new Prisma.Decimal(0) : new Prisma.Decimal(1)
  return next.minus(before).abs().div(before.abs())
}

/**
 * 护栏一:改单位是「换一种说法」，不是「改价」。
 *
 * 调用方没有显式提交 price 时，每库存单位成本必须与改动前一致。不一致说明
 * 成本单位换了但价格语义没跟上，直接拒绝并把两个数字摆出来。
 */
export function costContractRepricingError(input: {
  before: UnitContractPricing
  next: UnitContractPricing
  priceExplicitlyProvided: boolean
  productName?: string | null
  inventoryUnit?: string | null
}): string | null {
  if (input.priceExplicitlyProvided) return null
  const before = inventoryUnitCost(input.before)
  const next = inventoryUnitCost(input.next)
  if (!before || !next) return null
  if (relativeGap(before, next).lte(RELATIVE_TOLERANCE)) return null
  const label = input.productName ? `${input.productName} ` : ''
  const unit = input.inventoryUnit ? `/${input.inventoryUnit}` : '每库存单位'
  return `${label}改动成本单位换算会让成本从 ¥${formatCost(before)}${unit} 变成 ¥${formatCost(next)}${unit}。`
    + '改单位不应该改变成本,请同时提交折算后的采购单价,或先确认换算率填对了。'
}

/**
 * 护栏二:每库存单位成本离历史成交成本太远就拦下来。
 *
 * 比较基准取收货单冻结的 inventoryUnitCostSnapshot，它同样是每最小库存单位，
 * 不受包装规格调整影响。只在样本足够时生效，新商品建档不拦。
 */
export function costOutlierError(input: {
  nextInventoryUnitCost: Prisma.Decimal | null
  historicalAverageCost: Prisma.Decimal | number | string | null | undefined
  sampleCount: number
  productName?: string | null
  inventoryUnit?: string | null
  multiple?: number
}): string | null {
  const next = input.nextInventoryUnitCost
  const average = toDecimal(input.historicalAverageCost)
  if (!next || !average || average.lte(0)) return null
  if (input.sampleCount < 2) return null
  const multiple = new Prisma.Decimal(input.multiple ?? COST_OUTLIER_MULTIPLE)
  if (next.lte(average.mul(multiple)) && next.gte(average.div(multiple))) return null
  const label = input.productName ? `${input.productName} ` : ''
  const unit = input.inventoryUnit ? `/${input.inventoryUnit}` : '每库存单位'
  return `${label}折算后的成本 ¥${formatCost(next)}${unit} 与近期收货成本 ¥${formatCost(average)}${unit} 相差超过 ${multiple.toFixed(0)} 倍。`
    + '这通常意味着单位换算率或采购单价填错了,请核对后再保存。'
}
