import { Prisma, prisma } from '@dianjie/db'
import { consumeSupplierStockBatches } from './supplierStockBatch'
import { reservationCloseState } from './partialShipmentClose'

type ReservationLine = {
  purchaseOrderItemId: string
  productId: string
  quantity: number | Prisma.Decimal
  productName?: string | null
}

type ReservationScope = {
  tenantId: string
  supplierId: string
  purchaseOrderId: string
}

type ShipmentReservationLine = ReservationLine & {
  shippedQty: number | Prisma.Decimal
}

function businessError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode })
}

function aggregateByProduct<T extends { productId: string }>(
  lines: T[],
  value: (line: T) => Prisma.Decimal,
) {
  const result = new Map<string, Prisma.Decimal>()
  for (const line of lines) {
    result.set(line.productId, (result.get(line.productId) || new Prisma.Decimal(0)).plus(value(line)))
  }
  return result
}

async function lockPhysicalStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  supplierId: string,
  productIds: string[],
) {
  const ids = [...new Set(productIds)].sort()
  if (ids.length === 0) return new Map<string, Prisma.Decimal>()

  const rows = await tx.$queryRaw<Array<{ id: string; stock: Prisma.Decimal }>>(Prisma.sql`
    SELECT "id", "stock"
    FROM "products"
    WHERE "tenantId" = ${tenantId}
      AND "supplierId" = ${supplierId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `)
  if (rows.length !== ids.length) {
    throw businessError('订单包含不属于当前供应商的商品，无法操作库存', 400)
  }
  return new Map(rows.map(row => [row.id, row.stock]))
}

async function activeReservedByProduct(
  tx: Prisma.TransactionClient,
  scope: { tenantId: string; supplierId: string; productIds: string[]; excludeOrderId?: string },
) {
  const rows = await tx.supplierStockReservation.groupBy({
    by: ['productId'],
    where: {
      tenantId: scope.tenantId,
      supplierId: scope.supplierId,
      productId: { in: scope.productIds },
      status: 'ACTIVE',
      ...(scope.excludeOrderId ? { purchaseOrderId: { not: scope.excludeOrderId } } : {}),
    },
    _sum: { quantity: true },
  })
  return new Map(rows.map(row => [row.productId, row._sum.quantity || new Prisma.Decimal(0)]))
}

/** 接单时原子预占。调用方必须与订单 SUBMITTED -> CONFIRMED CAS 放在同一事务。 */
export async function reserveSupplierStockForOrder(
  tx: Prisma.TransactionClient,
  input: ReservationScope & { lines: ReservationLine[] },
) {
  const productIds = [...new Set(input.lines.map(line => line.productId))]
  const physical = await lockPhysicalStock(tx, input.tenantId, input.supplierId, productIds)
  const reserved = await activeReservedByProduct(tx, {
    tenantId: input.tenantId,
    supplierId: input.supplierId,
    productIds,
  })
  const requested = aggregateByProduct(input.lines, line => new Prisma.Decimal(line.quantity))

  for (const productId of productIds) {
    const available = physical.get(productId)!.minus(reserved.get(productId) || 0)
    const needed = requested.get(productId) || new Prisma.Decimal(0)
    if (available.lessThan(needed)) {
      const line = input.lines.find(item => item.productId === productId)
      throw businessError(
        `${line?.productName || '商品'} 可用库存不足：可用 ${available.toFixed(2)}，本单需要 ${needed.toFixed(2)}`,
      )
    }
  }

  await tx.supplierStockReservation.createMany({
    data: input.lines.map(line => ({
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId: line.productId,
      purchaseOrderId: input.purchaseOrderId,
      purchaseOrderItemId: line.purchaseOrderItemId,
      quantity: new Prisma.Decimal(line.quantity),
    })),
  })
}

/** 已接订单在发货前被撤回或拒绝时释放预占。 */
export async function releaseSupplierStockForOrder(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string,
  at = new Date(),
) {
  return tx.supplierStockReservation.updateMany({
    where: { purchaseOrderId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: at },
  })
}

/**
 * 首次发货时按实发量核销本单预占并扣减物理库存，同时释放所有未发余量。
 * 当前订单可以使用自己的预占和未预占余量，但绝不能挤占其他已确认订单。
 */
export async function consumeSupplierStockForShipment(
  tx: Prisma.TransactionClient,
  input: ReservationScope & {
    deliveryOrderId: string
    orderNo: string
    userId: string
    closedAt?: Date
    lines: ShipmentReservationLine[]
  },
) {
  const productIds = [...new Set(input.lines.map(line => line.productId))]
  const physical = await lockPhysicalStock(tx, input.tenantId, input.supplierId, productIds)
  const reservedByOthers = await activeReservedByProduct(tx, {
    tenantId: input.tenantId,
    supplierId: input.supplierId,
    productIds,
    excludeOrderId: input.purchaseOrderId,
  })
  const shippedByProduct = aggregateByProduct(input.lines, line => new Prisma.Decimal(line.shippedQty))

  for (const productId of productIds) {
    const protectedAvailable = physical.get(productId)!.minus(reservedByOthers.get(productId) || 0)
    const shipped = shippedByProduct.get(productId) || new Prisma.Decimal(0)
    if (protectedAvailable.lessThan(shipped)) {
      const line = input.lines.find(item => item.productId === productId)
      throw businessError(
        `${line?.productName || '商品'} 可发库存不足：扣除其他订单预占后可发 ${protectedAvailable.toFixed(2)}，本次实发 ${shipped.toFixed(2)}`,
      )
    }
  }

  for (const [productId, shipped] of shippedByProduct) {
    if (shipped.lessThanOrEqualTo(0)) continue
    const updated = await tx.product.update({
      where: { id: productId },
      data: { stock: { decrement: shipped } },
      select: { stock: true },
    })
    const movement = await tx.supplierStockMovement.create({
      data: {
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        productId,
        delta: shipped.negated(),
        balanceAfter: updated.stock,
        type: 'OUTBOUND_PO',
        reason: `发货 ${input.orderNo}`,
        sourceType: 'DeliveryOrder',
        sourceId: input.deliveryOrderId,
        createdById: input.userId,
      },
    })
    await consumeSupplierStockBatches(tx, {
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      productId,
      quantity: shipped,
      movementId: movement.id,
    })
  }

  const closedAt = input.closedAt || new Date()
  for (const line of input.lines) {
    const closure = reservationCloseState(line.quantity, line.shippedQty)
    const updated = await tx.supplierStockReservation.updateMany({
      where: { purchaseOrderItemId: line.purchaseOrderItemId, purchaseOrderId: input.purchaseOrderId, status: 'ACTIVE' },
      data: {
        status: closure.status,
        fulfilledQty: closure.fulfilledQty,
        consumedAt: closure.markConsumedAt ? closedAt : null,
        // A partial line records both the consumed quantity and the instant its
        // unshipped reservation was released. A zero-shipped line is RELEASED.
        releasedAt: closure.markReleasedAt ? closedAt : null,
      },
    })
    // A product first added in the shipment draft has no reservation from the
    // earlier accept-order step. Persist the already-consumed audit fact after
    // its outbound succeeds so later quantity/remove/restore operations have
    // the same invariant as original order lines. A zero line deliberately
    // remains reservation-free until its first positive outbound.
    if (updated.count === 0 && new Prisma.Decimal(line.shippedQty).gt(0)) {
      const existing = await tx.supplierStockReservation.findUnique({
        where: { purchaseOrderItemId: line.purchaseOrderItemId },
      })
      if (!existing) {
        const shipped = new Prisma.Decimal(line.shippedQty).toDecimalPlaces(3)
        await tx.supplierStockReservation.create({
          data: {
            tenantId: input.tenantId,
            supplierId: input.supplierId,
            productId: line.productId,
            purchaseOrderId: input.purchaseOrderId,
            purchaseOrderItemId: line.purchaseOrderItemId,
            quantity: shipped,
            fulfilledQty: shipped,
            status: 'CONSUMED',
            consumedAt: closedAt,
          },
        })
      }
    }
  }
}

export async function getSupplierReservedStock(input: {
  tenantId: string
  supplierId?: string
  productIds?: string[]
}) {
  const rows = await prisma.supplierStockReservation.groupBy({
    by: ['productId'],
    where: {
      tenantId: input.tenantId,
      ...(input.supplierId ? { supplierId: input.supplierId } : {}),
      status: 'ACTIVE',
      ...(input.productIds ? { productId: { in: input.productIds } } : {}),
    },
    _sum: { quantity: true },
  })
  return new Map(rows.map(row => [row.productId, Number(row._sum.quantity || 0)]))
}

export function stockAvailability(physicalStock: number, reservedStock: number) {
  return {
    physicalStock,
    reservedStock,
    availableStock: Math.max(0, physicalStock - reservedStock),
  }
}
