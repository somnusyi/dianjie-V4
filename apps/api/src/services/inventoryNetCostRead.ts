import { Prisma } from '@dianjie/db'
import { NetCostEvent, projectInventoryNetCost } from './inventoryNetCost'

const receiptBasis = { include: { receipt: { include: { purchaseOrder: true } }, purchaseOrderLine: true } } as const
const include = { upstreamReceiptLine: receiptBasis, netCostBasisConfirmations: { orderBy: { version: 'desc' as const }, take: 1 } } as const
export type NetBasisConfirmation = { netValueDelta: Prisma.Decimal | null; poolNetValueAfter?: Prisma.Decimal | null; physicalAfterSnapshot?: Prisma.Decimal; grossValueAfterSnapshot?: Prisma.Decimal; postingSequenceSnapshot?: number | null; grossValueDeltaSnapshot: Prisma.Decimal; physicalDeltaSnapshot: Prisma.Decimal; inventoryUnitSnapshot: string; tenantId: string; movementId: string; version: number }
export type NetBasisMovement = Prisma.WarehouseLedgerMovementGetPayload<{ include: { upstreamReceiptLine: typeof receiptBasis } }> & { postingSequence?: number | bigint | null; netCostBasisConfirmations?: NetBasisConfirmation[] }
export type NetCostHistory = Omit<ReturnType<typeof projectInventoryNetCost>, 'movements'> & {
  reason?: string
  movements: Array<NetBasisMovement & { netValueDelta: Prisma.Decimal | null; netValueAfter: Prisma.Decimal | null; netValueAfterOverride?: Prisma.Decimal | null }>
}
export type NetCostKey = { warehouseId: string; productId: string; inventoryUnit: string }
export const netCostKey = (b: NetCostKey) => `${b.warehouseId}/${b.productId}/${b.inventoryUnit}`

/** Exact append-only evidence outranks historical source inference, and must still match the immutable original fact. */
export function netEventsFromLedger(rows: NetBasisMovement[]): NetCostEvent[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const deliveryReversals = new Set(['DeliveryOrderShipCancel', 'ReceiptRejectionReversal', 'LossClaimReversal'])
  return rows.map(m => {
    const receipt = m.upstreamReceiptLine, order = receipt?.receipt.purchaseOrder
    const confirmation = m.netCostBasisConfirmations?.[0]
    let basis: Prisma.Decimal | null = null
    if (confirmation) {
      if (confirmation.tenantId !== m.tenantId || confirmation.movementId !== m.id || confirmation.inventoryUnitSnapshot !== m.inventoryUnit || !confirmation.grossValueDeltaSnapshot.equals(m.valueDelta) || !confirmation.physicalDeltaSnapshot.equals(m.physicalDelta)) throw new Error('Net basis evidence does not match source movement')
      if (confirmation.poolNetValueAfter != null && (!confirmation.physicalAfterSnapshot?.equals(m.physicalAfter) || !confirmation.grossValueAfterSnapshot?.equals(m.valueAfter) || (confirmation.postingSequenceSnapshot ?? null) !== (m.postingSequence ?? 0))) throw new Error('Confirmed pool evidence does not match anchor movement')
      basis = confirmation.netValueDelta
    } else if (receipt && order && receipt.tenantId === m.tenantId && receipt.productId === m.productId && receipt.inventoryUnit === m.inventoryUnit) {
      const rate = receipt.purchaseOrderLine.taxRate
      if (typeof order.taxInclusive === 'boolean' && rate != null && rate.isFinite() && rate.gte(0) && rate.lte(1)) basis = m.valueDelta.div(order.taxInclusive ? new Prisma.Decimal(1).plus(rate) : 1).toDecimalPlaces(4)
    }
    const adjustedSource = m.sourceType === 'WarehouseDocValueAdjust' && m.sourceLineId ? byId.get(m.sourceLineId) : null
    const adjustmentOfId = adjustedSource && adjustedSource.type === 'MANUAL_INBOUND' && m.type === 'ADJUSTMENT' && m.physicalDelta.isZero()
      && adjustedSource.tenantId === m.tenantId && adjustedSource.warehouseId === m.warehouseId
      && adjustedSource.productId === m.productId && adjustedSource.inventoryUnit === m.inventoryUnit ? adjustedSource.id : null
    let reversalOfId = m.reversalOfId
    if (m.type === 'REVERSAL' && deliveryReversals.has(m.sourceType)) {
      const original = byId.get(m.reversalOfId || m.sourceLineId || '')
      reversalOfId = original && original.type === 'ORDER_OUTBOUND' && original.sourceType === 'DeliveryOrder'
        && original.tenantId === m.tenantId && original.warehouseId === m.warehouseId && original.productId === m.productId && original.inventoryUnit === m.inventoryUnit
        ? original.id : null
    }
    return { id: m.id, quantityDelta: m.physicalDelta, valueDelta: m.valueDelta, netValueDelta: basis, netValueAfterOverride: confirmation?.poolNetValueAfter ?? null,
      useAverageCost: ['ORDER_OUTBOUND','LOSS','PURCHASE_RETURN'].includes(m.type), reversalOfId, adjustmentOfId }
  })
}

/** Old rows have no sequence: use the unique before/after value+quantity chain, never random IDs as posting order. */
export function orderNetCostLedger(rows: NetBasisMovement[]) {
  const old = rows.filter(m => m.postingSequence == null), sequenced = rows.filter(m => m.postingSequence != null).sort((a,b) => a.postingSequence! < b.postingSequence! ? -1 : a.postingSequence! > b.postingSequence! ? 1 : 0)
  const state = (q: Prisma.Decimal, v: Prisma.Decimal) => `${q.toFixed(6)}|${v.toFixed(4)}`
  const before = (m: NetBasisMovement) => state(m.physicalAfter.minus(m.physicalDelta),m.valueAfter.minus(m.valueDelta))
  const buckets = new Map<string, NetBasisMovement[]>()
  for (const m of old) { const k = before(m), list = buckets.get(k) || []; list.push(m); buckets.set(k,list) }
  const ordered: NetBasisMovement[] = [], used = new Set<string>()
  let q = new Prisma.Decimal(0), v = new Prisma.Decimal(0)
  while (ordered.length < old.length) {
    const k=state(q,v), options=(buckets.get(k)||[]).filter(m=>!used.has(m.id))
    const noChange=options.filter(m=>m.physicalDelta.eq(0)&&m.valueDelta.eq(0)).sort((a,b)=>a.id.localeCompare(b.id))
    for(const m of noChange){ordered.push(m);used.add(m.id)}
    const changes=options.filter(m=>!m.physicalDelta.eq(0)||!m.valueDelta.eq(0))
    if (!changes.length) { if (ordered.length===old.length) break; throw new Error('INCOMPLETE_COST_HISTORY') }
    if (changes.length!==1) throw new Error('AMBIGUOUS_LEGACY_POSTING_ORDER')
    const m=changes[0];ordered.push(m);used.add(m.id);q=m.physicalAfter;v=m.valueAfter
  }
  let last: number | bigint | null=null
  for(const m of sequenced){
    if (m.postingSequence! <= 0n || last != null && m.postingSequence! <= last) throw new Error('INVALID_POSTING_SEQUENCE')
    if(before(m)!==state(q,v)) throw new Error('INCOMPLETE_COST_HISTORY')
    ordered.push(m);q=m.physicalAfter;v=m.valueAfter;last=m.postingSequence!
  }
  return ordered
}

/** Shared full history for realtime, opening/closing, movement detail and export. Month attribution uses effectiveAt; cost uses posting sequence. */
export async function readInventoryNetCostHistory(tx: Prisma.TransactionClient, tenantId: string, keys: NetCostKey[]) {
  const output = new Map<string, NetCostHistory>()
  if (!keys.length) return output
  const rows: NetBasisMovement[] = await (tx as any).warehouseLedgerMovement.findMany({ where: { tenantId, OR: keys.map(b=>({warehouseId:b.warehouseId,productId:b.productId,inventoryUnit:b.inventoryUnit})) }, include, take:50001 })
  if(rows.length>50000) throw Object.assign(new Error('成本追溯记录过多，请缩小仓库或商品筛选范围'),{statusCode:400})
  const groups = new Map<string, NetBasisMovement[]>()
  for(const row of rows){const k=netCostKey(row),list=groups.get(k)||[];list.push(row);groups.set(k,list)}
  for(const item of keys){const k=netCostKey(item),ledger=groups.get(k)||[]
    try{
      const sorted=orderNetCostLedger(ledger), projection=projectInventoryNetCost(netEventsFromLedger(sorted)), costs=new Map(projection.movements.map(m=>[m.id,m]))
      output.set(k,{...projection,movements:sorted.map(m=>({...m,...costs.get(m.id)!}))})
    }catch(error){
      // A documented pool confirmation is a new trusted checkpoint, not invented historical cost.
      // Earlier net facts remain unavailable even when a unique old posting order cannot be recovered.
      const anchor = ledger.filter(m=>m.postingSequence!=null && m.netCostBasisConfirmations?.[0]?.poolNetValueAfter!=null).sort((a,b)=>a.postingSequence! > b.postingSequence! ? -1 : 1)[0]
      let restored=false
      if(anchor){try{
        const event=netEventsFromLedger([anchor])[0],pool=event.netValueAfterOverride
        if(pool==null)throw new Error('Missing pool confirmation')
        const seed={...anchor,physicalDelta:anchor.physicalAfter,valueDelta:anchor.valueAfter}
        const after=ledger.filter(m=>m.postingSequence!=null && m.postingSequence!>anchor.postingSequence!)
        const orderedAfter=orderNetCostLedger([seed,...after]).slice(1)
        const projection=projectInventoryNetCost([{id:anchor.id,quantityDelta:anchor.physicalAfter,valueDelta:anchor.valueAfter,netValueDelta:pool},...netEventsFromLedger(orderedAfter)])
        const costs=new Map(projection.movements.map(m=>[m.id,m])),following=new Set(orderedAfter.map(m=>m.id))
        const earlier=ledger.filter(m=>m.id!==anchor.id&&!following.has(m.id)).map(m=>({...m,netValueDelta:null,netValueAfter:null}))
        output.set(k,{...projection,reason:'HISTORICAL_NET_UNKNOWN_BEFORE_CONFIRMED_POOL',movements:[...earlier,{...anchor,netValueDelta:null,netValueAfter:new Prisma.Decimal(pool),netValueAfterOverride:new Prisma.Decimal(pool)},...orderedAfter.map(m=>({...m,...costs.get(m.id)!}))]})
        restored=true
      }catch{/* A stale or disconnected checkpoint cannot restore the current balance. */}}
      if(!restored)output.set(k,{quantity:ledger.reduce((n,m)=>n.plus(m.physicalDelta),new Prisma.Decimal(0)),grossAmount:ledger.reduce((n,m)=>n.plus(m.valueDelta),new Prisma.Decimal(0)),netAmount:null,netPrice:null,status:'PENDING_COST',unresolvedMovementIds:ledger.map(m=>m.id),reason:(error as Error).message,movements:ledger.map(m=>({...m,netValueDelta:null,netValueAfter:null}))})
    }
  }
  return output
}

/** Backward-compatible realtime adapter; the current physical/gross balance must reconcile. */
export async function readInventoryNetCosts(tx: Prisma.TransactionClient, tenantId: string, balances: Array<NetCostKey & { physicalQty: Prisma.Decimal; inventoryValue: Prisma.Decimal }>) {
  const history=await readInventoryNetCostHistory(tx,tenantId,balances),output=new Map<string,ReturnType<typeof projectInventoryNetCost>>()
  for(const b of balances){const k=netCostKey(b),h=history.get(k);if(!h)continue
    const gross=h.grossAmount
    if(h.quantity.equals(b.physicalQty)&&gross.equals(b.inventoryValue))output.set(k,h)
  }
  return output
}
