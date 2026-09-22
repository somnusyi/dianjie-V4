import { Prisma, prisma } from '@dianjie/db'
import { costUnitPricedOrderLine, PURCHASE_ORDER_AMOUNT_MAX } from './costUnitPricing'
import { freezeProductFourUnitsForSupplyDocument } from './supplyDocumentUnitSnapshots'
import { sumOrderAmount } from './purchaseOrderIntegrity'
import { getWarehouseLedgerMode } from './warehouseLedger'

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
  stock: true,
} satisfies Prisma.ProductSelect

export type OrderDraftProduct = Prisma.ProductGetPayload<{ select: typeof orderDraftProductSelect }> & {
  availableStock: number
  inventoryEnforced: boolean
  warehouseOrderEntryPolicyApplies: boolean
}

export type OrderDraftIssue = {
  code: 'DUPLICATE_PRODUCT' | 'PRODUCT_UNAVAILABLE' | 'OUT_OF_STOCK' | 'BELOW_MINIMUM' | 'INVALID_STEP' | 'PRICE_UNAVAILABLE' | 'AMOUNT_LIMIT'
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
  const [products, supplier] = await Promise.all([prisma.product.findMany({
    where: {
      id: { in: input.productIds },
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      status: 'ENABLED',
    },
    select: orderDraftProductSelect,
  }), prisma.supplier.findFirst({
    where: { id: input.supplierId, tenantId: input.tenantId },
    select: { inventoryMode: true, sourceType: true },
  })])
  const warehouseSource = supplier?.sourceType === 'HEADQ_WAREHOUSE'
  const warehouseLedger = warehouseSource ? await getWarehouseLedgerMode(input.tenantId) : null
  // 这一新策略只属于内部总仓。外部供应商继续保持基线行为：
  // 断货时提醒但允许提交，库存预占在接单阶段处理。
  const inventoryEnforced = warehouseSource && Boolean(warehouseLedger?.blockZeroStockAtOrderEntry)
  const productIds = products.map(product => product.id)
  const warehouseBalances = inventoryEnforced && warehouseLedger
    ? await prisma.warehouseLedgerBalance.findMany({
        where: {
          tenantId: input.tenantId,
          warehouseId: warehouseLedger.warehouseId,
          productId: { in: productIds },
        },
        select: { productId: true, physicalQty: true, reservedQty: true },
      })
    : []
  const warehouseBalanceByProduct = new Map(warehouseBalances.map(balance => [balance.productId, balance]))
  return products.map(product => ({
    ...product,
    availableStock: Math.max(0, inventoryEnforced
      ? Number(warehouseBalanceByProduct.get(product.id)?.physicalQty || 0)
        - Number(warehouseBalanceByProduct.get(product.id)?.reservedQty || 0)
      : Number(product.stock || 0)),
    inventoryEnforced,
    warehouseOrderEntryPolicyApplies: warehouseSource,
  }))
}

/**
 * Close the policy-switch race at the actual order write boundary.
 *
 * The supplier and warehouse rows are locking reads inside the serializable
 * order transaction. Policy updates need an exclusive lock on the same
 * warehouse row. If a policy update wins after this transaction's snapshot,
 * PostgreSQL raises a serialization conflict and the route retries the whole
 * transaction instead of continuing with stale policy data.
 */
export async function enforceWarehouseOrderEntryPolicyInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    supplierId: string
    items: Array<{ productId: string; productName: string }>
  },
) {
  const suppliers = await tx.$queryRaw<Array<{ sourceType: string }>>`
    SELECT "sourceType"::text AS "sourceType"
    FROM "suppliers"
    WHERE "id" = ${input.supplierId} AND "tenantId" = ${input.tenantId}
    FOR SHARE
  `
  const supplier = suppliers[0]
  if (supplier?.sourceType !== 'HEADQ_WAREHOUSE') return

  const warehouses = await tx.$queryRaw<Array<{ id: string; blockZeroStockAtOrderEntry: boolean }>>`
    SELECT "id", "blockZeroStockAtOrderEntry"
    FROM "warehouses"
    WHERE "tenantId" = ${input.tenantId} AND "isDefault" = true AND "isActive" = true
    FOR SHARE
  `
  const warehouse = warehouses[0]
  if (!warehouse) throw Object.assign(new Error('总仓不存在或已停用'), { statusCode: 404 })
  if (!warehouse.blockZeroStockAtOrderEntry) return

  const balances = await tx.warehouseLedgerBalance.findMany({
    where: {
      tenantId: input.tenantId,
      warehouseId: warehouse.id,
      productId: { in: input.items.map(item => item.productId) },
    },
    select: { productId: true, physicalQty: true, reservedQty: true },
  })
  const byProduct = new Map(balances.map(balance => [balance.productId, balance]))
  const blocked = input.items.find(item => {
    const balance = byProduct.get(item.productId)
    return Number(balance?.physicalQty || 0) - Number(balance?.reservedQty || 0) <= 0
  })
  if (blocked) {
    throw Object.assign(new Error(`${blocked.productName} 当前可用库存为 0，不能提交订单`), { statusCode: 400 })
  }
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
    if (product.inventoryEnforced && product.availableStock <= 0) {
      issues.push({
        code: 'OUT_OF_STOCK',
        productId: product.id,
        productName: product.name,
        message: `${product.name} 当前可用库存为 0，不能下单`,
      })
      continue
    }
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
