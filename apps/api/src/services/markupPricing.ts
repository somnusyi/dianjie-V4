import { Prisma } from '@dianjie/db'

/**
 * 比例加价定价（2026-08-20 负责人需求，对标美团「配送价格规则-比例加价」）。
 *
 * 背景：菌菇等时价品每次入库成本不同，固定价需要人工每次核对；美团侧已用
 * 「库存均价 × (1+加价比例)」自动定配送价，V4 不用就会两边口径劈叉。
 *
 * 规则：
 * - 商品 pricingMode = MARKUP 时启用；FIXED / null 为固定价
 * - 加价比例取 商品 markupPercent ?? 所属分类 defaultMarkupPercent（商品优先）
 * - 基准 = 总仓库存移动均价（WarehouseLedgerBalance.averageUnitCost，每最小库存单位），
 *   与美团「库存均价(不含税)」同口径
 * - 卖价 = 均价 × 每成本单位库存量 × (1+比例%)，保留 2 位小数（products.price 精度）
 *
 * 触发：入库类流水改变均价后（手工入库/批量入库/美团每日包/实盘/期初/冲回）。
 * 自动调价是「既定规则驱动的系统行为」，不走总厨涨价审批（涨价审批管的是人工改价），
 * 每次自动调价写 opLog 溯源（旧价、新价、当时均价、触发流水）。
 */

type Tx = Prisma.TransactionClient

export type MarkupTrigger = {
  type: string // 触发来源，如 WarehouseManualInbound / MeituanDailyPackage
  id: string   // 触发单据/流水 id
}

export type MarkupResolution = {
  effectiveMode: 'FIXED' | 'MARKUP'
  markupPercent: Prisma.Decimal | null
  markupSource: 'PRODUCT' | 'CATEGORY' | null
}

type ProductPricingSnapshot = {
  id: string
  name: string
  status: string
  price: Prisma.Decimal | number | string
  pricingMode: string | null
  markupPercent: Prisma.Decimal | number | string | null
  supplierId: string | null
  category: string | null
  costUnit: string | null
  inventoryUnit: string | null
  inventoryUnitsPerCostUnit: Prisma.Decimal | number | string | null
}

function toDecimal(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  try {
    const d = new Prisma.Decimal(value as any)
    return d.isFinite() ? d : null
  } catch {
    return null
  }
}

/**
 * 解析商品的生效定价方式与加价比例。
 * 商品 pricingMode=FIXED 显式固定价，优先于一切；未设置时分类默认比例兜底。
 */
export async function resolveProductMarkup(
  tx: Tx,
  tenantId: string,
  product: Pick<ProductPricingSnapshot, 'pricingMode' | 'markupPercent' | 'supplierId' | 'category'>,
): Promise<MarkupResolution> {
  if (product.pricingMode === 'FIXED') {
    return { effectiveMode: 'FIXED', markupPercent: null, markupSource: null }
  }
  const own = toDecimal(product.markupPercent)
  if (own !== null) {
    return { effectiveMode: 'MARKUP', markupPercent: own, markupSource: 'PRODUCT' }
  }
  if (product.supplierId && product.category) {
    const category = await tx.supplierProductCategory.findUnique({
      where: {
        tenantId_supplierId_name: {
          tenantId,
          supplierId: product.supplierId,
          name: product.category,
        },
      },
      select: { isActive: true, defaultMarkupPercent: true },
    })
    const categoryMarkup = category?.isActive ? toDecimal(category.defaultMarkupPercent) : null
    if (categoryMarkup !== null) {
      return { effectiveMode: 'MARKUP', markupPercent: categoryMarkup, markupSource: 'CATEGORY' }
    }
  }
  return { effectiveMode: 'FIXED', markupPercent: null, markupSource: null }
}

/**
 * 卖价 = 库存均价 × 每成本单位库存量 × (1 + 比例/100)，2 位小数。
 * 任一输入非法返回 null（调用方跳过，不报错）。
 */
export function computeMarkupPrice(input: {
  averageUnitCost: Prisma.Decimal | number | string | null | undefined
  inventoryUnitsPerCostUnit: Prisma.Decimal | number | string | null | undefined
  markupPercent: Prisma.Decimal | number | string | null | undefined
}): Prisma.Decimal | null {
  const avg = toDecimal(input.averageUnitCost)
  const factor = toDecimal(input.inventoryUnitsPerCostUnit)
  const markup = toDecimal(input.markupPercent)
  if (!avg || avg.lte(0) || !factor || factor.lte(0) || markup === null || markup.lt(0)) return null
  return avg.mul(factor).mul(markup.plus(100).div(100)).toDecimalPlaces(2)
}

/**
 * 入库类流水改均价后调用：若商品启用比例加价则按最新均价重算卖价并留痕。
 * 价格未变化 / 未启用 / 数据非法时返回 null（安静跳过）。
 */
export async function applyMarkupReprice(
  tx: Tx,
  input: {
    tenantId: string
    productId: string
    averageUnitCost: Prisma.Decimal | number | string
    trigger: MarkupTrigger
  },
): Promise<{ oldPrice: Prisma.Decimal; newPrice: Prisma.Decimal; markupPercent: Prisma.Decimal; markupSource: string } | null> {
  const product = await tx.product.findFirst({
    where: { id: input.productId, tenantId: input.tenantId },
    select: {
      id: true, name: true, status: true, price: true,
      pricingMode: true, markupPercent: true, supplierId: true, category: true,
      costUnit: true, inventoryUnit: true, inventoryUnitsPerCostUnit: true,
    },
  })
  if (!product || product.status !== 'ENABLED') return null

  const resolution = await resolveProductMarkup(tx, input.tenantId, product)
  if (resolution.effectiveMode !== 'MARKUP' || resolution.markupPercent === null) return null

  const newPrice = computeMarkupPrice({
    averageUnitCost: input.averageUnitCost,
    inventoryUnitsPerCostUnit: product.inventoryUnitsPerCostUnit,
    markupPercent: resolution.markupPercent,
  })
  if (!newPrice) return null

  const oldPrice = new Prisma.Decimal(product.price)
  if (newPrice.equals(oldPrice)) return null

  await tx.product.update({
    where: { id: product.id },
    data: { price: newPrice },
  })
  const costUnit = product.costUnit || product.inventoryUnit || ''
  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      action: `比例加价自动调价 ${product.name}: ¥${oldPrice.toFixed(2)} → ¥${newPrice.toFixed(2)}/${costUnit}`
        + `（库存均价 ¥${toDecimal(input.averageUnitCost)!.toFixed(6)}/${product.inventoryUnit || '库存单位'} × (1+${resolution.markupPercent.toFixed(2)}%)）`,
      target: product.id,
      targetId: product.id,
      entityType: 'Product',
      metadata: {
        productId: product.id,
        oldPrice: oldPrice.toFixed(2),
        newPrice: newPrice.toFixed(2),
        averageUnitCost: toDecimal(input.averageUnitCost)!.toFixed(6),
        inventoryUnit: product.inventoryUnit,
        costUnit,
        markupPercent: resolution.markupPercent.toFixed(2),
        markupSource: resolution.markupSource,
        triggerType: input.trigger.type,
        triggerId: input.trigger.id,
      },
    },
  })
  return {
    oldPrice,
    newPrice,
    markupPercent: resolution.markupPercent,
    markupSource: resolution.markupSource!,
  }
}
