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
  for (const item of items) {
    const basis = resolveReceiptInventoryBasis(item)
    if (!basis) {
      throw Object.assign(
        new Error(`原材料“${item.product.name}”尚未核验采购单位与库存单位换算，不能确认入库`),
        { statusCode: 409 },
      )
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
      throw Object.assign(new Error(`原材料“${item.product.name}”库存单位成本无法计算`), { statusCode: 409 })
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
  }
  return items.length
}
