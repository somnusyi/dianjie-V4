import { Prisma, prisma } from '@dianjie/db'
import { convertQuantityToInventoryUnit, purchasePriceToInventoryUnitCost } from './inventoryUnits'
import { productInventoryUnitCost } from './unitContractGuard'
import { businessDateOnlyRange } from '../lib/businessTime'

type CostSlot = { quantity: number; averageCost: number }

// StockConsumption.date is a DATE: its theoretical BOM usage closes that day.
export const closingConsumptionTime = (date: Date) => businessDateOnlyRange(date).endExclusive.getTime() - 1

export function applyReceiptToCostSlot(current: CostSlot, quantity: number, unitCost: number): CostSlot {
  if (!(quantity > 0)) return current
  const nextQuantity = current.quantity + quantity
  // A physical count can be followed by estimated consumption that temporarily
  // drives stock below zero.  The next real receipt establishes a new known
  // cost; carrying a negative layer into the denominator would inflate cost.
  if (current.quantity <= 0) return { quantity: nextQuantity, averageCost: unitCost }
  return {
    quantity: nextQuantity,
    averageCost: nextQuantity > 0
      ? (current.quantity * current.averageCost + quantity * unitCost) / nextQuantity
      : unitCost,
  }
}

/**
 * Rebuild consumption cost snapshots from the latest physical count.
 *
 * Same-day receipts are applied before end-of-day BOM consumption.  This is
 * deterministic and matches the inventory estimator.  The physical count is
 * the accounting boundary; older uncertain movements are deliberately not
 * replayed through the current period.
 */
export async function revalueStoreConsumptionCosts(tenantId: string, storeId: string) {
  const snapshot = await prisma.inventorySnapshot.findFirst({
    where: { tenantId, storeId },
    orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
    include: { items: { include: { product: true } } },
  })
  if (!snapshot) return { status: 'NO_BASELINE' as const, updated: 0, totalCost: 0 }
  // Prisma DATE values encode a calendar date at UTC midnight. Advancing via
  // the host's local timezone can replay movements already included in the
  // count. Match the date-only boundary used by the inventory/transfer readers.
  const openingDate = new Date(snapshot.snapshotDate)
  openingDate.setUTCDate(openingDate.getUTCDate() + 1)
  openingDate.setUTCHours(0, 0, 0, 0)
  const openingTimestamp = businessDateOnlyRange(openingDate).start
  const slots = new Map<string, CostSlot>()
  for (const item of snapshot.items) {
    if (!item.productId || !item.product) continue
    let quantity = item.normalizedQuantity == null ? null : Number(item.normalizedQuantity)
    if (quantity == null) {
      const normalized = convertQuantityToInventoryUnit({
        quantity: Number(item.quantity),
        sourceUnit: item.unit,
        product: item.product,
        productSpec: item.rawSpec,
      })
      quantity = normalized.normalizedQuantity
    }
    if (quantity == null || quantity <= 0) continue
    const value = Number(item.amount)
    const current = slots.get(item.productId) || { quantity: 0, averageCost: 0 }
    const totalQuantity = current.quantity + quantity
    current.averageCost = totalQuantity > 0
      ? (current.quantity * current.averageCost + value) / totalQuantity
      : 0
    current.quantity = totalQuantity
    slots.set(item.productId, current)
  }

  const [receipts, consumptions, manualLosses, transferMovements] = await Promise.all([
    prisma.receiptItem.findMany({
      where: {
        receipt: {
          tenantId, storeId, status: { in: ['CONFIRMED', 'ACCOUNTED'] },
          deliveryDate: { gte: openingDate },
        },
      },
      include: { product: true, receipt: { select: { deliveryDate: true } } },
    }),
    prisma.stockConsumption.findMany({
      where: { tenantId, storeId, date: { gte: openingDate }, voidedAt: null },
      include: { product: true },
    }),
    prisma.lossClaimItem.findMany({
      where: {
        lossClaim: {
          tenantId, storeId, isManual: true,
          status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] },
          createdAt: { gte: openingTimestamp },
        },
      },
      include: { product: true, lossClaim: { select: { createdAt: true } } },
    }),
    (prisma as any).storeTransferMovement.findMany({ where: { tenantId, storeId, effectiveAt: { gte: openingTimestamp }, quantityDelta: { not: 0 } }, include: { product: true } }),
  ])
  const events = [
    ...transferMovements.map((item: any) => ({ kind: 'TRANSFER' as const, at: item.effectiveAt, item })),
    ...receipts.map(item => ({ kind: 'IN' as const, at: item.receipt.deliveryDate, item })),
    ...consumptions.map(item => ({ kind: 'OUT' as const, at: item.date, item })),
    ...manualLosses.map(item => ({ kind: 'LOSS' as const, at: item.lossClaim.createdAt, item })),
  ].sort((left, right) => {
    const leftTime = left.kind === 'OUT' ? closingConsumptionTime(left.at) : left.at.getTime()
    const rightTime = right.kind === 'OUT' ? closingConsumptionTime(right.at) : right.at.getTime()
    const byTime = leftTime - rightTime
    if (byTime !== 0) return byTime
    if (left.kind === right.kind) return 0
    return left.kind === 'IN' ? -1 : 1
  })

  const updates: Array<{ id: string; unitCost: number; amount: number }> = []
  for (const event of events) {
    const product = event.item.product
    const current = slots.get(product.id) || { quantity: 0, averageCost: 0 }
    if (event.kind === 'TRANSFER') {
      const q = Number(event.item.quantityDelta), v = Number(event.item.valueDelta)
      const nextQuantity = current.quantity + q
      const nextValue = current.quantity * current.averageCost + v
      current.quantity = nextQuantity
      current.averageCost = nextQuantity > 0 ? nextValue / nextQuantity : 0
    } else if (event.kind === 'IN') {
      const quantity = Number(event.item.inventoryQuantity ?? 0)
      const unitCost = Number(event.item.inventoryUnitCostSnapshot
        ?? purchasePriceToInventoryUnitCost({ purchaseUnitPrice: Number(event.item.unitPrice), product })
        ?? 0)
      const next = applyReceiptToCostSlot(current, quantity, unitCost)
      current.quantity = next.quantity
      current.averageCost = next.averageCost
    } else if (event.kind === 'OUT') {
      let quantity = event.item.inventoryQuantity == null ? null : Number(event.item.inventoryQuantity)
      if (quantity == null) {
        const normalized = convertQuantityToInventoryUnit({
          quantity: Number(event.item.quantity),
          sourceUnit: event.item.unitSnapshot || product.unit,
          product,
          productSpec: product.spec,
        })
        quantity = normalized.normalizedQuantity
      }
      if (quantity == null) continue
      // product.price 是每成本单位价，不能当成每采购单位价来折算。
      const fallbackCost = productInventoryUnitCost(product) || 0
      const unitCost = current.averageCost || fallbackCost
      updates.push({ id: event.item.id, unitCost, amount: quantity * unitCost })
      current.quantity -= quantity
    } else {
      let quantity = event.item.inventoryQuantity == null ? null : Number(event.item.inventoryQuantity)
      if (quantity == null) {
        const normalized = convertQuantityToInventoryUnit({
          quantity: Number(event.item.lossQty),
          sourceUnit: event.item.productUnitSnapshot || product.unit,
          product,
          productSpec: product.spec,
        })
        quantity = normalized.normalizedQuantity
      }
      if (quantity != null) current.quantity -= quantity
    }
    slots.set(product.id, current)
  }
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map(update => prisma.stockConsumption.update({
        where: { id: update.id },
        data: {
          unitCostSnapshot: new Prisma.Decimal(update.unitCost).toDecimalPlaces(6),
          costAmountSnapshot: new Prisma.Decimal(update.amount).toDecimalPlaces(4),
        },
      })),
    )
  }
  return {
    status: 'OK' as const,
    updated: updates.length,
    totalCost: updates.reduce((sum, update) => sum + update.amount, 0),
  }
}
