import { Prisma } from '@dianjie/db'
import { purchasePriceToInventoryUnitCost, resolveProductInventoryUnit } from './inventoryUnits'

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
    const contract = resolveProductInventoryUnit(item.product)
    if (!contract.structured || contract.status === 'PENDING') {
      throw Object.assign(
        new Error(`原材料“${item.product.name}”尚未核验采购单位与库存单位换算，不能确认入库`),
        { statusCode: 409 },
      )
    }
    const fallbackUnitCost = purchasePriceToInventoryUnitCost({
      purchaseUnitPrice: Number(item.unitPrice),
      product: item.product,
    })
    const inventoryQuantity = new Prisma.Decimal(item.quantity).mul(contract.inventoryUnitsPerPurchaseUnit)
    const lineAmount = Number(item.amount)
    const unitCost = inventoryQuantity.gt(0) && Number.isFinite(lineAmount) && lineAmount >= 0
      ? lineAmount / Number(inventoryQuantity)
      : fallbackUnitCost
    if (unitCost == null) {
      throw Object.assign(new Error(`原材料“${item.product.name}”库存单位成本无法计算`), { statusCode: 409 })
    }
    await tx.receiptItem.update({
      where: { id: item.id },
      data: {
        inventoryQuantity,
        inventoryUnitSnapshot: contract.inventoryUnit,
        inventoryUnitsPerPurchaseUnitSnapshot: contract.inventoryUnitsPerPurchaseUnit,
        inventoryUnitCostSnapshot: unitCost,
      },
    })
  }
  return items.length
}
