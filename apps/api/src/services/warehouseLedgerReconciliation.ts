import { prisma } from '@dianjie/db'
import {
  getWarehouseLedgerMode,
  postWarehouseReleaseForOrder,
  postWarehouseReservationForOrder,
  postWarehouseShipment,
  type FrozenOrderInventoryLine,
} from './warehouseLedger'

function lines(order: any, shipped = false): FrozenOrderInventoryLine[] {
  return order.items.map((item: any) => ({
    purchaseOrderItemId: item.id,
    productId: item.productId,
    quantity: item.quantity,
    ...(shipped ? { shippedQty: item.shippedQty ?? item.quantity } : {}),
    productName: item.product?.name,
    productUnit: item.product?.unit,
    orderUnitSnapshot: item.orderUnitSnapshot,
    inventoryUnitSnapshot: item.inventoryUnitSnapshot,
    inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot,
  }))
}

/**
 * Replay the durable purchase-order/delivery facts into the SHADOW ledger.
 * This is deliberately idempotent and derives the desired action from the
 * order's current state, so it repairs missed or out-of-order background work.
 */
export async function reconcileWarehouseShadowLedger(input: {
  tenantId: string
  userId: string
  limit?: number
  cursor?: string | null
}) {
  const mode = await getWarehouseLedgerMode(input.tenantId)
  if (mode.inventoryMode !== 'SHADOW') {
    throw Object.assign(new Error('只有显式启用 SHADOW 的总仓可以执行影子补记'), { statusCode: 409 })
  }
  const limit = Math.min(Math.max(input.limit || 200, 1), 500)
  const loadedOrders = await prisma.purchaseOrder.findMany({
    where: {
      tenantId: input.tenantId,
      supplier: { sourceType: 'HEADQ_WAREHOUSE' },
      status: { in: ['CONFIRMED', 'DELIVERING', 'PENDING_CONFIRM', 'RECEIVED', 'COMPLETED', 'CANCELLED'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: {
      items: {
        where: { isActive: true },
        include: { product: { select: { name: true, unit: true } } },
      },
      deliveries: {
        where: { status: { in: ['SHIPPED', 'DELIVERED', 'RECEIVED'] } },
        orderBy: [{ shippedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { id: true, shippedAt: true },
      },
    },
  })
  const hasMore = loadedOrders.length > limit
  const orders = hasMore ? loadedOrders.slice(0, limit) : loadedOrders
  const nextCursor = hasMore && orders.length ? orders[orders.length - 1].id : null

  const failures: Array<{ purchaseOrderId: string; orderNo: string; error: string }> = []
  let reserved = 0
  let released = 0
  let shipped = 0
  for (const order of orders) {
    try {
      if (order.status === 'CONFIRMED') {
        await postWarehouseReservationForOrder({
          tenantId: input.tenantId,
          purchaseOrderId: order.id,
          userId: input.userId,
          lines: lines(order),
        })
        reserved += 1
      } else if (order.status === 'CANCELLED') {
        await postWarehouseReleaseForOrder({
          tenantId: input.tenantId,
          purchaseOrderId: order.id,
          userId: input.userId,
        })
        released += 1
      } else {
        const delivery = order.deliveries[0]
        if (!delivery) throw new Error('已发货订单缺少有效配送单')
        await postWarehouseShipment({
          tenantId: input.tenantId,
          purchaseOrderId: order.id,
          deliveryOrderId: delivery.id,
          orderNo: order.no,
          userId: input.userId,
          effectiveAt: order.shippedAt || delivery.shippedAt || new Date(),
          lines: lines(order, true),
        })
        shipped += 1
      }
    } catch (error: any) {
      failures.push({
        purchaseOrderId: order.id,
        orderNo: order.no,
        error: String(error?.message || error).slice(0, 500),
      })
    }
  }
  await prisma.opLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      action: `总仓影子账补记：扫描 ${orders.length} 单，失败 ${failures.length} 单`,
      entityType: 'WarehouseLedgerShadowReconcile',
      metadata: { scanned: orders.length, reserved, released, shipped, failures },
    },
  })
  return { scanned: orders.length, reserved, released, shipped, failures, nextCursor }
}
