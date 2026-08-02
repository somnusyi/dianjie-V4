import { Prisma, prisma } from '@dianjie/db'
import { costUnitPricedOrderLine, PURCHASE_ORDER_AMOUNT_MAX } from './costUnitPricing'
import { freezeProductFourUnitsForSupplyDocument } from './supplyDocumentUnitSnapshots'
import { sumOrderAmount } from './purchaseOrderIntegrity'

export const PURCHASE_ORDER_QUANTITY_MAX = 99_999_999.99

export type OrderDraftInputLine = {
  productId: string
  quantity: number
}

export const orderDraftProductSelect = {
  id: true,
  name: true,
  unit: true,
  minOrderQty: true,
  stepQty: true,
  price: true,
  purchaseUnit: true,
  inventoryUnit: true,
  orderUnit: true,
  costUnit: true,
  inventoryUnitsPerPurchaseUnit: true,
  inventoryUnitsPerOrderUnit: true,
  inventoryUnitsPerCostUnit: true,
  unitConversionStatus: true,
} satisfies Prisma.ProductSelect

export type OrderDraftProduct = Prisma.ProductGetPayload<{ select: typeof orderDraftProductSelect }>

export type OrderDraftIssue = {
  code: 'DUPLICATE_PRODUCT' | 'PRODUCT_UNAVAILABLE' | 'BELOW_MINIMUM' | 'INVALID_STEP' | 'PRICE_UNAVAILABLE' | 'AMOUNT_LIMIT'
  productId?: string
  productName?: string
  message: string
}

export type ValidatedOrderDraftLine = {
  productId: string
  quantity: number
  originalQuantity: number
  unitPrice: Prisma.Decimal
  originalUnitPrice: Prisma.Decimal
  amount: Prisma.Decimal
  originalAmount: Prisma.Decimal
  lineOrigin: 'ORIGINAL'
} & ReturnType<typeof freezeProductFourUnitsForSupplyDocument>

export async function loadOrderDraftProducts(input: {
  tenantId: string
  supplierId: string
  productIds: string[]
}): Promise<OrderDraftProduct[]> {
  return prisma.product.findMany({
    where: {
      id: { in: input.productIds },
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      status: 'ENABLED',
    },
    select: orderDraftProductSelect,
  })
}

/**
 * The authoritative, side-effect-free validation shared by real order creation
 * and the supply-chain simulation. Keep all order-entry constraints here so a
 * simulation cannot drift away from what POST /api/orders accepts.
 */
export function validateOrderDraftLines(
  products: OrderDraftProduct[],
  items: OrderDraftInputLine[],
): {
  ok: boolean
  issues: OrderDraftIssue[]
  lines: ValidatedOrderDraftLine[]
  totalAmount: Prisma.Decimal | null
} {
  const issues: OrderDraftIssue[] = []
  const productIds = items.map(item => item.productId)
  if (new Set(productIds).size !== productIds.length) {
    issues.push({ code: 'DUPLICATE_PRODUCT', message: '同一商品不能重复提交多行' })
  }

  const productMap = new Map(products.map(product => [product.id, product]))
  for (const item of items) {
    if (!productMap.has(item.productId)) {
      issues.push({
        code: 'PRODUCT_UNAVAILABLE',
        productId: item.productId,
        message: '商品无效、已停售或不属于所选供应商',
      })
    }
  }

  const lines: ValidatedOrderDraftLine[] = []
  for (const item of items) {
    const product = productMap.get(item.productId)
    if (!product) continue
    const minimum = Number(product.minOrderQty || 1)
    const step = Number(product.stepQty || 1)
    const quantity = Number(item.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > PURCHASE_ORDER_QUANTITY_MAX) {
      issues.push({
        code: 'BELOW_MINIMUM',
        productId: product.id,
        productName: product.name,
        message: `${product.name} 订货数量无效`,
      })
      continue
    }
    if (quantity < minimum - 0.0001) {
      issues.push({
        code: 'BELOW_MINIMUM',
        productId: product.id,
        productName: product.name,
        message: `${product.name} 起订量为 ${minimum} ${product.unit}，当前 ${quantity}`,
      })
      continue
    }
    if (step > 0 && Math.abs(((quantity - minimum) / step) - Math.round((quantity - minimum) / step)) > 0.0001) {
      issues.push({
        code: 'INVALID_STEP',
        productId: product.id,
        productName: product.name,
        message: `${product.name} 需以 ${step} ${product.unit} 为步长（起订 ${minimum}）`,
      })
      continue
    }

    try {
      const { unitPrice, amount } = costUnitPricedOrderLine({ product, quantity })
      if (amount.gt(PURCHASE_ORDER_AMOUNT_MAX)) {
        issues.push({
          code: 'AMOUNT_LIMIT',
          productId: product.id,
          productName: product.name,
          message: `${product.name} 单行金额超过系统上限`,
        })
        continue
      }
      lines.push({
        productId: product.id,
        quantity,
        originalQuantity: quantity,
        unitPrice,
        originalUnitPrice: unitPrice,
        amount,
        originalAmount: amount,
        lineOrigin: 'ORIGINAL',
        ...freezeProductFourUnitsForSupplyDocument(product),
      })
    } catch (error: any) {
      issues.push({
        code: 'PRICE_UNAVAILABLE',
        productId: product.id,
        productName: product.name,
        message: error?.message || `${product.name} 无法计算订货价，请核验单位换算`,
      })
    }
  }

  const totalAmount = issues.length === 0 ? sumOrderAmount(lines) : null
  if (totalAmount?.gt(PURCHASE_ORDER_AMOUNT_MAX)) {
    issues.push({ code: 'AMOUNT_LIMIT', message: '订货单总金额超过系统上限' })
    return { ok: false, issues, lines: [], totalAmount: null }
  }
  return { ok: issues.length === 0, issues, lines: issues.length === 0 ? lines : [], totalAmount }
}
