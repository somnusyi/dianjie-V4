import { Prisma, prisma } from '@dianjie/db'

type Decimalish = Prisma.Decimal | string | number

type DeliveryProfitItemInput = {
  id: string
  productId: string
  purchaseOrderItemId: string | null
  orderedQtySnapshot: Decimalish
  shippedQty: Decimalish
  unitPriceSnapshot: Decimalish
  amount: Decimalish
}

export type DeliveryProfitInput = {
  id: string
  items: DeliveryProfitItemInput[]
}

type OutboundRow = {
  id: string
  productId: string
  sourceId: string
  sourceLineId: string | null
  originalQuantity: Decimalish
  valueDelta: Decimalish
}

type ReversalRow = {
  id?: string
  productId?: string
  sourceLineId: string
  originalQuantity: Decimalish
  valueDelta: Decimalish
  sourceType: string
}

export type DeliveryProfitLine = {
  itemId: string
  acceptedQuantity: string
  shippedQuantity: string
  unitPrice: string
  shippedAmount: string
  settlementQuantity: string
  settlementAmount: string
  costUnitPrice: string | null
  costAmount: string | null
  profit: string | null
}

export type DeliveryProfitProjection = {
  shippedAmount: string
  settlementAmount: string
  costAmount: string | null
  profit: string | null
  completeCost: boolean
  warnings: string[]
  lines: DeliveryProfitLine[]
}

const ZERO = new Prisma.Decimal(0)
const PROFIT_REVERSAL_SOURCES = new Set([
  'ReceiptRejectionReversal',
  'LossClaimReversal',
  'DeliveryOrderShipCancel',
])

function decimal(value: Decimalish | null | undefined) {
  return new Prisma.Decimal(value ?? 0)
}

function money(value: Prisma.Decimal) {
  return value.toDecimalPlaces(2).toFixed(2)
}

function quantity(value: Prisma.Decimal) {
  return value.toDecimalPlaces(2).toFixed(2)
}

export type DeliveryMovementEconomics = {
  quantity: Prisma.Decimal
  settlementAmount: Prisma.Decimal
  costAmount: Prisma.Decimal
  profit: Prisma.Decimal
}

/**
 * 配送利润的最小逐流水口径。出库流水 valueDelta 为负，认可冲回为正；
 * 返回值统一是正数绝对额，由报表根据流向决定展示符号。
 */
export function projectDeliveryMovementEconomics(input: {
  direction: 'OUTBOUND' | 'REVERSAL'
  quantity: Decimalish
  valueDelta: Decimalish
  unitPrice: Decimalish
}): DeliveryMovementEconomics | null {
  const movementQuantity = decimal(input.quantity)
  const valueDelta = decimal(input.valueDelta)
  const unitPrice = decimal(input.unitPrice)
  if (movementQuantity.isNegative() || unitPrice.isNegative()) return null
  const costAmount = input.direction === 'OUTBOUND' ? valueDelta.negated() : valueDelta
  if (costAmount.isNegative()) return null
  const settlementAmount = movementQuantity.mul(unitPrice)
  return { quantity: movementQuantity, settlementAmount, costAmount, profit: settlementAmount.minus(costAmount) }
}

/**
 * Project a delivery document from frozen shipment prices and frozen warehouse
 * ledger costs. Reversals reduce both settlement revenue and cost. Missing or
 * unmatchable cost facts stay null; they are never replaced by current product
 * prices or zero.
 */
export function projectDeliveryProfits(
  deliveries: DeliveryProfitInput[],
  outboundRows: OutboundRow[],
  reversalRows: ReversalRow[],
) {
  const reversalsByMovement = new Map<string, ReversalRow[]>()
  for (const reversal of reversalRows) {
    if (!PROFIT_REVERSAL_SOURCES.has(reversal.sourceType)) continue
    const rows = reversalsByMovement.get(reversal.sourceLineId) || []
    rows.push(reversal)
    reversalsByMovement.set(reversal.sourceLineId, rows)
  }

  const outboundsByLine = new Map<string, OutboundRow[]>()
  for (const row of outboundRows) {
    if (!row.sourceLineId) continue
    const key = `${row.sourceId}/${row.sourceLineId}`
    const rows = outboundsByLine.get(key) || []
    rows.push(row)
    outboundsByLine.set(key, rows)
  }

  const result = new Map<string, DeliveryProfitProjection>()
  for (const delivery of deliveries) {
    const warnings = new Set<string>()
    const lines: DeliveryProfitLine[] = delivery.items.map(item => {
      const acceptedQuantity = decimal(item.orderedQtySnapshot)
      const shippedQuantity = decimal(item.shippedQty)
      const unitPrice = decimal(item.unitPriceSnapshot)
      const shippedAmount = decimal(item.amount)
      const sourceLineId = item.purchaseOrderItemId
      const candidateMovements = sourceLineId
        ? outboundsByLine.get(`${delivery.id}/${sourceLineId}`) || []
        : []
      const hasMismatchedProduct = candidateMovements.some(movement => movement.productId !== item.productId)
      const movements = hasMismatchedProduct ? [] : candidateMovements

      let settlementQuantity = shippedQuantity
      let settlementAmount = shippedAmount
      let costAmount: Prisma.Decimal | null = null
      if (hasMismatchedProduct) {
        warnings.add('物品与冻结出库流水不一致，相关利润未计算')
      } else if (movements.length > 0) {
        settlementQuantity = ZERO
        settlementAmount = ZERO
        costAmount = ZERO
        let invalidCost = false
        let outboundQuantityTotal = ZERO
        let shipCancelQuantity = ZERO
        for (const movement of movements) {
          const outboundQuantity = decimal(movement.originalQuantity)
          if (outboundQuantity.isNegative()) {
            warnings.add('出库数量流水异常，相关利润未计算')
            invalidCost = true
            break
          }
          if (decimal(movement.valueDelta).negated().isNegative()) {
            warnings.add('出库成本流水方向异常，相关利润未计算')
            invalidCost = true
            break
          }
          const economics = projectDeliveryMovementEconomics({
            direction: 'OUTBOUND', quantity: movement.originalQuantity, valueDelta: movement.valueDelta, unitPrice,
          })
          if (!economics) {
            warnings.add('出库数量流水异常，相关利润未计算')
            invalidCost = true
            break
          }
          outboundQuantityTotal = outboundQuantityTotal.plus(economics.quantity)
          settlementQuantity = settlementQuantity.plus(economics.quantity)
          settlementAmount = settlementAmount.plus(economics.settlementAmount)
          costAmount = costAmount.plus(economics.costAmount)
          for (const reversal of reversalsByMovement.get(movement.id) || []) {
            if (reversal.productId && reversal.productId !== movement.productId) {
              warnings.add('冲回物品与原出库流水不一致，已排除该冲回')
              continue
            }
            const reversalEconomics = projectDeliveryMovementEconomics({
              direction: 'REVERSAL', quantity: reversal.originalQuantity, valueDelta: reversal.valueDelta, unitPrice,
            })
            if (!reversalEconomics) {
              warnings.add('冲回数量或成本流水异常，相关利润未计算')
              invalidCost = true
              break
            }
            if (reversal.sourceType === 'DeliveryOrderShipCancel') {
              shipCancelQuantity = shipCancelQuantity.plus(reversalEconomics.quantity)
            }
            settlementQuantity = settlementQuantity.minus(reversalEconomics.quantity)
            settlementAmount = settlementAmount.minus(reversalEconomics.settlementAmount)
            costAmount = costAmount.minus(reversalEconomics.costAmount)
          }
          if (invalidCost) break
        }
        // A pre-receipt shipment reduction updates DeliveryOrderItem.shippedQty
        // and writes a ShipCancel reversal. Receipt rejection/loss reversals do
        // not rewrite the original shipped quantity, so they are intentionally
        // excluded from this document-to-ledger quantity identity.
        if (!invalidCost && !outboundQuantityTotal.equals(shippedQuantity.plus(shipCancelQuantity))) {
          warnings.add('发货数量与冻结出库台账无法勾稽，相关利润未计算')
          invalidCost = true
        }
        if (costAmount?.isNegative() || settlementQuantity.isNegative()) {
          warnings.add('冲回量超过原出库量，相关利润未计算')
          invalidCost = true
        }
        if (invalidCost) {
          costAmount = null
        }
      } else if (shippedQuantity.gt(0)) {
        warnings.add('部分商品缺少冻结出库成本，成本及利润显示“—”')
      } else {
        costAmount = ZERO
        settlementQuantity = ZERO
        settlementAmount = ZERO
      }

      if (!sourceLineId && shippedQuantity.gt(0)) {
        warnings.add('配送商品缺少原订货行关联，无法勾稽出库成本')
      }
      const profit = costAmount == null ? null : settlementAmount.minus(costAmount)
      const costUnitPrice = costAmount == null || settlementQuantity.lte(0)
        ? null
        : costAmount.div(settlementQuantity)
      return {
        itemId: item.id,
        acceptedQuantity: quantity(acceptedQuantity),
        shippedQuantity: quantity(shippedQuantity),
        unitPrice: money(unitPrice),
        shippedAmount: money(shippedAmount),
        settlementQuantity: quantity(settlementQuantity),
        settlementAmount: money(settlementAmount),
        costUnitPrice: costUnitPrice == null ? null : money(costUnitPrice),
        costAmount: costAmount == null ? null : money(costAmount),
        profit: profit == null ? null : money(profit),
      }
    })

    const shippedAmount = lines.reduce((sum, line) => sum.plus(line.shippedAmount), ZERO)
    const settlementAmount = lines.reduce((sum, line) => sum.plus(line.settlementAmount), ZERO)
    const completeCost = lines.length > 0 && lines.every(line => line.costAmount != null)
    const costAmount = completeCost
      ? lines.reduce((sum, line) => sum.plus(line.costAmount!), ZERO)
      : null
    const profit = costAmount == null ? null : settlementAmount.minus(costAmount)
    result.set(delivery.id, {
      shippedAmount: money(shippedAmount),
      settlementAmount: money(settlementAmount),
      costAmount: costAmount == null ? null : money(costAmount),
      profit: profit == null ? null : money(profit),
      completeCost,
      warnings: [...warnings],
      lines,
    })
  }
  return result
}

type DeliveryProfitPrisma = Pick<typeof prisma, 'warehouseLedgerMovement'>

export async function loadDeliveryProfitProjections(
  client: DeliveryProfitPrisma,
  tenantId: string,
  deliveries: DeliveryProfitInput[],
) {
  const deliveryIds = [...new Set(deliveries.map(delivery => delivery.id).filter(Boolean))]
  if (deliveryIds.length === 0) return new Map<string, DeliveryProfitProjection>()
  const outbounds = await client.warehouseLedgerMovement.findMany({
    where: {
      tenantId,
      type: 'ORDER_OUTBOUND',
      sourceType: 'DeliveryOrder',
      sourceId: { in: deliveryIds },
    },
    select: {
      id: true,
      sourceId: true,
      sourceLineId: true,
      productId: true,
      originalQuantity: true,
      valueDelta: true,
    },
  })
  const reversals = outbounds.length === 0 ? [] : await client.warehouseLedgerMovement.findMany({
    where: {
      tenantId,
      type: 'REVERSAL',
      sourceType: { in: [...PROFIT_REVERSAL_SOURCES] },
      sourceLineId: { in: outbounds.map(row => row.id) },
    },
    select: {
      id: true,
      productId: true,
      sourceLineId: true,
      originalQuantity: true,
      valueDelta: true,
      sourceType: true,
    },
  })
  return projectDeliveryProfits(deliveries, outbounds, reversals)
}
