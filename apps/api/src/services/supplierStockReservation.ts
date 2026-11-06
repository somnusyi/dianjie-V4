import { Prisma, prisma } from '@dianjie/db'
import { consumeSupplierStockBatches } from './supplierStockBatch'
import { reservationCloseState } from './partialShipmentClose'
import { type FrozenOrderInventoryLine } from './warehouseLedger'

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

type ShipmentReservationLine = ReservationLine & Partial<SupplierFrozenStockLine> & {
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


export type SupplierFrozenStockLine = FrozenOrderInventoryLine & {
  purchaseUnitSnapshot?: string | null; costUnitSnapshot?: string | null
  inventoryUnitsPerPurchaseUnitSnapshot?: number | string | Prisma.Decimal | null
  inventoryUnitsPerCostUnitSnapshot?: number | string | Prisma.Decimal | null
}
export function supplierStockUnitsPerOrderUnit(line: SupplierFrozenStockLine, stockUnit: string) {
  const orderUnit = String(line.orderUnitSnapshot || line.productUnit || '').trim()
  if (!stockUnit || !orderUnit) throw businessError('缺少供应商库存账单位或冻结订货单位', 409)
  if (orderUnit === stockUnit) return new Prisma.Decimal(1)
  const orderToInventory = new Prisma.Decimal(line.inventoryUnitsPerOrderUnitSnapshot || 0)
  let stockToInventory: Prisma.Decimal | undefined
  if (stockUnit === line.inventoryUnitSnapshot) stockToInventory = new Prisma.Decimal(1)
  else if (stockUnit === line.purchaseUnitSnapshot) stockToInventory = new Prisma.Decimal(line.inventoryUnitsPerPurchaseUnitSnapshot || 0)
  else if (stockUnit === line.costUnitSnapshot) stockToInventory = new Prisma.Decimal(line.inventoryUnitsPerCostUnitSnapshot || 0)
  if (!orderToInventory.isFinite() || orderToInventory.lte(0) || !stockToInventory?.isFinite() || stockToInventory.lte(0)) throw businessError('订货单位无法可靠换算到供应商库存账单位，请先核对商品单位', 409)
  const result = orderToInventory.div(stockToInventory)
  if (!result.equals(result.toDecimalPlaces(6))) throw businessError('供应商库存单位换算精度不足，请先核对商品单位', 409)
  return result
}
export function supplierStockQuantity(line: SupplierFrozenStockLine, stockUnit: string, quantity: number | string | Prisma.Decimal) {
  const result = new Prisma.Decimal(quantity).mul(supplierStockUnitsPerOrderUnit(line, stockUnit))
  if (!result.isFinite() || !result.equals(result.toDecimalPlaces(3))) throw businessError('换算后超出供应商库存账精度，请调整数量或库存单位', 400)
  return result
}
async function assertSupplierLedgerBasisForProducts(tx: Prisma.TransactionClient, scope: ReservationScope, lines: SupplierFrozenStockLine[]) {
  const expected = new Map(lines.map(line => [line.productId, String(line.productUnit || '').trim()]))
  const products = await tx.product.findMany({ where: { tenantId: scope.tenantId, supplierId: scope.supplierId, id: { in: [...expected.keys()] } }, select: { id: true, unit: true } })
  if (products.length !== expected.size || products.some(product => expected.get(product.id) !== product.unit)) throw businessError('供应商库存账单位与商品单位不一致，请先核对单位迁移', 409)
  const active = await tx.supplierStockReservation.findMany({ where: { tenantId: scope.tenantId, supplierId: scope.supplierId, productId: { in: [...expected.keys()] }, status: 'ACTIVE' }, include: { purchaseOrderItem: { select: { orderUnitSnapshot: true } } } })
  for (const row of active) {
    const stockUnit = expected.get(row.productId)!
    const recorded = row as typeof row & { stockUnitSnapshot?: string | null }
    if (recorded.stockUnitSnapshot ? recorded.stockUnitSnapshot !== stockUnit : Boolean(row.purchaseOrderItem.orderUnitSnapshot && row.purchaseOrderItem.orderUnitSnapshot !== stockUnit)) throw businessError('其他订单预占使用不同或无法核实的库存账单位，请先核对历史单位', 409)
  }
}

export async function syncSubmissionSupplierReservation(
  tx: Prisma.TransactionClient,
  input: ReservationScope & { lines: SupplierFrozenStockLine[] },
) {
  const current = await tx.supplierStockReservation.findMany({ where: { tenantId: input.tenantId, supplierId: input.supplierId, purchaseOrderId: input.purchaseOrderId }, include: { purchaseOrderItem: { select: { productId: true, orderUnitSnapshot: true, inventoryUnitSnapshot: true, inventoryUnitsPerOrderUnitSnapshot: true } } } })
  if (current.some(row => row.status === 'CONSUMED')) throw businessError('已发货订单不能重新预占库存')
  const byItem = new Map(current.map(row => [row.purchaseOrderItemId, row]))
  const lines = input.lines.map(line => {
    const prior = byItem.get(line.purchaseOrderItemId) as (typeof current[number] & { stockUnitSnapshot?: string | null; stockUnitsPerOrderUnitSnapshot?: Prisma.Decimal | null }) | undefined
    const stockUnit = String(line.productUnit || '').trim()
    if (prior) {
      const frozen = prior.purchaseOrderItem
      if (prior.productId !== line.productId || frozen.productId !== line.productId || frozen.inventoryUnitSnapshot !== line.inventoryUnitSnapshot || frozen.orderUnitSnapshot !== line.orderUnitSnapshot || !new Prisma.Decimal(frozen.inventoryUnitsPerOrderUnitSnapshot || 1).equals(line.inventoryUnitsPerOrderUnitSnapshot || 1)) throw businessError('同一订货行不能更换商品或冻结库存单位，请移除原行后新增商品', 409)
      if (prior.stockUnitSnapshot && prior.stockUnitSnapshot !== stockUnit) throw businessError('商品库存账单位已改变，不能混用旧预占；请先核对单位迁移', 409)
      if (!prior.stockUnitSnapshot && String(line.orderUnitSnapshot || stockUnit) !== stockUnit) throw businessError('历史预占缺少可靠库存账单位快照，请先核对历史单位', 409)
    }
    const factor = supplierStockUnitsPerOrderUnit(line, stockUnit)
    if (prior?.stockUnitsPerOrderUnitSnapshot && !prior.stockUnitsPerOrderUnitSnapshot.equals(factor)) throw businessError('同一订货行的供应商库存账换算已改变，请先核对单位迁移', 409)
    return { ...line, stockUnit, factor, quantity: supplierStockQuantity(line, stockUnit, line.quantity) }
  })
  const ids = [...new Set([...lines.map(line => line.productId), ...current.filter(row => row.status === 'ACTIVE').map(row => row.productId)])]
  const physical = await lockPhysicalStock(tx, input.tenantId, input.supplierId, ids)
  await assertSupplierLedgerBasisForProducts(tx, input, input.lines)
  const others = await activeReservedByProduct(tx, { ...input, productIds: ids, excludeOrderId: input.purchaseOrderId })
  const requested = aggregateByProduct(lines, line => line.quantity)
  for (const [id, qty] of requested) if (physical.get(id)!.minus(others.get(id) || 0).lt(qty)) throw businessError(`${lines.find(line => line.productId === id)?.productName || '商品'} 可用库存不足，无法提交或修改订单`)
  const desired = new Map(lines.map(line => [line.purchaseOrderItemId, line]))
  for (const row of current) {
    const line = desired.get(row.purchaseOrderItemId)
    if (line) {
      await tx.supplierStockReservation.update({ where: { id: row.id }, data: { quantity: line.quantity, status: 'ACTIVE', fulfilledQty: 0, releasedAt: null, consumedAt: null, stockUnitSnapshot: line.stockUnit, stockUnitsPerOrderUnitSnapshot: line.factor } as Prisma.SupplierStockReservationUncheckedUpdateInput })
      desired.delete(row.purchaseOrderItemId)
    } else if (row.status === 'ACTIVE') await tx.supplierStockReservation.update({ where: { id: row.id }, data: { status: 'RELEASED', releasedAt: new Date() } })
  }
  for (const line of desired.values()) await tx.supplierStockReservation.create({ data: { tenantId: input.tenantId, supplierId: input.supplierId, purchaseOrderId: input.purchaseOrderId, purchaseOrderItemId: line.purchaseOrderItemId, productId: line.productId, quantity: line.quantity, stockUnitSnapshot: line.stockUnit, stockUnitsPerOrderUnitSnapshot: line.factor } as Prisma.SupplierStockReservationUncheckedCreateInput })
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
    useFrozenInventoryUnits?: boolean
    lines: ShipmentReservationLine[]
  },
) {
  if (input.useFrozenInventoryUnits) {
    const existing = await tx.supplierStockReservation.findMany({ where: { tenantId: input.tenantId, supplierId: input.supplierId, purchaseOrderId: input.purchaseOrderId } })
    input = { ...input, lines: input.lines.map(line => {
      const prior = existing.find(row => row.purchaseOrderItemId === line.purchaseOrderItemId) as (typeof existing[number] & { stockUnitSnapshot?: string | null; stockUnitsPerOrderUnitSnapshot?: Prisma.Decimal | null }) | undefined
      const stockUnit = String(line.productUnit || '').trim()
      const factor = supplierStockUnitsPerOrderUnit(line, stockUnit)
      if (prior?.stockUnitSnapshot && prior.stockUnitSnapshot !== stockUnit) throw businessError('商品库存账单位已改变，不能混用旧预占', 409)
      if (prior?.stockUnitsPerOrderUnitSnapshot && !prior.stockUnitsPerOrderUnitSnapshot.equals(factor)) throw businessError('供应商库存账冻结换算不一致', 409)
      if (prior && !prior.stockUnitSnapshot && String(line.orderUnitSnapshot || stockUnit) !== stockUnit) throw businessError('历史预占缺少可靠库存账单位快照', 409)
      return { ...line, quantity: supplierStockQuantity(line, stockUnit, line.quantity), shippedQty: supplierStockQuantity(line, stockUnit, line.shippedQty) }
    }) }
  }
  const productIds = [...new Set(input.lines.map(line => line.productId))]
  const physical = await lockPhysicalStock(tx, input.tenantId, input.supplierId, productIds)
  if (input.useFrozenInventoryUnits) await assertSupplierLedgerBasisForProducts(tx, input, input.lines)
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
            ...(input.useFrozenInventoryUnits ? { stockUnitSnapshot: String(line.productUnit), stockUnitsPerOrderUnitSnapshot: supplierStockUnitsPerOrderUnit(line, String(line.productUnit)) } : {}),
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
