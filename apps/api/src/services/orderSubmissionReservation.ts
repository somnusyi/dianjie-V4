import { Prisma, prisma } from '@dianjie/db'
import { getWarehouseLedgerMode, syncSubmissionWarehouseReservation } from './warehouseLedger'
import { syncSubmissionSupplierReservation } from './supplierStockReservation'

export const SUBMISSION_STOCK_POLICY = 'SUBMISSION_V1'
export function hasSubmissionStockPolicy(snapshot: unknown) {
  return Boolean(snapshot && typeof snapshot === 'object' && (snapshot as Record<string, unknown>).stockReservationPolicy === SUBMISSION_STOCK_POLICY)
}
export function withSubmissionStockPolicy<T extends object>(snapshot: T) {
  return { ...snapshot, stockReservationPolicy: SUBMISSION_STOCK_POLICY }
}
export async function syncSubmissionOrderReservation(tx: Prisma.TransactionClient, input: { tenantId: string; purchaseOrderId: string; userId: string }) {
  const order = await tx.purchaseOrder.findFirst({ where: { tenantId: input.tenantId, id: input.purchaseOrderId },
    include: { supplier: { select: { sourceType: true, inventoryMode: true } }, items: { where: { isActive: true }, include: { product: { select: { name: true, unit: true } } } } } })
  if (!order || !hasSubmissionStockPolicy(order.submittedSnapshot) || !['SUBMITTED', 'CONFIRMED'].includes(order.status)) return
  const lines = order.items.map(item => ({ purchaseOrderItemId: item.id, productId: item.productId, quantity: item.quantity,
    productName: item.product.name, productUnit: item.product.unit, orderUnitSnapshot: item.orderUnitSnapshot,
    inventoryUnitSnapshot: item.inventoryUnitSnapshot, inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot, purchaseUnitSnapshot: item.purchaseUnitSnapshot, costUnitSnapshot: item.costUnitSnapshot, inventoryUnitsPerPurchaseUnitSnapshot: item.inventoryUnitsPerPurchaseUnitSnapshot, inventoryUnitsPerCostUnitSnapshot: item.inventoryUnitsPerCostUnitSnapshot }))
  if (order.supplier.sourceType === 'HEADQ_WAREHOUSE') await syncSubmissionWarehouseReservation(tx, { ...input, revision: order.rowVersion, lines })
  else await syncSubmissionSupplierReservation(tx, { tenantId: input.tenantId, supplierId: order.supplierId, purchaseOrderId: order.id, lines })
}
export async function submissionOrderWarehouseMode(tenantId: string, purchaseOrderId: string) {
  const order = await prisma.purchaseOrder.findFirst({ where: { tenantId, id: purchaseOrderId }, select: { submittedSnapshot: true } })
  const reservations = await prisma.warehouseLedgerReservation.findMany({ where: { tenantId, purchaseOrderId }, select: { warehouseId: true } })
  const warehouses = [...new Set(reservations.map(row => row.warehouseId))]
  if (warehouses.length > 1) throw Object.assign(new Error('本单预占存在多个仓库，请先核对库存流水'), { statusCode: 409 })
  const configured = await getWarehouseLedgerMode(tenantId, warehouses[0])
  return hasSubmissionStockPolicy(order?.submittedSnapshot) ? { ...configured, inventoryMode: 'STRICT' as const } : configured
}
