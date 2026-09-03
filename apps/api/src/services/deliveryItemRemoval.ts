import { Prisma } from '@dianjie/db'
import { createId } from '@paralleldrive/cuid2'
import { costUnitPricedOrderLine, PURCHASE_ORDER_AMOUNT_MAX } from './costUnitPricing'
import { resolveTenantWarehouseId } from './defaultWarehouse'
import { consumeSupplierStockBatches } from './supplierStockBatch'
import { freezeProductFourUnitsForSupplyDocument } from './supplyDocumentUnitSnapshots'
import {
  consumeWarehouseLedgerForShipment,
  resolveFrozenOrderInventoryLine,
  reverseDeliveryOutboundInTransaction,
} from './warehouseLedger'
import { FORMAL_DELIVERY_STATUSES } from './shipmentDraftMarker'

const ZERO = new Prisma.Decimal(0)
const SUPPLIER_STOCK_REMOVAL_SOURCE = 'DeliveryOrderItemRemoval'
const SUPPLIER_STOCK_QUANTITY_SOURCE = 'DeliveryOrderItemQuantityAdjustment'

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

type MutationActorInput = Omit<RemovalInput, 'itemId' | 'supplierId'> & {
  supplierId: string
}

type QuantityInput = MutationActorInput & {
  itemId: string
  targetQuantity: Prisma.Decimal
}

type AddItemInput = MutationActorInput & {
  productId?: string | null
  customProduct?: { name: string; unit: string; unitPrice: Prisma.Decimal } | null
  quantity: Prisma.Decimal
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

export function customDeliveryLinePrice(quantityInput: Prisma.Decimal, unitPriceInput: Prisma.Decimal) {
  const unitPrice = new Prisma.Decimal(unitPriceInput).toDecimalPlaces(2)
  return {
    unitPrice,
    amount: new Prisma.Decimal(quantityInput).mul(unitPrice).toDecimalPlaces(2),
  }
}

/** Append-only reversal for one delivery/product across all outbound movements. */
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
    sourceType?: string
    sourceId?: string
  },
) {
  const sourceType = input.sourceType || SUPPLIER_STOCK_REMOVAL_SOURCE
  const sourceId = String(input.sourceId || `${input.deliveryOrderId}:${input.deliveryOrderItemId}`).slice(0, 80)

  // Product 是供应商库存的物理余额 owner；先锁它，避免两个库存事务交叉更新。
  const lockedProducts = await tx.$queryRaw<Array<{ id: string; stock: Prisma.Decimal }>>(Prisma.sql`
    SELECT "id", "stock"
    FROM "products"
    WHERE "id" = ${input.productId}
      AND "tenantId" = ${input.tenantId}
      AND "supplierId" = ${input.supplierId}
    FOR UPDATE
  `)
  if (lockedProducts.length !== 1) throw businessError('商品不属于当前供应商，无法调整', 403)

  const replay = await tx.supplierStockMovement.findFirst({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      sourceType,
      sourceId,
    },
    select: { id: true },
  })
  if (replay) return { reversed: false, replayed: true, movementId: replay.id }

  const originals = await tx.supplierStockMovement.findMany({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      sourceType: 'DeliveryOrder',
      sourceId: input.deliveryOrderId,
      type: 'OUTBOUND_PO',
      delta: { lt: 0 },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (originals.length === 0) {
    throw businessError('该配送单缺少供应商出库流水，无法安全调整；请先完成库存对账', 409)
  }

  const quantity = new Prisma.Decimal(input.quantity as any).toDecimalPlaces(3)
  if (quantity.lte(0)) throw businessError('冲回数量必须大于 0', 400)
  const originalQuantity = sumDecimal(originals.map(original => new Prisma.Decimal(original.delta as any).abs())).toDecimalPlaces(3)
  const priorReversals = await tx.supplierStockMovement.aggregate({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      delta: { gt: 0 },
      sourceType: { in: [SUPPLIER_STOCK_REMOVAL_SOURCE, SUPPLIER_STOCK_QUANTITY_SOURCE] },
      OR: [
        { sourceId: `${input.deliveryOrderId}:${input.deliveryOrderItemId}` },
        { sourceId: { startsWith: `${input.deliveryOrderId}:${input.deliveryOrderItemId}:` } },
      ],
    },
    _sum: { delta: true },
  })
  const alreadyReversed = new Prisma.Decimal(priorReversals._sum.delta || 0).toDecimalPlaces(3)
  if (alreadyReversed.plus(quantity).gt(originalQuantity.plus(new Prisma.Decimal('0.0001')))) {
    throw businessError('累计冲回数量将超过该配送商品的出库数量', 409)
  }

  const allocations = await tx.supplierStockBatchAllocation.findMany({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      movementId: { in: originals.map(original => original.id) },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (allocations.length === 0) {
    throw businessError('该配送单缺少供应商批次分配，无法安全移除；请先完成库存对账', 409)
  }
  const allocationTotal = sumDecimal(allocations.map(item => item.quantity)).toDecimalPlaces(3)
  if (!equalDecimal(allocationTotal, originalQuantity)) {
    throw businessError('供应商批次分配与累计出库数量不一致，无法安全调整', 409)
  }

  const now = new Date()
  let remaining = quantity
  for (const allocation of allocations) {
    if (remaining.lte(0)) break
    const batch = await tx.supplierStockBatch.findUnique({ where: { id: allocation.batchId } })
    if (!batch) throw businessError('供应商库存批次不存在，无法安全调整', 409)
    const capacity = Prisma.Decimal.max(ZERO, new Prisma.Decimal(batch.initialQty as any).minus(batch.remainingQty as any))
    const giveBack = Prisma.Decimal.min(remaining, new Prisma.Decimal(allocation.quantity as any), capacity).toDecimalPlaces(3)
    if (giveBack.lte(0)) continue
    const nextRemaining = new Prisma.Decimal(batch.remainingQty as any).plus(giveBack)
    await tx.supplierStockBatch.update({
      where: { id: batch.id },
      data: { remainingQty: nextRemaining, depletedAt: null },
    })
    remaining = remaining.minus(giveBack).toDecimalPlaces(3)
  }
  if (remaining.gt(0)) throw businessError('供应商批次可恢复数量不足，无法安全调整', 409)

  const updatedProduct = await tx.product.update({
    where: { id: input.productId },
    data: { stock: { increment: quantity } },
    select: { stock: true },
  })
  const movement = await tx.supplierStockMovement.create({
    data: {
      tenantId: input.tenantId,
      warehouseId: originals[0].warehouseId,
      supplierId: input.supplierId,
      productId: input.productId,
      delta: quantity,
      balanceAfter: updatedProduct.stock,
      type: 'ADJUSTMENT',
      reason: input.reason.slice(0, 200),
      sourceType,
      sourceId,
      createdById: input.userId,
      createdAt: now,
    },
  })

  return { reversed: true, replayed: false, movementId: movement.id }
}

/** Deduct additional strict supplier stock without consuming other orders' reservations. */
async function consumeAdditionalSupplierOutbound(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    supplierId: string
    purchaseOrderId: string
    deliveryOrderId: string
    productId: string
    quantity: Prisma.Decimal
    userId: string
    orderNo: string
    reason: string
  },
) {
  const quantity = new Prisma.Decimal(input.quantity).toDecimalPlaces(3)
  if (quantity.lte(0)) throw businessError('追加出库数量必须大于 0', 400)
  const rows = await tx.$queryRaw<Array<{ id: string; stock: Prisma.Decimal }>>(Prisma.sql`
    SELECT "id", "stock"
    FROM "products"
    WHERE "id" = ${input.productId}
      AND "tenantId" = ${input.tenantId}
      AND "supplierId" = ${input.supplierId}
    FOR UPDATE
  `)
  if (rows.length !== 1) throw businessError('商品不属于当前供应商，无法调整', 403)
  const reservedByOthers = await tx.supplierStockReservation.aggregate({
    where: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      purchaseOrderId: { not: input.purchaseOrderId },
      status: 'ACTIVE',
    },
    _sum: { quantity: true },
  })
  const protectedAvailable = rows[0].stock.minus(reservedByOthers._sum.quantity || 0)
  if (protectedAvailable.lt(quantity)) {
    throw businessError(`商品可发库存不足：可发 ${protectedAvailable.toFixed(3)}，本次需要 ${quantity.toFixed(3)}`, 409)
  }
  const updated = await tx.product.update({
    where: { id: input.productId },
    data: { stock: { decrement: quantity } },
    select: { stock: true },
  })
  const movement = await tx.supplierStockMovement.create({
    data: {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: input.productId,
      delta: quantity.negated(),
      balanceAfter: updated.stock,
      type: 'OUTBOUND_PO',
      reason: input.reason.slice(0, 200),
      sourceType: 'DeliveryOrder',
      sourceId: input.deliveryOrderId,
      createdById: input.userId,
    },
  })
  await consumeSupplierStockBatches(tx, {
    tenantId: input.tenantId,
    supplierId: input.supplierId,
    productId: input.productId,
    quantity,
    movementId: movement.id,
  })
  return movement
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
 * 在收货前移除配送单的一行。配送明细采用“软移除”（实发量/金额置零并记录
 * removedAt），原订单、原始快照和历史流水均保留。读取接口只过滤 removedAt，
 * 因此“数量保存为 0”仍会显示，只有点击移除才从页面消失。
 */
export async function removeDeliveryItemInTransaction(
  tx: Prisma.TransactionClient,
  input: RemovalInput,
) {
  // 与收货/送达并发时先串行化同一配送单；数据库行锁是第二道门禁。
  // pg_advisory_xact_lock returns void; cast it before Prisma deserializes the
  // result so the lock is acquired without producing a runtime 500.
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`delivery-item-mutation:${input.tenantId}:${input.deliveryOrderId}`}))::text AS locked
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
  if (item.removedAt) {
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
  if (removedQty.gt(0) && remainingCount === 0) throw businessError('配送单至少要保留一件商品；如整单不发请走拒单流程', 409)

  const poItemId = item.purchaseOrderItemId
  if (!poItemId) throw businessError('历史配送明细未关联原订货行，不能安全移除', 409)
  const poItem = delivery.purchaseOrder.items.find(candidate => candidate.id === poItemId)
  if (!poItem) throw businessError('原订货行不存在或已停用，不能安全移除', 409)

  const actorLabel = '内部供应链'
  const reason = String(input.reason || `${actorLabel}在门店收货前移除商品`).trim().slice(0, 200)
  const sourceType = delivery.purchaseOrder.supplier.sourceType
  if (sourceType === 'HEADQ_WAREHOUSE') {
    const mode = await resolveWarehouseMode(tx, input.tenantId, delivery.warehouseId)
    if (mode !== 'OFF') {
      const warehouseReservation = await tx.warehouseLedgerReservation.findUnique({ where: { purchaseOrderItemId: poItemId } })
      if (warehouseReservation?.status === 'ACTIVE') {
        throw businessError('总仓预占尚未结算，暂不能移除；请稍后刷新重试', 409)
      }
      if (removedQty.gt(0)) {
        await reverseWarehouseOutboundQuantity(tx, {
          tenantId: input.tenantId,
          userId: input.userId,
          deliveryOrderId: delivery.id,
          deliveryOrderItemId: item.id,
          purchaseOrderItemId: poItemId,
          productId: item.productId,
          quantity: removedQty,
          reason,
          operationKey: 'remove',
        })
      }
      if (warehouseReservation?.status === 'CONSUMED') {
        await tx.warehouseLedgerReservation.update({
          where: { id: warehouseReservation.id },
          data: { status: 'RELEASED', fulfilledInventoryQty: ZERO, releasedAt: new Date(), consumedAt: null },
        })
      }
    }
  } else if (delivery.purchaseOrder.supplier.inventoryMode === 'STRICT') {
    if (removedQty.gt(0)) {
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
    }
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
    data: { shippedQty: ZERO, amount: ZERO, receivedQty: null, removedAt: new Date() },
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
      deliveryOrder: {
        purchaseOrderId: delivery.purchaseOrderId,
        status: { in: [...FORMAL_DELIVERY_STATUSES] },
      },
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
      action: `${actorLabel}在收货前移除配送商品 ${item.product?.name || item.productId} ${removedQty.toFixed(2)}${item.product?.unit || ''}`,
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

async function reverseWarehouseOutboundQuantity(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    userId: string
    deliveryOrderId: string
    deliveryOrderItemId: string
    purchaseOrderItemId: string
    productId: string
    quantity: Prisma.Decimal
    reason: string
    operationKey: string
  },
) {
  let remaining = new Prisma.Decimal(input.quantity).toDecimalPlaces(6)
  const movements = await tx.warehouseLedgerMovement.findMany({
    where: {
      tenantId: input.tenantId,
      sourceType: 'DeliveryOrder',
      sourceId: input.deliveryOrderId,
      sourceLineId: input.purchaseOrderItemId,
      productId: input.productId,
      type: 'ORDER_OUTBOUND',
    },
    orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
  })
  if (movements.length === 0) {
    throw businessError('总仓出库流水尚未完成，暂不能调整；请稍后刷新重试', 409)
  }
  for (let index = 0; index < movements.length && remaining.gt(0); index += 1) {
    const movement = movements[index]
    const prior = await tx.warehouseLedgerMovement.aggregate({
      where: {
        tenantId: input.tenantId,
        warehouseId: movement.warehouseId,
        productId: movement.productId,
        type: 'REVERSAL',
        sourceLineId: movement.id,
      },
      _sum: { inventoryQuantity: true },
    })
    const availableInventory = Prisma.Decimal.max(
      ZERO,
      new Prisma.Decimal(movement.inventoryQuantity).minus(prior._sum.inventoryQuantity || 0),
    )
    const availableOriginal = availableInventory.div(movement.conversionFactor).toDecimalPlaces(6)
    const chunk = Prisma.Decimal.min(remaining, availableOriginal).toDecimalPlaces(6)
    if (chunk.lte(0)) continue
    await reverseDeliveryOutboundInTransaction(tx, {
      tenantId: input.tenantId,
      userId: input.userId,
      source: 'ShipCancel',
      sourceId: `${input.deliveryOrderId}:${input.deliveryOrderItemId}:${input.operationKey}:${index}`.slice(0, 80),
      originalMovementId: movement.id,
      quantity: chunk,
      reason: input.reason,
    })
    remaining = remaining.minus(chunk).toDecimalPlaces(6)
  }
  if (remaining.gt(new Prisma.Decimal('0.000001'))) {
    throw businessError('总仓可冲回出库数量不足，请先完成库存对账', 409)
  }
}

async function loadDeliveryForInternalMutation(
  tx: Prisma.TransactionClient,
  input: MutationActorInput,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`delivery-item-mutation:${input.tenantId}:${input.deliveryOrderId}`}))::text AS locked
  `)
  const locks = await tx.$queryRaw<Array<{ id: string; purchaseOrderId: string }>>(Prisma.sql`
    SELECT "id", "purchaseOrderId"
    FROM "delivery_orders"
    WHERE "id" = ${input.deliveryOrderId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `)
  if (locks.length !== 1) throw businessError('配送单不存在', 404)
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "purchase_orders"
    WHERE "id" = ${locks[0].purchaseOrderId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `)
  const delivery = await tx.deliveryOrder.findUnique({
    where: { id: input.deliveryOrderId },
    include: {
      purchaseOrder: {
        include: {
          supplier: { select: { id: true, sourceType: true, inventoryMode: true, name: true } },
          items: { where: { isActive: true }, include: { product: true } },
        },
      },
      items: { include: { product: true } },
      receipt: { select: { id: true } },
    },
  })
  if (
    !delivery
    || delivery.supplierId !== input.supplierId
    || delivery.purchaseOrder.supplierId !== input.supplierId
  ) throw businessError('配送单不存在', 404)
  if (delivery.status !== 'SHIPPED') throw businessError('仅未送达的配送单可以调整商品', 409)
  if (delivery.receipt) throw businessError('配送单已生成收货单，不能调整商品', 409)
  if (delivery.rowVersion !== input.rowVersion) throw businessError('配送单已更新，请刷新后重试', 409)
  return delivery
}

function resolvedInventoryTarget(item: any, targetQuantity: Prisma.Decimal) {
  return resolveFrozenOrderInventoryLine({
    purchaseOrderItemId: String(item.purchaseOrderItemId),
    productId: String(item.productId),
    quantity: targetQuantity,
    shippedQty: targetQuantity,
    productName: item.productNameSnapshot || item.product?.name,
    productUnit: item.productUnitSnapshot || item.product?.unit,
    orderUnitSnapshot: item.orderUnitSnapshot,
    inventoryUnitSnapshot: item.inventoryUnitSnapshot,
    inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot,
  })
}

async function syncSupplierReservation(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    supplierId: string
    purchaseOrderId: string
    purchaseOrderItemId: string
    productId: string
    targetQuantity: Prisma.Decimal
    allowCreate: boolean
  },
) {
  const reservation = await tx.supplierStockReservation.findUnique({
    where: { purchaseOrderItemId: input.purchaseOrderItemId },
  })
  if (!reservation) {
    if (!input.allowCreate) throw businessError('供应商库存预占记录缺失，无法安全调整', 409)
    await tx.supplierStockReservation.create({
      data: {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        productId: input.productId,
        purchaseOrderId: input.purchaseOrderId,
        purchaseOrderItemId: input.purchaseOrderItemId,
        quantity: input.targetQuantity,
        fulfilledQty: input.targetQuantity,
        status: 'CONSUMED',
        consumedAt: new Date(),
      },
    })
    return
  }
  if (
    reservation.tenantId !== input.tenantId
    || reservation.supplierId !== input.supplierId
    || reservation.purchaseOrderId !== input.purchaseOrderId
    || reservation.productId !== input.productId
  ) throw businessError('供应商库存预占范围不一致，无法安全调整', 409)
  if (reservation.status === 'ACTIVE') throw businessError('供应商库存预占尚未结算，暂不能调整', 409)
  await tx.supplierStockReservation.update({
    where: { id: reservation.id },
    data: { status: 'CONSUMED', fulfilledQty: input.targetQuantity, consumedAt: reservation.consumedAt || new Date() },
  })
}

async function syncWarehouseReservation(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    warehouseId: string
    purchaseOrderId: string
    purchaseOrderItemId: string
    productId: string
    item: any
    targetQuantity: Prisma.Decimal
    allowCreate: boolean
  },
) {
  const resolved = resolvedInventoryTarget(input.item, input.targetQuantity)
  const reservation = await tx.warehouseLedgerReservation.findUnique({
    where: { purchaseOrderItemId: input.purchaseOrderItemId },
  })
  if (!reservation) {
    if (!input.allowCreate) throw businessError('总仓预占记录缺失，无法安全调整', 409)
    await tx.warehouseLedgerReservation.create({
      data: {
        tenantId: input.tenantId,
        warehouseId: input.warehouseId,
        productId: input.productId,
        purchaseOrderId: input.purchaseOrderId,
        purchaseOrderItemId: input.purchaseOrderItemId,
        originalQuantity: input.targetQuantity,
        originalUnit: resolved.originalUnit,
        conversionFactor: resolved.conversionFactor,
        inventoryQuantity: resolved.inventoryQuantity,
        fulfilledInventoryQty: resolved.inventoryQuantity,
        inventoryUnit: resolved.inventoryUnit,
        status: 'CONSUMED',
        consumedAt: new Date(),
      },
    })
    return
  }
  if (
    reservation.tenantId !== input.tenantId
    || reservation.warehouseId !== input.warehouseId
    || reservation.purchaseOrderId !== input.purchaseOrderId
    || reservation.productId !== input.productId
  ) throw businessError('总仓预占范围不一致，无法安全调整', 409)
  if (reservation.status === 'ACTIVE') throw businessError('总仓预占尚未结算，暂不能调整', 409)
  if (!new Prisma.Decimal(reservation.conversionFactor).equals(resolved.conversionFactor)) {
    throw businessError('配送商品与总仓预占的单位换算不一致', 409)
  }
  await tx.warehouseLedgerReservation.update({
    where: { id: reservation.id },
    data: {
      status: 'CONSUMED',
      fulfilledInventoryQty: resolved.inventoryQuantity,
      consumedAt: reservation.consumedAt || new Date(),
    },
  })
}

async function recalculateDeliveryAndOrderTotals(
  tx: Prisma.TransactionClient,
  input: { delivery: any; purchaseOrderItemId: string; expectedDeliveryRowVersion: number },
) {
  const deliveryItems = await tx.deliveryOrderItem.findMany({
    where: { deliveryOrderId: input.delivery.id, shippedQty: { gt: 0 } },
    select: { amount: true },
  })
  const deliveryTotal = sumDecimal(deliveryItems.map(item => item.amount)).toDecimalPlaces(2)
  if (deliveryTotal.gt(PURCHASE_ORDER_AMOUNT_MAX)) throw businessError('配送单总金额超过系统上限', 400)
  const deliveryUpdated = await tx.deliveryOrder.updateMany({
    where: { id: input.delivery.id, status: 'SHIPPED', rowVersion: input.expectedDeliveryRowVersion },
    data: { actualTotalAmount: deliveryTotal, rowVersion: { increment: 1 } },
  })
  if (deliveryUpdated.count !== 1) throw businessError('配送单已被其他人处理，请刷新后重试', 409)

  const linkedItems = await tx.deliveryOrderItem.findMany({
    where: {
      purchaseOrderItemId: input.purchaseOrderItemId,
      deliveryOrder: {
        purchaseOrderId: input.delivery.purchaseOrderId,
        status: { in: [...FORMAL_DELIVERY_STATUSES] },
      },
      shippedQty: { gt: 0 },
    },
    select: { shippedQty: true, amount: true },
  })
  const shippedQty = sumDecimal(linkedItems.map(item => item.shippedQty)).toDecimalPlaces(2)
  const poItemAmount = sumDecimal(linkedItems.map(item => item.amount)).toDecimalPlaces(2)
  await tx.purchaseOrderItem.update({
    where: { id: input.purchaseOrderItemId },
    data: { shippedQty, amount: poItemAmount },
  })

  const poItems = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId: input.delivery.purchaseOrderId, isActive: true },
    select: { amount: true },
  })
  const orderTotal = sumDecimal(poItems.map(item => item.amount)).toDecimalPlaces(2)
  if (orderTotal.gt(PURCHASE_ORDER_AMOUNT_MAX)) throw businessError('订货单总金额超过系统上限', 400)
  const orderUpdated = await tx.purchaseOrder.updateMany({
    where: {
      id: input.delivery.purchaseOrderId,
      status: input.delivery.purchaseOrder.status,
      rowVersion: input.delivery.purchaseOrder.rowVersion,
    },
    data: { totalAmount: orderTotal, rowVersion: { increment: 1 } },
  })
  if (orderUpdated.count !== 1) throw businessError('订单状态已变化，请刷新后重试', 409)
  return { deliveryTotal, orderTotal }
}

/** Internal supply chain adjusts a non-negative shipped quantity before delivery. */
export async function changeDeliveryItemQuantityInTransaction(
  tx: Prisma.TransactionClient,
  input: QuantityInput,
) {
  const delivery = await loadDeliveryForInternalMutation(tx, input)
  const item = delivery.items.find(candidate => candidate.id === input.itemId)
  if (!item || item.removedAt) throw businessError('配送商品不存在', 404)
  if (!item.purchaseOrderItemId) throw businessError('历史配送明细未关联原订货行，不能安全调整', 409)
  const poItem = delivery.purchaseOrder.items.find(candidate => candidate.id === item.purchaseOrderItemId)
  if (!poItem) throw businessError('原订货行不存在或已停用，不能安全调整', 409)

  const target = new Prisma.Decimal(input.targetQuantity).toDecimalPlaces(2)
  const current = new Prisma.Decimal(item.shippedQty).toDecimalPlaces(2)
  if (target.lt(0)) throw businessError('调整后数量不能小于 0', 400)
  if (target.equals(current)) throw businessError('调整后数量与当前相同', 400)
  const delta = target.minus(current)
  const reason = String(input.reason || '内部供应链在送达前调整商品数量').trim().slice(0, 200)
  const supplier = delivery.purchaseOrder.supplier

  if (supplier.sourceType === 'HEADQ_WAREHOUSE') {
    const mode = await resolveWarehouseMode(tx, input.tenantId, delivery.warehouseId)
    if (mode !== 'OFF') {
      const warehouseId = delivery.warehouseId || await resolveTenantWarehouseId(tx, input.tenantId, undefined)
      const reservation = await tx.warehouseLedgerReservation.findUnique({ where: { purchaseOrderItemId: poItem.id } })
      if (!reservation) throw businessError('总仓预占记录缺失，无法安全调整', 409)
      if (reservation.status === 'ACTIVE') throw businessError('总仓预占尚未结算，暂不能调整', 409)
      if (delta.lt(0)) {
        await reverseWarehouseOutboundQuantity(tx, {
          tenantId: input.tenantId,
          userId: input.userId,
          deliveryOrderId: delivery.id,
          deliveryOrderItemId: item.id,
          purchaseOrderItemId: poItem.id,
          productId: item.productId,
          quantity: delta.abs(),
          reason,
          operationKey: `qty-${input.rowVersion}`,
        })
      } else {
        await consumeWarehouseLedgerForShipment(tx, {
          tenantId: input.tenantId,
          warehouseId,
          purchaseOrderId: delivery.purchaseOrderId,
          deliveryOrderId: delivery.id,
          orderNo: delivery.purchaseOrder.no,
          userId: input.userId,
          effectiveAt: new Date(),
          idempotencyKeySuffix: `quantity-${input.rowVersion}`,
          lines: [{
            purchaseOrderItemId: poItem.id,
            productId: item.productId,
            quantity: delta,
            shippedQty: delta,
            productName: item.productNameSnapshot || item.product?.name,
            productUnit: item.productUnitSnapshot || item.product?.unit,
            orderUnitSnapshot: item.orderUnitSnapshot,
            inventoryUnitSnapshot: item.inventoryUnitSnapshot,
            inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot,
          }],
        })
      }
      await syncWarehouseReservation(tx, {
        tenantId: input.tenantId,
        warehouseId,
        purchaseOrderId: delivery.purchaseOrderId,
        purchaseOrderItemId: poItem.id,
        productId: item.productId,
        item,
        targetQuantity: target,
        allowCreate: false,
      })
    }
  } else if (supplier.inventoryMode === 'STRICT') {
    const reservation = await tx.supplierStockReservation.findUnique({ where: { purchaseOrderItemId: poItem.id } })
    if (!reservation) throw businessError('供应商库存预占记录缺失，无法安全调整', 409)
    if (reservation.status === 'ACTIVE') throw businessError('供应商库存预占尚未结算，暂不能调整', 409)
    if (delta.lt(0)) {
      await reverseSupplierOutbound(tx, {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        deliveryOrderId: delivery.id,
        deliveryOrderItemId: item.id,
        productId: item.productId,
        quantity: delta.abs(),
        userId: input.userId,
        orderNo: delivery.purchaseOrder.no,
        reason,
        sourceType: SUPPLIER_STOCK_QUANTITY_SOURCE,
        sourceId: `${delivery.id}:${item.id}:${input.rowVersion}`,
      })
    } else {
      await consumeAdditionalSupplierOutbound(tx, {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        purchaseOrderId: delivery.purchaseOrderId,
        deliveryOrderId: delivery.id,
        productId: item.productId,
        quantity: delta,
        userId: input.userId,
        orderNo: delivery.purchaseOrder.no,
        reason,
      })
    }
    await syncSupplierReservation(tx, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      purchaseOrderId: delivery.purchaseOrderId,
      purchaseOrderItemId: poItem.id,
      productId: item.productId,
      targetQuantity: target,
      allowCreate: false,
    })
  }

  const oldAmount = new Prisma.Decimal(item.amount)
  const newAmount = target.mul(item.unitPriceSnapshot).toDecimalPlaces(2)
  if (newAmount.gt(PURCHASE_ORDER_AMOUNT_MAX)) throw businessError('单行金额超过系统上限', 400)
  await tx.deliveryOrderItem.update({
    where: { id: item.id },
    data: { shippedQty: target, amount: newAmount },
  })
  const totals = await recalculateDeliveryAndOrderTotals(tx, {
    delivery,
    purchaseOrderItemId: poItem.id,
    expectedDeliveryRowVersion: input.rowVersion,
  })
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
        action: 'CHANGE_ITEM_QUANTITY_BEFORE_DELIVERY',
        itemId: item.id,
        productId: item.productId,
        oldQuantity: current.toFixed(2),
        newQuantity: target.toFixed(2),
        oldAmount: oldAmount.toFixed(2),
        newAmount: newAmount.toFixed(2),
        reason,
      },
    },
  })
  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: `内部供应链在送达前调整配送商品 ${item.productNameSnapshot || item.product?.name || item.productId} ${current.toFixed(2)}→${target.toFixed(2)}`,
      target: delivery.no,
      entityType: 'DeliveryOrderItem',
      targetId: item.id,
      metadata: { deliveryOrderId: delivery.id, purchaseOrderId: delivery.purchaseOrderId, oldQuantity: current.toFixed(2), newQuantity: target.toFixed(2), reason },
    },
  })
  return {
    success: true,
    itemId: item.id,
    deliveryId: delivery.id,
    rowVersion: input.rowVersion + 1,
    deliveryTotal: totals.deliveryTotal.toFixed(2),
    orderTotal: totals.orderTotal.toFixed(2),
  }
}

/** Internal supply chain appends a missing product to an already-shipped delivery. */
export async function addDeliveryItemInTransaction(
  tx: Prisma.TransactionClient,
  input: AddItemInput,
) {
  const delivery = await loadDeliveryForInternalMutation(tx, input)
  const quantity = new Prisma.Decimal(input.quantity).toDecimalPlaces(2)
  if (quantity.lte(0)) throw businessError('新增商品数量必须大于 0', 400)
  const custom = input.customProduct || null
  let product: any
  if (custom) {
    const unit = String(custom.unit).trim()
    product = await tx.product.create({
      data: {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        code: `CUSTOM-${createId().slice(-12).toUpperCase()}`,
        name: String(custom.name).trim(),
        category: '其他',
        unit,
        purchaseUnit: unit,
        inventoryUnit: unit,
        orderUnit: unit,
        costUnit: unit,
        inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(1),
        inventoryUnitsPerOrderUnit: new Prisma.Decimal(1),
        inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
        unitConversionStatus: 'VERIFIED',
        unitConversionVerifiedAt: new Date(),
        price: custom.unitPrice,
        stock: ZERO,
        status: 'ENABLED',
      },
    })
  } else {
    product = await tx.product.findFirst({
      where: {
        id: String(input.productId),
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        status: 'ENABLED',
      },
    })
    if (!product) throw businessError('商品不存在、已停用或不属于当前供应商', 404)
  }
  const duplicate = delivery.items.find(candidate => candidate.productId === product.id)
  if (duplicate) {
    throw businessError(
      duplicate.removedAt
        ? '该商品曾从本配送单移除，为保留原审计行暂不能重复新增'
        : '该商品已在配送单中，请使用数量调整',
      409,
    )
  }

  const priced = custom
    ? customDeliveryLinePrice(quantity, custom.unitPrice)
    : costUnitPricedOrderLine({ product, quantity })
  if (priced.amount.gt(PURCHASE_ORDER_AMOUNT_MAX)) throw businessError('单行金额超过系统上限', 400)
  const frozen = freezeProductFourUnitsForSupplyDocument(product)
  const poItem = await tx.purchaseOrderItem.create({
    data: {
      purchaseOrderId: delivery.purchaseOrderId,
      productId: product.id,
      quantity,
      originalQuantity: null,
      shippedQty: quantity,
      unitPrice: priced.unitPrice,
      originalUnitPrice: null,
      amount: priced.amount,
      originalAmount: null,
      lineOrigin: 'APPROVED_REVISION',
      isActive: true,
      ...frozen,
    },
  })
  const deliveryItem = await tx.deliveryOrderItem.create({
    data: {
      deliveryOrderId: delivery.id,
      purchaseOrderItemId: poItem.id,
      productId: product.id,
      orderedQtySnapshot: quantity,
      shippedQty: quantity,
      unitPriceSnapshot: priced.unitPrice,
      amount: priced.amount,
      productCodeSnapshot: product.code,
      productNameSnapshot: product.name,
      productSpecSnapshot: product.spec,
      productUnitSnapshot: product.orderUnit || product.unit,
      productCategorySnapshot: product.category,
      ...frozen,
    },
  })
  const reason = String(input.reason || '内部供应链在送达前增加配送商品').trim().slice(0, 200)
  const supplier = delivery.purchaseOrder.supplier
  if (supplier.sourceType === 'HEADQ_WAREHOUSE') {
    const mode = await resolveWarehouseMode(tx, input.tenantId, delivery.warehouseId)
    if (mode !== 'OFF') {
      const warehouseId = delivery.warehouseId || await resolveTenantWarehouseId(tx, input.tenantId, undefined)
      await consumeWarehouseLedgerForShipment(tx, {
        tenantId: input.tenantId,
        warehouseId,
        purchaseOrderId: delivery.purchaseOrderId,
        deliveryOrderId: delivery.id,
        orderNo: delivery.purchaseOrder.no,
        userId: input.userId,
        effectiveAt: new Date(),
        idempotencyKeySuffix: `add-${input.rowVersion}`,
        lines: [{
          purchaseOrderItemId: poItem.id,
          productId: product.id,
          quantity,
          shippedQty: quantity,
          productName: product.name,
          productUnit: product.orderUnit || product.unit,
          orderUnitSnapshot: frozen.orderUnitSnapshot,
          inventoryUnitSnapshot: frozen.inventoryUnitSnapshot,
          inventoryUnitsPerOrderUnitSnapshot: frozen.inventoryUnitsPerOrderUnitSnapshot,
        }],
      })
      await syncWarehouseReservation(tx, {
        tenantId: input.tenantId,
        warehouseId,
        purchaseOrderId: delivery.purchaseOrderId,
        purchaseOrderItemId: poItem.id,
        productId: product.id,
        item: deliveryItem,
        targetQuantity: quantity,
        allowCreate: true,
      })
    }
  } else if (supplier.inventoryMode === 'STRICT') {
    await consumeAdditionalSupplierOutbound(tx, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      purchaseOrderId: delivery.purchaseOrderId,
      deliveryOrderId: delivery.id,
      productId: product.id,
      quantity,
      userId: input.userId,
      orderNo: delivery.purchaseOrder.no,
      reason,
    })
    await syncSupplierReservation(tx, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      purchaseOrderId: delivery.purchaseOrderId,
      purchaseOrderItemId: poItem.id,
      productId: product.id,
      targetQuantity: quantity,
      allowCreate: true,
    })
  }

  const totals = await recalculateDeliveryAndOrderTotals(tx, {
    delivery,
    purchaseOrderItemId: poItem.id,
    expectedDeliveryRowVersion: input.rowVersion,
  })
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
        action: 'ADD_ITEM_BEFORE_DELIVERY',
        itemId: deliveryItem.id,
        productId: product.id,
        customProduct: Boolean(custom),
        quantity: quantity.toFixed(2),
        unitPrice: priced.unitPrice.toFixed(2),
        amount: priced.amount.toFixed(2),
        reason,
      },
    },
  })
  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: `内部供应链在送达前增加配送商品 ${product.name} ${quantity.toFixed(2)}${product.orderUnit || product.unit}`,
      target: delivery.no,
      entityType: 'DeliveryOrderItem',
      targetId: deliveryItem.id,
      metadata: { deliveryOrderId: delivery.id, purchaseOrderId: delivery.purchaseOrderId, productId: product.id, customProduct: Boolean(custom), quantity: quantity.toFixed(2), unitPrice: priced.unitPrice.toFixed(2), reason },
    },
  })
  return {
    success: true,
    itemId: deliveryItem.id,
    productId: product.id,
    customProductCreated: Boolean(custom),
    deliveryId: delivery.id,
    rowVersion: input.rowVersion + 1,
    deliveryTotal: totals.deliveryTotal.toFixed(2),
    orderTotal: totals.orderTotal.toFixed(2),
  }
}
