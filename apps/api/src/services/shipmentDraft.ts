import { Prisma } from '@dianjie/db'
import { costUnitPriceToOrderUnitPrice, PURCHASE_ORDER_AMOUNT_MAX } from './costUnitPricing'
import {
  copyFrozenSupplyDocumentFourUnits,
  freezeProductFourUnitsForSupplyDocument,
} from './supplyDocumentUnitSnapshots'
import { SERVER_SHIPMENT_DRAFT_KEY } from './shipmentDraftMarker'

export type ShipmentDraftLineInput = {
  purchaseOrderItemId?: string | null
  productId: string
  shippedQty: number | string | Prisma.Decimal
  removed?: boolean
}

export type SaveShipmentDraftInput = {
  tenantId: string
  supplierId?: string | null
  purchaseOrderId: string
  userId: string
  userRole: string
  orderRowVersion: number
  draftRowVersion?: number | null
  items: ShipmentDraftLineInput[]
  requestId?: string | null
  ip?: string | null
}

function businessError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function quantity(value: ShipmentDraftLineInput['shippedQty']) {
  const result = new Prisma.Decimal(value).toDecimalPlaces(2)
  if (!result.isFinite() || result.lt(0)) throw businessError('实发数量不能小于 0', 400)
  if (result.gt(new Prisma.Decimal('99999999.99'))) throw businessError('实发数量超过系统上限', 400)
  return result
}

function sum(values: Prisma.Decimal[]) {
  return values.reduce((total, value) => total.add(value), new Prisma.Decimal(0)).toDecimalPlaces(2)
}

/**
 * Persist the CONFIRMED-stage shipment editor in the DeliveryOrder aggregate.
 *
 * A DRAFT is document intent only: this transaction deliberately does not
 * update PurchaseOrder status/totals, PurchaseOrderItem.shippedQty, physical
 * inventory, batches, movements, or reservations. Those facts are finalized
 * atomically by the existing shipment transition.
 */
export async function saveShipmentDraftInTransaction(
  tx: Prisma.TransactionClient,
  input: SaveShipmentDraftInput,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`shipment:${input.tenantId}:${input.purchaseOrderId}`}))::text AS locked
  `)
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "purchase_orders"
    WHERE "id" = ${input.purchaseOrderId} AND "tenantId" = ${input.tenantId}
    FOR UPDATE
  `)

  const order = await tx.purchaseOrder.findFirst({
    where: {
      id: input.purchaseOrderId,
      tenantId: input.tenantId,
      status: 'CONFIRMED',
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
    },
    include: {
      items: { where: { isActive: true }, include: { product: true } },
    },
  })
  if (!order) throw businessError('订单不存在或当前状态不可保存实发明细', 409)
  if (order.rowVersion !== input.orderRowVersion) throw businessError('订单已更新，请刷新后重试', 409)
  const duplicateProducts = input.items.map(item => item.productId)
  if (new Set(duplicateProducts).size !== duplicateProducts.length) {
    throw businessError('同一商品不能在发货草稿中重复出现', 400)
  }
  const linkedIds = input.items.flatMap(item => item.purchaseOrderItemId ? [item.purchaseOrderItemId] : [])
  if (new Set(linkedIds).size !== linkedIds.length) throw businessError('同一订货明细不能重复提交', 400)

  const orderItemById = new Map(order.items.map(item => [item.id, item]))
  const submittedOrderIds = new Set(linkedIds)
  for (const line of input.items) {
    quantity(line.shippedQty)
    if (!line.purchaseOrderItemId) continue
    const orderItem = orderItemById.get(line.purchaseOrderItemId)
    if (!orderItem || orderItem.productId !== line.productId) {
      throw businessError('发货草稿包含不属于当前订单的商品明细', 400)
    }
  }

  const drafts = await tx.deliveryOrder.findMany({
    where: { tenantId: input.tenantId, purchaseOrderId: order.id, status: 'DRAFT' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { items: { include: { product: true } } },
  })
  if (drafts.length > 1) throw businessError('发现多张发货草稿，请先整理数据后重试', 409)
  let draft = drafts[0] || null
  if (draft) {
    if (input.draftRowVersion == null || draft.rowVersion !== input.draftRowVersion) {
      throw businessError('发货草稿已更新，请刷新后重试', 409)
    }
  } else if (input.draftRowVersion != null) {
    throw businessError('发货草稿已变化，请刷新后重试', 409)
  }

  // GET 订单详情不返回 removedAt 行。因此首次保存必须显式携带
  // 每条原订货行，但后续保存允许省略已在 DRAFT 中软移除的行。
  // 如果用户从商品选择器恢复它，也可以只用 productId 匹配 tombstone。
  for (const orderItem of order.items) {
    if (submittedOrderIds.has(orderItem.id)) continue
    const tombstone = draft?.items.find(item =>
      item.purchaseOrderItemId === orderItem.id && item.removedAt)
    if (!tombstone) {
      throw businessError(`发货草稿缺少订货商品 ${orderItem.product?.name || orderItem.productId}`, 400)
    }
  }

  const existingDraftProductIds = new Set((draft?.items || []).map(item => item.productId))
  // A product already frozen into this draft remains editable/removable even
  // if the live catalog is disabled later. Only genuinely new additions must
  // still be ENABLED at save time.
  const addedProductIds = input.items
    .filter(item => !item.purchaseOrderItemId && !existingDraftProductIds.has(item.productId))
    .map(item => item.productId)
  const addedProducts = addedProductIds.length > 0
    ? await tx.product.findMany({
        where: {
          id: { in: addedProductIds },
          tenantId: input.tenantId,
          supplierId: order.supplierId,
          status: 'ENABLED',
        },
      })
    : []
  if (addedProducts.length !== addedProductIds.length) {
    throw businessError('新增商品不存在、已停用或不属于当前供应商', 404)
  }
  const addedProductById = new Map(addedProducts.map(product => [product.id, product]))

  if (!draft) {
    draft = await tx.deliveryOrder.create({
      data: {
        tenantId: input.tenantId,
        // DRAFT 是内部状态，不占用正式 DO 业务号。确认发货时再分配 DO。
        no: `DR-${order.id}`,
        purchaseOrderId: order.id,
        storeId: order.storeId,
        supplierId: order.supplierId,
        status: 'DRAFT',
        actualTotalAmount: new Prisma.Decimal(0),
        idempotencyKey: SERVER_SHIPMENT_DRAFT_KEY,
        createdById: input.userId,
      },
      include: { items: { include: { product: true } } },
    })
    await tx.deliveryOrderEvent.create({
      data: {
        tenantId: input.tenantId,
        deliveryOrderId: draft.id,
        eventType: 'CREATED',
        actorId: input.userId,
        actorRole: input.userRole,
        toStatus: 'DRAFT',
        requestId: input.requestId || null,
        ip: input.ip || null,
        metadata: { source: 'SERVER_SHIPMENT_DRAFT' },
      },
    })
  }

  const existingByProduct = new Map(draft.items.map(item => [item.productId, item]))
  const desiredProducts = new Set(input.items.map(item => item.productId))
  const omittedActive = draft.items.find(item => !item.removedAt && !desiredProducts.has(item.productId))
  if (omittedActive) throw businessError('发货草稿明细不完整，请刷新后重试', 409)

  const now = new Date()
  const desiredAmounts: Prisma.Decimal[] = []
  for (const line of input.items) {
    const shippedQty = quantity(line.shippedQty)
    const removed = line.removed === true
    const existing = existingByProduct.get(line.productId)
    const linkedOrderItemId = line.purchaseOrderItemId || existing?.purchaseOrderItemId || null
    const orderItem = linkedOrderItemId ? orderItemById.get(linkedOrderItemId) || null : null
    const product = orderItem?.product || addedProductById.get(line.productId) || existing?.product
    if (!product) throw businessError('发货草稿商品不存在', 404)

    const priced = orderItem
      ? {
          unitPrice: new Prisma.Decimal(orderItem.unitPrice).toDecimalPlaces(2),
          amount: shippedQty.mul(orderItem.unitPrice).toDecimalPlaces(2),
        }
      : existing
        ? {
            unitPrice: new Prisma.Decimal(existing.unitPriceSnapshot).toDecimalPlaces(2),
            amount: shippedQty.mul(existing.unitPriceSnapshot).toDecimalPlaces(2),
          }
        : (() => {
            // 草稿新增行允许数量 0；只换算服务端单价，不把 0 视为移除。
            const unitPrice = costUnitPriceToOrderUnitPrice(product)
            return { unitPrice, amount: shippedQty.mul(unitPrice).toDecimalPlaces(2) }
          })()
    if (priced.amount.gt(PURCHASE_ORDER_AMOUNT_MAX)) throw businessError('单行金额超过系统上限', 400)
    const effectiveAmount = removed ? new Prisma.Decimal(0) : priced.amount
    desiredAmounts.push(effectiveAmount)

    if (existing) {
      if (orderItem && existing.purchaseOrderItemId && existing.purchaseOrderItemId !== orderItem.id) {
        throw businessError('发货草稿商品与订货明细关联不一致', 409)
      }
      await tx.deliveryOrderItem.update({
        where: { id: existing.id },
        data: {
          purchaseOrderItemId: existing.purchaseOrderItemId || orderItem?.id || null,
          orderedQtySnapshot: orderItem ? orderItem.quantity : shippedQty,
          shippedQty: removed ? new Prisma.Decimal(0) : shippedQty,
          amount: effectiveAmount,
          removedAt: removed ? existing.removedAt || now : null,
        },
      })
      continue
    }

    const frozen = orderItem
      ? copyFrozenSupplyDocumentFourUnits(orderItem)
      : freezeProductFourUnitsForSupplyDocument(product)
    await tx.deliveryOrderItem.create({
      data: {
        deliveryOrderId: draft.id,
        purchaseOrderItemId: orderItem?.id || null,
        productId: line.productId,
        orderedQtySnapshot: orderItem ? orderItem.quantity : shippedQty,
        shippedQty: removed ? new Prisma.Decimal(0) : shippedQty,
        unitPriceSnapshot: priced.unitPrice,
        amount: effectiveAmount,
        productCodeSnapshot: product.code || null,
        productNameSnapshot: product.name || null,
        productSpecSnapshot: product.spec || null,
        productUnitSnapshot: orderItem?.orderUnitSnapshot || product.orderUnit || product.unit || null,
        productCategorySnapshot: product.category || null,
        removedAt: removed ? now : null,
        ...frozen,
      },
    })
  }

  const actualTotalAmount = sum(desiredAmounts)
  if (actualTotalAmount.gt(PURCHASE_ORDER_AMOUNT_MAX)) throw businessError('配送单总金额超过系统上限', 400)
  const expectedVersion = draft.rowVersion
  const updated = await tx.deliveryOrder.updateMany({
    where: { id: draft.id, status: 'DRAFT', rowVersion: expectedVersion },
    data: { actualTotalAmount, rowVersion: { increment: 1 } },
  })
  if (updated.count !== 1) throw businessError('发货草稿已被其他人修改，请刷新后重试', 409)

  await tx.deliveryOrderEvent.create({
    data: {
      tenantId: input.tenantId,
      deliveryOrderId: draft.id,
      eventType: 'UPDATED',
      actorId: input.userId,
      actorRole: input.userRole,
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      requestId: input.requestId || null,
      ip: input.ip || null,
      metadata: {
        action: 'SAVE_SHIPMENT_DRAFT',
        rowVersion: expectedVersion + 1,
        itemCount: input.items.length,
        removedProductIds: input.items.filter(item => item.removed).map(item => item.productId),
      },
    },
  })
  await tx.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: '保存待发货商品明细',
      target: draft.no,
      entityType: 'DeliveryOrder',
      targetId: draft.id,
      metadata: { purchaseOrderId: order.id, rowVersion: expectedVersion + 1 },
    },
  })

  const saved = await tx.deliveryOrder.findUniqueOrThrow({
    where: { id: draft.id },
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })
  return {
    success: true,
    deliveryId: saved.id,
    deliveryNo: saved.no,
    rowVersion: saved.rowVersion,
    actualTotalAmount: saved.actualTotalAmount.toFixed(2),
    items: saved.items.map(item => ({
      id: item.id,
      purchaseOrderItemId: item.purchaseOrderItemId,
      productId: item.productId,
      shippedQty: item.shippedQty.toFixed(2),
      removedAt: item.removedAt,
    })),
  }
}

/** Cancel any unshipped document intent together with its CONFIRMED order. */
export async function cancelShipmentDraftsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string
    purchaseOrderId: string
    userId: string
    userRole: string
    requestId?: string | null
    ip?: string | null
    reason: string
  },
) {
  const drafts = await tx.deliveryOrder.findMany({
    where: { tenantId: input.tenantId, purchaseOrderId: input.purchaseOrderId, status: 'DRAFT' },
    select: { id: true, rowVersion: true },
  })
  for (const draft of drafts) {
    const updated = await tx.deliveryOrder.updateMany({
      where: { id: draft.id, status: 'DRAFT', rowVersion: draft.rowVersion },
      data: { status: 'CANCELLED', rowVersion: { increment: 1 } },
    })
    if (updated.count !== 1) throw businessError('发货草稿已更新，请刷新后重试', 409)
    await tx.deliveryOrderEvent.create({
      data: {
        tenantId: input.tenantId,
        deliveryOrderId: draft.id,
        eventType: 'CANCELLED',
        actorId: input.userId,
        actorRole: input.userRole,
        fromStatus: 'DRAFT',
        toStatus: 'CANCELLED',
        requestId: input.requestId || null,
        ip: input.ip || null,
        metadata: { source: 'PURCHASE_ORDER_CANCELLED', reason: input.reason.slice(0, 200) },
      },
    })
  }
  return drafts.length
}
