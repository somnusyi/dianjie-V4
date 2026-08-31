import { Prisma } from '@dianjie/db'
import { reverseDeliveryOutboundInTransaction } from './warehouseLedger'

const ZERO = new Prisma.Decimal(0)
const SUPPLIER_STOCK_REMOVAL_SOURCE = 'DeliveryOrderItemRemoval'

type RemovalInput = {
  tenantId: string
  supplierId: string
  deliveryOrderId: string
  itemId: string
  userId: string
  userRole: string
  rowVersion: number
  reason?: string | null
  requestId?: string | null
  ip?: string | null
}

function businessError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function sumDecimal(values: Array<unknown>): any {
  let sum: any = new Prisma.Decimal(0)
  for (const value of values) sum = sum.plus(new Prisma.Decimal(value as any))
  return sum
}

function equalDecimal(a: any, b: any) {
  return a.minus(b).abs().lte(new Prisma.Decimal('0.0001'))
}

/**
 * 冲回供应商严格库存模式下的一次配送出库。
 *
 * 这里不删除任何库存流水或批次分配：以追加 ADJUSTMENT 流水、恢复原批次
 * 余额的方式留痕。调用方必须已经锁住配送单/订单，本函数再锁住商品行，
 * 保证与接单、发货、库存调整并发时不会产生负库存或重复冲回。
 */
async function reverseSupplierOutbound(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    supplierId: string
    deliveryOrderId: string
    deliveryOrderItemId: string
    productId: string
    quantity: Prisma.Decimal
    userId: string
    orderNo: string
    reason: string
  },
) {
  const sourceId = `${input.deliveryOrderId}:${input.deliveryOrderItemId}`.slice(0, 80)

  // Product 是供应商库存的物理余额 owner；先锁它，避免两个库存事务交叉更新。
  const lockedProducts = await tx.$queryRaw<Array<{ id: string; stock: Prisma.Decimal }>>(Prisma.sql`
    SELECT "id", "stock"
    FROM "products"
    WHERE "id" = ${input.productId}
      AND "tenantId" = ${input.tenantId}
      AND "supplierId" = ${input.supplierId}
    FOR UPDATE
  `)
  if (lockedProducts.length !== 1) throw businessError('商品不属于当前供应商，无法移除', 403)

  const replay = await tx.supplierStockMovement.findFirst({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      sourceType: SUPPLIER_STOCK_REMOVAL_SOURCE,
      sourceId,
    },
    select: { id: true },
  })
  if (replay) return { reversed: false, replayed: true, movementId: replay.id }

  const original = await tx.supplierStockMovement.findFirst({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      sourceType: 'DeliveryOrder',
      sourceId: input.deliveryOrderId,
      type: 'OUTBOUND_PO',
      delta: { lt: 0 },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (!original) {
    throw businessError('该配送单缺少供应商出库流水，无法安全移除；请先完成库存对账', 409)
  }

  const quantity = new Prisma.Decimal(input.quantity as any).toDecimalPlaces(3)
  const originalQuantity = new Prisma.Decimal(original.delta as any).abs().toDecimalPlaces(3)
  if (!equalDecimal(quantity, originalQuantity)) {
    throw businessError('配送商品数量与库存出库流水不一致，无法安全移除', 409)
  }

  // 发货扣减必然有批次分配。缺失时拒绝，而不是制造“物理库存有、批次没有”的新缺口。
  const allocations = await tx.supplierStockBatchAllocation.findMany({
    where: { tenantId: input.tenantId, supplierId: input.supplierId, productId: input.productId, movementId: original.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (allocations.length === 0) {
    throw businessError('该配送单缺少供应商批次分配，无法安全移除；请先完成库存对账', 409)
  }
  const allocationTotal = sumDecimal(allocations.map(item => item.quantity)).toDecimalPlaces(3)
  if (!equalDecimal(allocationTotal, quantity)) {
    throw businessError('供应商批次分配与出库数量不一致，无法安全移除', 409)
  }

  const now = new Date()
  for (const allocation of allocations) {
    // update 会取得批次行锁；恢复不得超过该批次的初始余额。
    const batch = await tx.supplierStockBatch.findUnique({ where: { id: allocation.batchId } })
    if (!batch) throw businessError('供应商库存批次不存在，无法安全移除', 409)
    const nextRemaining = new Prisma.Decimal(batch.remainingQty as any).plus(new Prisma.Decimal(allocation.quantity as any))
    if (nextRemaining.gt(new Prisma.Decimal(batch.initialQty as any).plus(new Prisma.Decimal('0.0001')))) {
      throw businessError('供应商库存批次余额异常，无法安全移除', 409)
    }
    await tx.supplierStockBatch.update({
      where: { id: batch.id },
      data: { remainingQty: nextRemaining, depletedAt: null },
    })
  }

  const updatedProduct = await tx.product.update({
    where: { id: input.productId },
    data: { stock: { increment: quantity } },
    select: { stock: true },
  })
  const movement = await tx.supplierStockMovement.create({
    data: {
      tenantId: input.tenantId,
      warehouseId: original.warehouseId,
      supplierId: input.supplierId,
      productId: input.productId,
      delta: quantity,
      balanceAfter: updatedProduct.stock,
      type: 'ADJUSTMENT',
      reason: input.reason.slice(0, 200),
      sourceType: SUPPLIER_STOCK_REMOVAL_SOURCE,
      sourceId,
      createdById: input.userId,
      createdAt: now,
    },
  })

  return { reversed: true, replayed: false, movementId: movement.id }
}

async function resolveWarehouseMode(
  tx: Prisma.TransactionClient,
  tenantId: string,
  warehouseId: string | null,
) {
  const warehouse = await tx.warehouse.findFirst({
    where: { tenantId, isActive: true, ...(warehouseId ? { id: warehouseId } : {}) },
    select: { inventoryMode: true },
  })
  return warehouse?.inventoryMode || 'OFF'
}

/**
 * 在收货前移除配送单的一行。配送明细采用“软移除”（实发量/金额置零），
 * 原订单、原始快照和历史流水均保留；读取接口过滤零实发行，所以用户看到的
 * 效果仍是商品被移除。所有库存、预占、订单金额和审计事件在同一事务完成。
 */
export async function removeDeliveryItemInTransaction(
  tx: Prisma.TransactionClient,
  input: RemovalInput,
) {
  // 与收货/送达并发时先串行化同一配送单；数据库行锁是第二道门禁。
  // pg_advisory_xact_lock returns void; cast it before Prisma deserializes the
  // result so the lock is acquired without producing a runtime 500.
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`delivery-item-remove:${input.tenantId}:${input.deliveryOrderId}`}))::text AS locked
  `)

  const deliveryLock = await tx.$queryRaw<Array<{ id: string; purchaseOrderId: string }>>(Prisma.sql`
    SELECT "id", "purchaseOrderId"
    FROM "delivery_orders"
    WHERE "id" = ${input.deliveryOrderId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `)
  if (deliveryLock.length !== 1) throw businessError('配送单不存在', 404)

  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "purchase_orders"
    WHERE "id" = ${deliveryLock[0].purchaseOrderId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `)

  const delivery = await tx.deliveryOrder.findUnique({
    where: { id: input.deliveryOrderId },
    include: {
      purchaseOrder: {
        include: {
          supplier: { select: { id: true, sourceType: true, inventoryMode: true, name: true } },
          items: { where: { isActive: true }, select: { id: true, productId: true, quantity: true, shippedQty: true, amount: true } },
        },
      },
      items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      receipt: { select: { id: true } },
    },
  })
  if (
    !delivery
    || delivery.supplierId !== input.supplierId
    || delivery.purchaseOrder.supplierId !== input.supplierId
  ) {
    // A legacy/corrupt delivery must never let one supplier mutate another
    // supplier's purchase-order facts, even when the delivery row itself is
    // bound to the authenticated supplier.
    throw businessError('配送单不存在', 404)
  }

  if (!['SHIPPED', 'DELIVERED'].includes(delivery.status)) {
    throw businessError('仅收货前的配送单可以移除商品', 409)
  }
  if (delivery.receipt) throw businessError('配送单已生成收货单，不能移除商品', 409)
  if (delivery.rowVersion !== input.rowVersion) {
    throw businessError('配送单已更新，请刷新后重试', 409)
  }

  const item = delivery.items.find(candidate => candidate.id === input.itemId)
  if (!item) throw businessError('配送商品不存在', 404)
  const removedQty = new Prisma.Decimal(item.shippedQty as any)
  if (removedQty.lte(0)) {
    return {
      success: true,
      alreadyRemoved: true,
      removedItemId: item.id,
      deliveryId: delivery.id,
      deliveryTotal: new Prisma.Decimal(delivery.actualTotalAmount as any).toFixed(2),
      orderTotal: new Prisma.Decimal(delivery.purchaseOrder.totalAmount as any).toFixed(2),
      rowVersion: delivery.rowVersion,
    }
  }
  if (item.receivedQty != null && new Prisma.Decimal(item.receivedQty as any).gt(0)) {
    throw businessError('该商品已有实收数量，不能移除', 409)
  }

  const remainingCount = await tx.deliveryOrderItem.count({
    where: { deliveryOrderId: delivery.id, id: { not: item.id }, shippedQty: { gt: 0 } },
  })
  if (remainingCount === 0) throw businessError('配送单至少要保留一件商品；如整单不发请走拒单流程', 409)

  const poItemId = item.purchaseOrderItemId
  if (!poItemId) throw businessError('历史配送明细未关联原订货行，不能安全移除', 409)
  const poItem = delivery.purchaseOrder.items.find(candidate => candidate.id === poItemId)
  if (!poItem) throw businessError('原订货行不存在或已停用，不能安全移除', 409)

  const reason = String(input.reason || '供应商在门店收货前移除商品').trim().slice(0, 200)
  const sourceType = delivery.purchaseOrder.supplier.sourceType
  if (sourceType === 'HEADQ_WAREHOUSE') {
    const mode = await resolveWarehouseMode(tx, input.tenantId, delivery.warehouseId)
    if (mode !== 'OFF') {
      const warehouseMovement = await tx.warehouseLedgerMovement.findFirst({
        where: {
          tenantId: input.tenantId,
          sourceType: 'DeliveryOrder',
          sourceId: delivery.id,
          productId: item.productId,
          type: 'ORDER_OUTBOUND',
          ...(poItemId ? { sourceLineId: poItemId } : {}),
        },
        orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }],
      })
      if (!warehouseMovement) {
        throw businessError('总仓出库流水尚未完成，暂不能移除；请稍后刷新重试', 409)
      }
      const warehouseReservation = await tx.warehouseLedgerReservation.findUnique({ where: { purchaseOrderItemId: poItemId } })
      if (warehouseReservation?.status === 'ACTIVE') {
        throw businessError('总仓预占尚未结算，暂不能移除；请稍后刷新重试', 409)
      }
      await reverseDeliveryOutboundInTransaction(tx, {
        tenantId: input.tenantId,
        userId: input.userId,
        source: 'ShipCancel',
        sourceId: `${delivery.id}:${item.id}`,
        originalMovementId: warehouseMovement.id,
        quantity: removedQty,
        reason,
      })
      if (warehouseReservation?.status === 'CONSUMED') {
        await tx.warehouseLedgerReservation.update({
          where: { id: warehouseReservation.id },
          data: { status: 'RELEASED', fulfilledInventoryQty: ZERO, releasedAt: new Date(), consumedAt: null },
        })
      }
    }
  } else if (delivery.purchaseOrder.supplier.inventoryMode === 'STRICT') {
    await reverseSupplierOutbound(tx, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      deliveryOrderId: delivery.id,
      deliveryOrderItemId: item.id,
      productId: item.productId,
      quantity: removedQty,
      userId: input.userId,
      orderNo: delivery.purchaseOrder.no,
      reason,
    })
    const reservation = await tx.supplierStockReservation.findUnique({ where: { purchaseOrderItemId: poItemId } })
    if (reservation) {
      const nextFulfilled = Prisma.Decimal.max(new Prisma.Decimal(0), new Prisma.Decimal(reservation.fulfilledQty as any).minus(removedQty))
      if (nextFulfilled.gt(0)) {
        throw businessError('供应商库存预占与配送数量不一致，无法安全移除', 409)
      }
      await tx.supplierStockReservation.update({
        where: { id: reservation.id },
        data: { status: 'RELEASED', fulfilledQty: ZERO, releasedAt: new Date(), consumedAt: null },
      })
    }
  }

  await tx.deliveryOrderItem.update({
    where: { id: item.id },
    data: { shippedQty: ZERO, amount: ZERO, receivedQty: null },
  })

  const remainingDeliveryItems = await tx.deliveryOrderItem.findMany({
    where: { deliveryOrderId: delivery.id, shippedQty: { gt: 0 } },
    select: { amount: true },
  })
  const newDeliveryTotal = sumDecimal(remainingDeliveryItems.map(row => row.amount)).toDecimalPlaces(2)
  const deliveryUpdated = await tx.deliveryOrder.updateMany({
    where: { id: delivery.id, status: delivery.status, rowVersion: input.rowVersion },
    data: { actualTotalAmount: newDeliveryTotal, rowVersion: { increment: 1 } },
  })
  if (deliveryUpdated.count !== 1) throw businessError('配送单已被其他人处理，请刷新后重试', 409)

  // 同一 PO 若存在历史拆分配送，按剩余有效配送明细重新汇总该订货行。
  const poDeliveryItems = await tx.deliveryOrderItem.findMany({
    where: {
      purchaseOrderItemId: poItemId,
      deliveryOrder: { purchaseOrderId: delivery.purchaseOrderId, status: { not: 'CANCELLED' } },
      shippedQty: { gt: 0 },
    },
    select: { shippedQty: true, amount: true },
  })
  const newShippedQty = sumDecimal(poDeliveryItems.map(row => row.shippedQty)).toDecimalPlaces(2)
  const newPoItemAmount = sumDecimal(poDeliveryItems.map(row => row.amount)).toDecimalPlaces(2)
  await tx.purchaseOrderItem.update({
    where: { id: poItemId },
    data: { shippedQty: newShippedQty, amount: newPoItemAmount },
  })

  const activePoItems = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId: delivery.purchaseOrderId, isActive: true },
    select: { amount: true },
  })
  const newOrderTotal = sumDecimal(activePoItems.map(row => row.amount)).toDecimalPlaces(2)
  const orderUpdated = await tx.purchaseOrder.updateMany({
    where: { id: delivery.purchaseOrderId, status: delivery.purchaseOrder.status, rowVersion: delivery.purchaseOrder.rowVersion },
    data: { totalAmount: newOrderTotal, rowVersion: { increment: 1 } },
  })
  if (orderUpdated.count !== 1) throw businessError('订单状态已变化，请刷新后重试', 409)

  await tx.deliveryOrderEvent.create({
    data: {
      tenantId: input.tenantId,
      deliveryOrderId: delivery.id,
      eventType: 'UPDATED',
      actorId: input.userId,
      actorRole: input.userRole,
      fromStatus: delivery.status,
      toStatus: delivery.status,
      requestId: input.requestId || null,
      ip: input.ip || null,
      metadata: {
        action: 'REMOVE_ITEM_BEFORE_RECEIPT',
        itemId: item.id,
        productId: item.productId,
        productName: item.product?.name || null,
        removedQty: removedQty.toFixed(3),
        removedAmount: new Prisma.Decimal(item.amount as any).toFixed(2),
        oldDeliveryTotal: new Prisma.Decimal(delivery.actualTotalAmount as any).toFixed(2),
        newDeliveryTotal: newDeliveryTotal.toFixed(2),
        reason,
      },
    },
  })
  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: `供应商在收货前移除配送商品 ${item.product?.name || item.productId} ${removedQty.toFixed(2)}${item.product?.unit || ''}`,
      target: delivery.no,
      entityType: 'DeliveryOrderItem',
      targetId: item.id,
      metadata: {
        deliveryOrderId: delivery.id,
        purchaseOrderId: delivery.purchaseOrderId,
        productId: item.productId,
        removedQty: removedQty.toFixed(3),
        removedAmount: new Prisma.Decimal(item.amount as any).toFixed(2),
        reason,
      },
    },
  })

  return {
    success: true,
    alreadyRemoved: false,
    removedItemId: item.id,
    deliveryId: delivery.id,
    deliveryNo: delivery.no,
    deliveryTotal: newDeliveryTotal.toFixed(2),
    orderTotal: newOrderTotal.toFixed(2),
    rowVersion: input.rowVersion + 1,
  }
}
