import { describe, it, expect, vi } from 'vitest'
import { Prisma } from '@dianjie/db'
import { netEventsFromLedger, readInventoryNetCosts } from '../../src/services/inventoryNetCostRead'
const d = (n: number) => new Prisma.Decimal(n)
const row = (patch: Record<string, unknown> = {}) => ({
  id: 'a', tenantId: 't', warehouseId: 'w', productId: 'p', inventoryUnit: 'kg', type: 'UPSTREAM_RECEIPT',
  physicalDelta: d(10), valueDelta: d(113), physicalAfter: d(10), valueAfter: d(113), reversalOfId: null,
  upstreamReceiptLine: { tenantId: 't', productId: 'p', inventoryUnit: 'kg',
    purchaseOrderLine: { taxRate: d(0.13) }, receipt: { purchaseOrder: { taxInclusive: true } } }, ...patch,
}) as any
const balance = { warehouseId: 'w', productId: 'p', inventoryUnit: 'kg', physicalQty: d(10), inventoryValue: d(113) }

describe('reliable net-cost ledger reader', () => {
  it('uses the frozen contract tax basis and isolates the tenant and physical/value balance', async () => {
    const findMany = vi.fn().mockResolvedValue([row()])
    const r = await readInventoryNetCosts({ warehouseLedgerMovement: { findMany } } as any, 't', [balance])
    expect(findMany.mock.calls[0][0].where.tenantId).toBe('t')
    expect(r.get('w/p/kg')?.netAmount?.toString()).toBe('100')
  })
  it('does not trust an incomplete ledger matching only the physical count', async () => {
    const findMany = vi.fn().mockResolvedValue([row({ valueDelta: d(112) })])
    const r = await readInventoryNetCosts({ warehouseLedgerMovement: { findMany } } as any, 't', [balance])
    expect(r.has('w/p/kg')).toBe(false)
  })
  it('never assumes historical manual or cross-tenant source values are tax-exclusive', () => {
    expect(netEventsFromLedger([row({ upstreamReceiptLine: null })])[0].netValueDelta).toBeNull()
    const m = row(); m.upstreamReceiptLine.tenantId = 'other'
    expect(netEventsFromLedger([m])[0].netValueDelta).toBeNull()
  })
  it('refuses truncated cost history instead of rendering partial totals', async () => {
    const findMany = vi.fn().mockResolvedValue(Array(50001).fill(row()))
    await expect(readInventoryNetCosts({ warehouseLedgerMovement: { findMany } } as any, 't', [balance])).rejects.toMatchObject({ statusCode: 400 })
  })
})

it('binds legacy delivery reversal sourceLineId only to the original tenant/product/warehouse/unit and whitelist source',()=>{
 const original=row({id:'out',type:'ORDER_OUTBOUND',sourceType:'DeliveryOrder',physicalDelta:d(-10),valueDelta:d(-113),upstreamReceiptLine:null})
 const back=row({id:'back',type:'REVERSAL',sourceType:'ReceiptRejectionReversal',sourceLineId:'out',physicalDelta:d(2),valueDelta:d(22.6),upstreamReceiptLine:null})
 expect(netEventsFromLedger([original,back])[1].reversalOfId).toBe('out')
 for(const patch of [{tenantId:'other'},{warehouseId:'other'},{productId:'other'},{inventoryUnit:'other'},{sourceType:'UnknownReversal'}])expect(netEventsFromLedger([original,{...back,...patch}])[1].reversalOfId).toBeNull()
})

it('binds value corrections only to matching manual inbound facts',()=>{
 const original=row({id:'in',type:'MANUAL_INBOUND',upstreamReceiptLine:null})
 const correction=row({id:'edit',type:'ADJUSTMENT',sourceType:'WarehouseDocValueAdjust',sourceLineId:'in',physicalDelta:d(0),valueDelta:d(11.3),upstreamReceiptLine:null})
 expect(netEventsFromLedger([original,correction])[1].adjustmentOfId).toBe('in')
 for(const patch of[{tenantId:'other'},{warehouseId:'other'},{productId:'other'},{inventoryUnit:'other'},{sourceType:'UnknownAdjustment'},{type:'REVERSAL'},{physicalDelta:d(1)},{sourceLineId:'missing'}])expect(netEventsFromLedger([original,{...correction,...patch}])[1].adjustmentOfId).toBeNull()
 expect(netEventsFromLedger([{...original,type:'ORDER_OUTBOUND'},correction])[1].adjustmentOfId).toBeNull()
})

it('uses frozen contract tax metadata for receipt cost',()=>{ for(const [inclusive, expected] of [[true,'100'],[false,'113']] as const){ const m=row();m.upstreamReceiptLine.receipt.purchaseOrder.taxInclusive=inclusive; expect(netEventsFromLedger([m])[0].netValueDelta?.toString()).toBe(expected) } })
