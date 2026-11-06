import { Prisma } from '@dianjie/db'
import { resolveTenantWarehouseId } from './defaultWarehouse'
import { FrozenOrderInventoryLine, resolveFrozenOrderInventoryLine, lockWarehouseReservationBalances, persistWarehouseReservationBalance } from './warehouseLedger'

export const REPLENISHMENT_SUBMISSION_POLICY = 'SUBMISSION_V1'
const ZERO = new Prisma.Decimal(0)
function conflict(message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode: 409 }) }
type Scope = { tenantId: string; replenishmentOrderId: string; userId: string }
function sameFrozenLine(hold: { productId: string; originalUnit: string; inventoryUnit: string; originalQuantity: Prisma.Decimal; conversionFactor: Prisma.Decimal; inventoryQuantity: Prisma.Decimal }, line: ReturnType<typeof resolveFrozenOrderInventoryLine>) {
  return hold.productId === line.productId && hold.originalUnit === line.originalUnit && hold.inventoryUnit === line.inventoryUnit
    && hold.originalQuantity.equals(line.originalQuantity) && hold.conversionFactor.equals(line.conversionFactor) && hold.inventoryQuantity.equals(line.inventoryQuantity)
}
function assertFrozenHolds(holds: Array<{ replenishmentOrderItemId: string; productId: string; originalUnit: string; inventoryUnit: string; originalQuantity: Prisma.Decimal; conversionFactor: Prisma.Decimal; inventoryQuantity: Prisma.Decimal }>, items: Array<Omit<FrozenOrderInventoryLine, 'purchaseOrderItemId'> & { id: string }>) {
  if (!items.length || holds.length !== items.length) throw conflict('补货提交预占记录不完整，请先核对库存流水')
  const lines = new Map(items.map(item => [item.id, resolveFrozenOrderInventoryLine({ ...item, purchaseOrderItemId: item.id })]))
  if (new Set(holds.map(h => h.replenishmentOrderItemId)).size !== holds.length) throw conflict('补货预占行重复')
  for (const hold of holds) {
    const line = lines.get(hold.replenishmentOrderItemId)
    if (!line || !sameFrozenLine(hold, line)) throw conflict('补货原单与冻结预占不一致，请核对单位和数量')
  }
}


/** The caller owns the document CAS and Serializable transaction. No standalone commit. */
export async function reserveReplenishmentStock(tx: Prisma.TransactionClient, input: Scope & { lines: FrozenOrderInventoryLine[] }) {
  const order = await tx.replenishmentOrder.findFirst({ where: { id: input.replenishmentOrderId, tenantId: input.tenantId }, include: { supplier: true, items: true } })
  if (!order || order.status !== 'SUBMITTED' || order.stockReservationPolicy !== REPLENISHMENT_SUBMISSION_POLICY || order.supplier.sourceType !== 'HEADQ_WAREHOUSE' || order.supplier.status !== 'ENABLED') throw conflict('补货预占只能用于已提交的内部总仓补货单')
  const lines = input.lines.map(resolveFrozenOrderInventoryLine)
  if (!lines.length || lines.some(l => l.inventoryQuantity.lte(0)) || new Set(lines.map(l => l.productId)).size !== lines.length) throw conflict('补货预占明细无效')
  assertFrozenHolds(lines.map(l => ({ ...l, replenishmentOrderItemId: l.purchaseOrderItemId })), order.items)
  const existing = await tx.replenishmentStockHold.findMany({ where: { tenantId: input.tenantId, replenishmentOrderId: input.replenishmentOrderId } })
  // Submit request replay is resolved by the immutable document event, never by silently recreating holds.
  if (existing.length) throw conflict('补货单已经存在预占记录，请刷新核对')
  const warehouseId = await resolveTenantWarehouseId(tx, input.tenantId, undefined)
  const balances = await lockWarehouseReservationBalances(tx, { tenantId: input.tenantId, warehouseId, products: lines.map(l => ({ productId: l.productId, inventoryUnit: l.inventoryUnit })) })
  for (const line of lines) {
    const balance = balances.get(line.productId)!
    if (balance.physicalQty.minus(balance.reservedQty).lt(line.inventoryQuantity)) throw conflict(`${line.productName || '商品'} 总仓可用库存不足，请核对入库或库存基线`)
  }
  for (const line of lines) {
    const balance = balances.get(line.productId)!
    const reservedAfter = balance.reservedQty.plus(line.inventoryQuantity)
    await tx.replenishmentStockHold.create({ data: {
      tenantId: input.tenantId, warehouseId, productId: line.productId,
      replenishmentOrderId: input.replenishmentOrderId, replenishmentOrderItemId: line.purchaseOrderItemId,
      originalQuantity: line.originalQuantity, originalUnit: line.originalUnit, conversionFactor: line.conversionFactor,
      inventoryQuantity: line.inventoryQuantity, inventoryUnit: line.inventoryUnit,
    } })
    await tx.warehouseLedgerMovement.create({ data: {
      tenantId: input.tenantId, warehouseId, productId: line.productId, type: 'ORDER_RESERVED',
      physicalDelta: ZERO, reservedDelta: line.inventoryQuantity, valueDelta: ZERO,
      physicalAfter: balance.physicalQty, reservedAfter, valueAfter: balance.inventoryValue, averageUnitCostAfter: balance.averageUnitCost,
      originalQuantity: line.originalQuantity, originalUnit: line.originalUnit, conversionFactor: line.conversionFactor,
      inventoryQuantity: line.inventoryQuantity, inventoryUnit: line.inventoryUnit, inventoryUnitCost: balance.averageUnitCost,
      sourceType: 'ReplenishmentOrder', sourceId: input.replenishmentOrderId, sourceLineId: line.purchaseOrderItemId,
      idempotencyKey: `replenishment-reserve:${input.replenishmentOrderId}:${line.purchaseOrderItemId}`,
      createdById: input.userId, effectiveAt: new Date(),
    } })
    await persistWarehouseReservationBalance(tx, balance, { physicalQty: balance.physicalQty, reservedQty: reservedAfter, inventoryValue: balance.inventoryValue, averageUnitCost: balance.averageUnitCost })
  }
}

/** Called only after winning cancellation CAS. Legacy requests have no holds. */
export async function releaseReplenishmentStock(tx: Prisma.TransactionClient, input: Scope) {
  const order = await tx.replenishmentOrder.findFirst({ where: { id: input.replenishmentOrderId, tenantId: input.tenantId }, include: { items: true } })
  if (!order || order.status !== 'CANCELLED') throw conflict('必须先取消补货单才能释放预占')
  const holds = await tx.replenishmentStockHold.findMany({ where: { tenantId: input.tenantId, replenishmentOrderId: input.replenishmentOrderId }, orderBy: [{ productId: 'asc' }, { id: 'asc' }] })
  if (order.stockReservationPolicy === REPLENISHMENT_SUBMISSION_POLICY) assertFrozenHolds(holds, order.items)
  if (holds.some(h => h.status === 'TRANSFERRED')) throw conflict('补货预占已经转交正式订单，不能直接取消')
  const active = holds.filter(h => h.status === 'ACTIVE')
  if (!active.length) return
  const warehouseId = active[0].warehouseId
  if (active.some(h => h.warehouseId !== warehouseId)) throw conflict('补货预占存在多个仓库，请核对流水')
  const balances = await lockWarehouseReservationBalances(tx, { tenantId: input.tenantId, warehouseId, products: active.map(h => ({ productId: h.productId, inventoryUnit: h.inventoryUnit })) })
  for (const hold of active) {
    const balance = balances.get(hold.productId)!
    const reservedAfter = balance.reservedQty.minus(hold.inventoryQuantity)
    if (reservedAfter.lt(0)) throw conflict('总仓预占余额异常，无法释放补货预占')
    await tx.warehouseLedgerMovement.create({ data: {
      tenantId: input.tenantId, warehouseId, productId: hold.productId, type: 'ORDER_RELEASED',
      physicalDelta: ZERO, reservedDelta: hold.inventoryQuantity.negated(), valueDelta: ZERO,
      physicalAfter: balance.physicalQty, reservedAfter, valueAfter: balance.inventoryValue, averageUnitCostAfter: balance.averageUnitCost,
      originalQuantity: hold.originalQuantity, originalUnit: hold.originalUnit, conversionFactor: hold.conversionFactor,
      inventoryQuantity: hold.inventoryQuantity, inventoryUnit: hold.inventoryUnit, inventoryUnitCost: balance.averageUnitCost,
      sourceType: 'ReplenishmentOrder', sourceId: input.replenishmentOrderId, sourceLineId: hold.replenishmentOrderItemId,
      idempotencyKey: `replenishment-release:${input.replenishmentOrderId}:${hold.replenishmentOrderItemId}`,
      createdById: input.userId, effectiveAt: new Date(),
    } })
    await persistWarehouseReservationBalance(tx, balance, { physicalQty: balance.physicalQty, reservedQty: reservedAfter, inventoryValue: balance.inventoryValue, averageUnitCost: balance.averageUnitCost })
    await tx.replenishmentStockHold.update({ where: { id: hold.id }, data: { status: 'RELEASED', releasedAt: new Date() } })
  }
}

/** Transfer ownership, not quantity: the same locked warehouse balance remains reserved. */
export async function transferReplenishmentStock(tx: Prisma.TransactionClient, input: Scope & { purchaseOrderId: string }) {
  const order = await tx.replenishmentOrder.findFirst({ where: { id: input.replenishmentOrderId, tenantId: input.tenantId }, include: { items: true } })
  if (!order || order.status !== 'ACCEPTED') throw conflict('补货单尚未接单，不能转交预占')
  if (order.stockReservationPolicy !== REPLENISHMENT_SUBMISSION_POLICY) return false
  const po = await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId: input.tenantId, status: 'CONFIRMED' }, include: { items: { where: { isActive: true } } } })
  if (!po) throw conflict('补货正式订单不存在或状态不符')
  if (po.storeId !== order.storeId || po.supplierId !== order.supplierId) throw conflict('补货正式订单门店或供应商与原补货单不一致')
  const holds = await tx.replenishmentStockHold.findMany({ where: { tenantId: input.tenantId, replenishmentOrderId: input.replenishmentOrderId }, orderBy: { productId: 'asc' } })
  assertFrozenHolds(holds, order.items)
  const lines = po.items.map(item => resolveFrozenOrderInventoryLine({ ...item, shippedQty: item.shippedQty ?? undefined, purchaseOrderItemId: item.id }))
  if (!holds.length || holds.length !== lines.length || holds.some(h => h.status !== 'ACTIVE')) throw conflict('补货提交预占记录不完整，不能重复或跳过转交')
  const byProduct = new Map(lines.map(l => [l.productId, l]))
  const warehouseId = holds[0].warehouseId
  for (const hold of holds) {
    const line = byProduct.get(hold.productId)
    if (hold.warehouseId !== warehouseId || !line || line.inventoryUnit !== hold.inventoryUnit || line.originalUnit !== hold.originalUnit || !line.originalQuantity.equals(hold.originalQuantity) || !line.conversionFactor.equals(hold.conversionFactor) || !line.inventoryQuantity.equals(hold.inventoryQuantity)) throw conflict('补货冻结预占与正式订单不一致，请核对单位和数量')
  }
  if ((await tx.warehouseLedgerReservation.findMany({ where: { tenantId: input.tenantId, purchaseOrderId: input.purchaseOrderId }, select: { id: true } })).length) throw conflict('正式订单已存在预占，不能重复转交')
  const balances = await lockWarehouseReservationBalances(tx, { tenantId: input.tenantId, warehouseId, products: holds.map(h => ({ productId: h.productId, inventoryUnit: h.inventoryUnit })) })
  for (const hold of holds) {
    const balance = balances.get(hold.productId)!
    if (balance.reservedQty.lt(hold.inventoryQuantity) || balance.physicalQty.lt(balance.reservedQty)) throw conflict('总仓预占余额与补货持有不符，请先核对库存')
    const line = byProduct.get(hold.productId)!
    await tx.warehouseLedgerReservation.create({ data: {
      tenantId: input.tenantId, warehouseId, productId: hold.productId, purchaseOrderId: input.purchaseOrderId, purchaseOrderItemId: line.purchaseOrderItemId,
      originalQuantity: hold.originalQuantity, originalUnit: hold.originalUnit, conversionFactor: hold.conversionFactor,
      inventoryQuantity: hold.inventoryQuantity, inventoryUnit: hold.inventoryUnit, status: 'ACTIVE', fulfilledInventoryQty: ZERO,
    } })
    await tx.replenishmentStockHold.update({ where: { id: hold.id }, data: { status: 'TRANSFERRED', transferredAt: new Date(), purchaseOrderId: input.purchaseOrderId, purchaseOrderItemId: line.purchaseOrderItemId } })
  }
  return true
}
