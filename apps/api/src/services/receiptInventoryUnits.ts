import { Prisma } from '@dianjie/db'
import { purchasePriceToInventoryUnitCost, resolveProductInventoryUnit } from './inventoryUnits'
import {
  hasCompleteFrozenSupplyDocumentFourUnits,
  type FrozenSupplyDocumentFourUnits,
} from './supplyDocumentUnitSnapshots'

type ReceiptUnitSnapshotInput = FrozenSupplyDocumentFourUnits & {
  quantity: Prisma.Decimal | number | string
  unitPrice: Prisma.Decimal | number | string
  amount: Prisma.Decimal | number | string
  product: {
    name: string
    unit: string
    inventoryUnit: string | null
    inventoryUnitsPerPurchaseUnit: Prisma.Decimal | number | string | null
    unitConversionStatus: string | null
  }
}

export function resolveReceiptInventoryBasis(item: ReceiptUnitSnapshotInput) {
  if (hasCompleteFrozenSupplyDocumentFourUnits(item)) {
    if (!['INFERRED', 'VERIFIED'].includes(String(item.unitConversionStatusSnapshot || 'PENDING'))) {
      return null
    }
    return {
      source: 'DOCUMENT_SNAPSHOT' as const,
      inventoryUnit: item.inventoryUnitSnapshot!,
      // Purchase-order, delivery and linked-receipt quantities remain in the
      // order unit. Monetary unit-price semantics intentionally stay unchanged.
      quantityFactor: Number(item.inventoryUnitsPerOrderUnitSnapshot),
      purchaseFactor: Number(item.inventoryUnitsPerPurchaseUnitSnapshot),
    }
  }

  // Historical/manual rows without the new complete snapshot retain the exact
  // pre-migration safety path: verified Product purchase-to-inventory mapping.
  const contract = resolveProductInventoryUnit(item.product)
  if (!contract.structured || contract.status === 'PENDING') return null
  return {
    source: 'LEGACY_PRODUCT_FALLBACK' as const,
    inventoryUnit: contract.inventoryUnit,
    quantityFactor: contract.inventoryUnitsPerPurchaseUnit,
    purchaseFactor: contract.inventoryUnitsPerPurchaseUnit,
  }
}

/**
 * Freeze the quantity and cost conversion used by one receipt.
 *
 * Receipts are entered in the purchasing unit.  Store inventory and moving
 * average cost are kept in the inventory base unit.  Freezing the conversion
 * on the document prevents later master-data edits from rewriting history.
 */
export async function ensureReceiptInventoryUnitSnapshots(tx: any, receiptId: string) {
  const items = await tx.receiptItem.findMany({
    where: { receiptId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          unit: true,
          inventoryUnit: true,
          inventoryUnitsPerPurchaseUnit: true,
          unitConversionStatus: true,
        },
      },
    },
  })
  let normalizedCount = 0
  let pendingCount = 0
  for (const item of items) {
    const basis = resolveReceiptInventoryBasis(item)
    if (!basis) {
      // 收货确认是门店现场的事实，不能因为后台主数据尚未核验而整单回滚。
      // 此行暂不参与库存数量和移动平均成本，待单位核验后由补偿任务回填。
      pendingCount += 1
      continue
    }
    const legacyFallbackUnitCost = purchasePriceToInventoryUnitCost({
      purchaseUnitPrice: Number(item.unitPrice),
      product: item.product,
    })
    const inventoryQuantity = new Prisma.Decimal(item.quantity).mul(basis.quantityFactor)
    const lineAmount = Number(item.amount)
    const unitCost = inventoryQuantity.gt(0) && Number.isFinite(lineAmount) && lineAmount >= 0
      ? lineAmount / Number(inventoryQuantity)
      : legacyFallbackUnitCost
    if (unitCost == null) {
      pendingCount += 1
      continue
    }
    await tx.receiptItem.update({
      where: { id: item.id },
      data: {
        inventoryQuantity,
        inventoryUnitSnapshot: basis.inventoryUnit,
        inventoryUnitsPerPurchaseUnitSnapshot: basis.purchaseFactor,
        inventoryUnitCostSnapshot: unitCost,
      },
    })
    normalizedCount += 1
  }
  return { totalCount: items.length, normalizedCount, pendingCount }
}
