import { Prisma } from '@dianjie/db'
import { hashRequestBody } from '../lib/idempotency'
import { businessDateKey, businessDateOnlyRange } from '../lib/businessTime'
const D = (v: any) => new Prisma.Decimal(v)
const fail = (message: string, statusCode = 422): never => { throw Object.assign(new Error(message), { statusCode }) }

export type TransferPosition = { quantity: Prisma.Decimal; value: Prisma.Decimal; costKnown: boolean; unit: string }
/** Trusted physical baseline plus subsequent facts. Never changes a historical count. */
export async function transferPosition(tx: any, tenantId: string, storeId: string, productId: string, at = new Date()): Promise<TransferPosition> {
  const product = await tx.product.findFirst({ where: { id: productId, tenantId }, select: { inventoryUnit: true, unitConversionStatus: true } })
  if (!product?.inventoryUnit || product.unitConversionStatus !== 'VERIFIED') fail('商品库存单位尚未确认')
  const snapshot = await tx.inventorySnapshot.findFirst({ where: { tenantId, storeId, snapshotDate: { lte: at } }, orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }], include: { items: { where: { productId } } } })
  if (!snapshot) fail('调出门店缺少可信盘点基准，请先核定库存')
  const start = new Date(snapshot.snapshotDate); start.setUTCDate(start.getUTCDate() + 1); start.setUTCHours(0, 0, 0, 0)
  const startTimestamp = businessDateOnlyRange(start).start
  const currentBusinessDate = new Date(`${businessDateKey(at)}T00:00:00.000Z`)
  let quantity = D(0), value = D(0), costKnown = true
  for (const item of snapshot.items) {
    if (item.normalizedQuantity == null || item.normalizedUnit !== product.inventoryUnit || item.normalizationStatus === 'PENDING') fail('门店盘点商品单位待核定')
    const q = D(item.normalizedQuantity), v = D(item.amount)
    if (q.lt(0) || v.lt(0) || (q.gt(0) && v.lte(0))) costKnown = false
    quantity = quantity.plus(q); value = value.plus(v)
  }
  const [receipts, consumptions, losses, transfers] = await Promise.all([
    tx.receiptItem.findMany({ where: { productId, receipt: { tenantId, storeId, status: { in: ['CONFIRMED', 'ACCOUNTED'] }, deliveryDate: { gte: start, lte: currentBusinessDate } } }, include: { receipt: { select: { deliveryDate: true } } } }),
    tx.stockConsumption.findMany({ where: { tenantId, storeId, productId, voidedAt: null, date: { gte: start, lte: currentBusinessDate } } }),
    tx.lossClaimItem.findMany({ where: { productId, lossClaim: { tenantId, storeId, createdAt: { gte: startTimestamp, lte: at }, OR: [{ isManual: true, status: { in: ['APPROVED', 'AUTO_APPROVED', 'RESOLVED'] } }, { isManual: false, payableBasis: 'GROSS_PENDING_CLAIM', status: { in: ['PENDING', 'APPROVED', 'AUTO_APPROVED', 'REJECTED', 'NEGOTIATING', 'RESOLVED'] } }] } }, include: { lossClaim: { select: { createdAt: true } } } }),
    tx.storeTransferMovement.findMany({ where: { tenantId, storeId, productId, effectiveAt: { gte: startTimestamp, lte: at } } }),
  ])
  const events = [
    ...receipts.map((i: any) => ({ at: businessDateOnlyRange(i.receipt.deliveryDate).start, q: i.inventoryQuantity, c: i.inventoryUnitCostSnapshot, v: null, inbound: true })),
    ...consumptions.map((i: any) => ({ at: businessDateOnlyRange(i.date).start, q: i.inventoryQuantity, c: null, v: null, inbound: false })),
    ...losses.map((i: any) => ({ at: i.lossClaim.createdAt, q: i.inventoryQuantity, c: null, v: null, inbound: false })),
    ...transfers.map((i: any) => ({ at: i.effectiveAt, q: D(i.quantityDelta).abs(), c: i.unitCost, v: D(i.valueDelta).abs(), inbound: D(i.quantityDelta).gt(0) })),
  ].sort((a: any, b: any) => +new Date(a.at) - +new Date(b.at) || Number(b.inbound) - Number(a.inbound))
  for (const e of events) {
    if (e.q == null) fail('门店历史出入库单位换算不完整，请先核定')
    const q = D(e.q)
    if (q.eq(0)) continue
    if (e.inbound) {
      if (e.c == null || D(e.c).lte(0)) costKnown = false
      quantity = quantity.plus(q); value = value.plus(e.v ?? q.mul(e.c ?? 0))
    } else {
      if (quantity.lt(q)) fail('门店历史库存出现负数，请先核定')
      const outValue = e.v ?? (quantity.gt(0) ? value.mul(q).div(quantity).toDecimalPlaces(4) : D(0))
      quantity = quantity.minus(q); value = value.minus(outValue)
    }
  }
  return { quantity, value, costKnown, unit: product.inventoryUnit }
}

export function transferRemaining(line: any) {
  return D(line.quantity).minus(line.receivedQuantity ?? 0).minus(line.returnedQuantity ?? 0).minus(line.damagedQuantity ?? 0)
}

export async function postStoreTransfer(tx: any, args: { tenantId: string; transferId: string; actorId: string; action: 'SHIP' | 'RECEIVE' | 'RETURN' | 'DAMAGE'; requestKey: string; items?: Array<{ itemId: string; quantity: number }>; note?: string }) {
  const { tenantId, transferId, actorId, action, requestKey } = args
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`store-transfer-post:${tenantId}:${transferId}`}))::text AS locked`
  const row = await tx.storeTransfer.findFirst({ where: { id: transferId, tenantId }, include: { items: true, fromStore: true, toStore: true } })
  if (!row) fail('调拨单不存在', 404)
  const fingerprint = hashRequestBody({ action, transferId, actorId, items: (args.items ?? []).map(i => ({ itemId: i.itemId, quantity: D(i.quantity).toFixed(6) })).sort((a,b) => a.itemId.localeCompare(b.itemId)), note: args.note ?? '' }, 'application/json')
  const replay = await tx.storeTransferMovement.findMany({ where: { tenantId, transferId, requestKey } })
  if (replay.length) {
    if (replay.some((x: any) => x.requestFingerprint !== fingerprint)) fail('相同请求编号不能用于不同调拨操作', 409)
    return row
  }
  if (action === 'SHIP' ? row.status !== 'PENDING' : !['SHIPPED', 'PARTIALLY_RECEIVED'].includes(row.status)) fail('调拨状态已变化，请刷新后重试', 409)
  if (action !== 'SHIP' && !await tx.storeTransferMovement.findFirst({ where: { tenantId, transferId, kind: 'SHIP' } })) fail('历史调拨尚无库存过账依据，请先核定')
  const quantities = action === 'SHIP' ? row.items.map((i: any) => ({ itemId: i.id, quantity: D(i.quantity) })) : (args.items ?? []).map(i => ({ itemId: i.itemId, quantity: D(i.quantity) }))
  if (!quantities.length || new Set(quantities.map((i: any) => i.itemId)).size !== quantities.length || quantities.some((i: any) => i.quantity.lte(0) || i.quantity.decimalPlaces() > 6)) fail('请填写有效且不重复的调拨商品数量', 400)
  // Product locks serialize competing transfers; Serializable transaction also guards other facts read above.
  for (const key of row.items.flatMap((i: any) => [row.fromStoreId, row.toStoreId].map(storeId => `store-transfer-stock:${tenantId}:${storeId}:${i.productId}`)).sort()) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`
  const at = new Date()
  for (const input of quantities) {
    const line = row.items.find((i: any) => i.id === input.itemId)
    if (!line) fail('商品行不属于当前调拨单', 400)
    const q = input.quantity
    if (action !== 'SHIP' && q.gt(transferRemaining(line))) fail('处理数量超过剩余差异数量')
    if (action === 'RECEIVE' && (await transferPosition(tx, tenantId, row.toStoreId, line.productId, at)).unit !== line.unit) fail('调入门店商品库存单位与原调拨不一致')
    let cost = D(line.cost), amount: Prisma.Decimal
    if (action === 'SHIP') {
      const pos = await transferPosition(tx, tenantId, row.fromStoreId, line.productId, at)
      if (pos.unit !== line.unit) fail('商品库存单位已变化，请重新核定调拨')
      if (!pos.costKnown || pos.quantity.lte(0) || pos.value.lte(0)) fail('调出门店没有可靠账面成本，请先由供应链核定')
      if (pos.quantity.lt(q)) fail('调出门店可用库存不足')
      cost = pos.value.div(pos.quantity).toDecimalPlaces(6)
      if (cost.lte(0)) fail('门店成本低于当前价格精度，请先核定')
      amount = q.eq(pos.quantity) ? pos.value.toDecimalPlaces(4) : q.mul(cost).toDecimalPlaces(4)
      await tx.storeTransferItem.update({ where: { id: line.id }, data: { cost, settlement: cost, outAmount: amount, inAmount: D(0) } })
    } else {
      const prior = await tx.storeTransferMovement.aggregate({ where: { tenantId, transferItemId: line.id, kind: { in: ['RECEIVE', 'RETURN', 'DAMAGE'] } }, _sum: { amount: true } })
      amount = q.eq(transferRemaining(line)) ? D(line.outAmount).minus(prior._sum.amount ?? 0) : q.mul(cost).toDecimalPlaces(4)
      if (amount.lt(0)) fail('调拨金额核对异常，请先核定')
      const field = action === 'RECEIVE' ? 'receivedQuantity' : action === 'RETURN' ? 'returnedQuantity' : 'damagedQuantity'
      await tx.storeTransferItem.update({ where: { id: line.id }, data: { [field]: { increment: q }, ...(action === 'RECEIVE' ? { inAmount: { increment: amount } } : {}) } })
    }
    await tx.storeTransferMovement.create({ data: { tenantId, transferId, transferItemId: line.id, storeId: action === 'RECEIVE' ? row.toStoreId : row.fromStoreId, productId: line.productId, kind: action, quantity: q, amount, quantityDelta: action === 'SHIP' ? q.negated() : action === 'DAMAGE' ? D(0) : q, valueDelta: action === 'SHIP' ? amount.negated() : action === 'DAMAGE' ? D(0) : amount, inventoryUnit: line.unit, unitCost: cost, requestKey, requestFingerprint: fingerprint, idempotencyKey: `${transferId}:${requestKey}:${line.id}`, effectiveAt: at, createdById: actorId, note: args.note ?? '' } })
  }
  const lines = await tx.storeTransferItem.findMany({ where: { transferId } })
  const complete = lines.every((i: any) => transferRemaining(i).eq(0))
  await tx.storeTransfer.update({ where: { id: transferId }, data: action === 'SHIP' ? { status: 'SHIPPED', shippedAt: at, shippedById: actorId } : { status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED', ...(complete ? { receivedAt: at, receivedById: actorId } : {}) } })
  return tx.storeTransfer.findFirst({ where: { id: transferId, tenantId }, include: { items: true, fromStore: true, toStore: true } })
}
