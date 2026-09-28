import { Prisma } from '@dianjie/db'
import { businessMonthKey } from '../lib/businessTime'
import { buildOrderSnapshot, businessNoFloor, nextBusinessNo, snapshotHash } from './purchaseOrderIntegrity'
import { enforceWarehouseOrderEntryPolicyInTransaction } from './orderDraftValidation'
import { reserveSupplierStockForOrder } from './supplierStockReservation'
import { reserveWarehouseLedgerForOrder } from './warehouseLedger'

type AcceptanceInput = {
  tenantId: string
  replenishmentOrderId: string
  actorId: string
  actorRole: string
  requestId: string
  requestKey: string
  ip?: string | null
}

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 })
}

/**
 * Convert one submitted replenishment request into the single formal purchase
 * order that owns all later delivery, receipt and settlement facts.
 *
 * The status CAS, formal order, immutable snapshots/events and unique bridge
 * are intentionally created in the caller's Serializable transaction.
 */
export async function acceptReplenishmentInTransaction(
  tx: Prisma.TransactionClient,
  input: AcceptanceInput,
) {
  const replay = await tx.replenishmentOrderEvent.findFirst({
    where: { tenantId: input.tenantId, requestKey: input.requestKey },
    select: { replenishmentOrderId: true },
  })
  if (replay) {
    if (replay.replenishmentOrderId !== input.replenishmentOrderId) {
      throw conflict('同一幂等键不能用于不同的补货单接单请求')
    }
    const existing = await tx.replenishmentFulfillmentLink.findUnique({
      where: { replenishmentOrderId: input.replenishmentOrderId },
      include: { purchaseOrder: true },
    })
    if (!existing) throw conflict('接单事件已存在但正式订单链接缺失，请处理异常')
    return { replayed: true, link: existing, purchaseOrder: existing.purchaseOrder }
  }

  const replenishment = await tx.replenishmentOrder.findFirst({
    where: { id: input.replenishmentOrderId, tenantId: input.tenantId },
    include: {
      store: true,
      supplier: true,
      createdBy: { select: { id: true, name: true, role: true } },
      items: { include: { product: true }, orderBy: { createdAt: 'asc' } },
      fulfillment: true,
    },
  })
  if (!replenishment) throw Object.assign(new Error('补货单不存在'), { statusCode: 404 })
  if (replenishment.fulfillment) {
    throw conflict('补货单已存在正式履约链接，请刷新后重试')
  }
  if (replenishment.status !== 'SUBMITTED') {
    throw conflict('只有已提交的补货单可以接单')
  }
  if (replenishment.items.length === 0) throw conflict('补货单没有商品明细')

  await enforceWarehouseOrderEntryPolicyInTransaction(tx, {
    tenantId: input.tenantId,
    supplierId: replenishment.supplierId,
    items: replenishment.items.map(item => ({ productId: item.productId, productName: item.productNameSnapshot })),
  })

  const accepted = await tx.replenishmentOrder.updateMany({
    where: {
      id: replenishment.id,
      tenantId: input.tenantId,
      status: 'SUBMITTED',
      rowVersion: replenishment.rowVersion,
    },
    data: {
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      acceptedById: input.actorId,
      rowVersion: { increment: 1 },
    },
  })
  if (accepted.count !== 1) throw conflict('补货单状态已变化，请刷新后重试')

  const ym = businessMonthKey()
  const latest = await tx.purchaseOrder.findFirst({
    where: { tenantId: input.tenantId, no: { startsWith: `PO${ym}` } },
    orderBy: { no: 'desc' },
    select: { no: true },
  })
  const purchaseOrderNo = await nextBusinessNo(
    tx,
    input.tenantId,
    'PO',
    ym,
    'PO',
    businessNoFloor(latest?.no, 'PO', ym),
  )
  const submittedAt = replenishment.submittedAt || new Date()
  const purchaseOrder = await tx.purchaseOrder.create({
    data: {
      tenantId: input.tenantId,
      no: purchaseOrderNo,
      storeId: replenishment.storeId,
      supplierId: replenishment.supplierId,
      expectedDate: replenishment.expectedDate,
      totalAmount: replenishment.totalAmount,
      originalTotalAmount: replenishment.totalAmount,
      currentOrderAmount: replenishment.totalAmount,
      status: 'CONFIRMED',
      note: replenishment.note,
      submittedAt,
      createdById: replenishment.createdById,
      items: {
        create: replenishment.items.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
          originalQuantity: item.quantity,
          unitPrice: item.unitPrice,
          originalUnitPrice: item.unitPrice,
          amount: item.amount,
          originalAmount: item.amount,
          purchaseUnitSnapshot: item.purchaseUnitSnapshot,
          inventoryUnitSnapshot: item.inventoryUnitSnapshot,
          orderUnitSnapshot: item.orderUnitSnapshot,
          costUnitSnapshot: item.costUnitSnapshot,
          unitConversionStatusSnapshot: item.unitConversionStatusSnapshot,
          inventoryUnitsPerPurchaseUnitSnapshot: item.inventoryUnitsPerPurchaseUnitSnapshot,
          inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot,
          inventoryUnitsPerCostUnitSnapshot: item.inventoryUnitsPerCostUnitSnapshot,
          lineOrigin: 'ORIGINAL',
        })),
      },
    },
    include: {
      store: true,
      supplier: true,
      createdBy: { select: { id: true, name: true, role: true } },
      items: { include: { product: true } },
    },
  })
  const snapshot = buildOrderSnapshot(purchaseOrder as any, 'original')
  const submittedSnapshotHash = snapshotHash(snapshot)
  await tx.purchaseOrder.update({
    where: { id: purchaseOrder.id },
    data: { submittedSnapshot: snapshot as any, submittedSnapshotHash },
  })
  await tx.purchaseOrderEvent.createMany({
    data: [
      {
        tenantId: input.tenantId,
        purchaseOrderId: purchaseOrder.id,
        eventType: 'CREATED',
        actorId: input.actorId,
        actorRole: input.actorRole,
        toStatus: 'SUBMITTED',
        requestId: input.requestId,
        ip: input.ip || null,
        metadata: {
          creationSource: '供应链代门店补货',
          creationType: '独立补货',
          replenishmentOrderId: replenishment.id,
          replenishmentOrderNo: replenishment.no,
        },
      },
      {
        tenantId: input.tenantId,
        purchaseOrderId: purchaseOrder.id,
        eventType: 'SUBMITTED',
        actorId: input.actorId,
        actorRole: input.actorRole,
        toStatus: 'SUBMITTED',
        requestId: input.requestId,
        ip: input.ip || null,
        metadata: { snapshotHash: submittedSnapshotHash, replenishmentOrderId: replenishment.id },
      },
      {
        tenantId: input.tenantId,
        purchaseOrderId: purchaseOrder.id,
        eventType: 'ACCEPTED',
        actorId: input.actorId,
        actorRole: input.actorRole,
        fromStatus: 'SUBMITTED',
        toStatus: 'CONFIRMED',
        requestId: input.requestId,
        ip: input.ip || null,
        metadata: { replenishmentOrderId: replenishment.id },
      },
    ],
  })

  const link = await tx.replenishmentFulfillmentLink.create({
    data: {
      tenantId: input.tenantId,
      replenishmentOrderId: replenishment.id,
      purchaseOrderId: purchaseOrder.id,
    },
  })
  await tx.replenishmentOrderEvent.create({
    data: {
      tenantId: input.tenantId,
      replenishmentOrderId: replenishment.id,
      eventType: 'ACCEPTED',
      actorId: input.actorId,
      actorRole: input.actorRole,
      fromStatus: 'SUBMITTED',
      toStatus: 'ACCEPTED',
      requestId: input.requestId,
      requestKey: input.requestKey,
      ip: input.ip || null,
      metadata: { purchaseOrderId: purchaseOrder.id, purchaseOrderNo },
    },
  })

  const reservationLines = purchaseOrder.items.map(item => ({
    purchaseOrderItemId: item.id,
    productId: item.productId,
    quantity: item.quantity,
    productName: item.product.name,
    productUnit: item.product.unit,
    orderUnitSnapshot: item.orderUnitSnapshot,
    inventoryUnitSnapshot: item.inventoryUnitSnapshot,
    inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot,
  }))
  if (replenishment.supplier.sourceType === 'HEADQ_WAREHOUSE') {
    const warehouse = await tx.warehouse.findFirst({
      where: { tenantId: input.tenantId, isDefault: true, isActive: true },
      select: { inventoryMode: true },
    })
    if (warehouse && warehouse.inventoryMode !== 'OFF') {
      await reserveWarehouseLedgerForOrder(tx, {
        tenantId: input.tenantId,
        purchaseOrderId: purchaseOrder.id,
        userId: input.actorId,
        lines: reservationLines,
      })
    }
  } else if (replenishment.supplier.inventoryMode === 'STRICT') {
    await reserveSupplierStockForOrder(tx, {
      tenantId: input.tenantId,
      supplierId: replenishment.supplierId,
      purchaseOrderId: purchaseOrder.id,
      lines: reservationLines,
    })
  }

  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.actorId,
      action: `接单并生成正式订货单 ${purchaseOrderNo}`,
      target: replenishment.no,
      entityType: 'ReplenishmentOrder',
      targetId: replenishment.id,
      metadata: { purchaseOrderId: purchaseOrder.id, purchaseOrderNo },
    },
  })
  return {
    replayed: false,
    link,
    purchaseOrder: { ...purchaseOrder, submittedSnapshot: snapshot, submittedSnapshotHash },
  }
}
