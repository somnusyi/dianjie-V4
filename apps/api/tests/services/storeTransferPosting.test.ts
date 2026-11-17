import { describe, it, expect } from 'vitest'
import { Prisma } from '@dianjie/db'
import { postStoreTransfer, transferPosition, transferRemaining } from '../../src/services/storeTransferPosting'
const d = (v: any) => new Prisma.Decimal(v)
function setup() {
  const line: any = { id: 'line', productId: 'p', quantity: d(10), cost: d(0), settlement: d(99), unit: 'kg', receivedQuantity: d(0), returnedQuantity: d(0), damagedQuantity: d(0), outAmount: d(0), inAmount: d(0) }
  const row: any = { id: 'tr', tenantId: 't', fromStoreId: 'a', toStoreId: 'b', status: 'PENDING', items: [line] }
  const moves: any[] = []
  const matches = (m: any, where: any) => Object.entries(where).every(([k,v]: any) => k === 'effectiveAt' ? m.effectiveAt >= v.gte && m.effectiveAt <= v.lte : k === 'kind' && v.in ? v.in.includes(m.kind) : m[k] === v)
  const tx: any = {
    $queryRaw: async () => [],
    product: { findFirst: async () => ({ inventoryUnit: 'kg', unitConversionStatus: 'VERIFIED' }) },
    inventorySnapshot: { findFirst: async ({where}: any) => ({ snapshotDate: new Date('2026-01-01Z'), items: [{ normalizedQuantity: d(where.storeId === 'a' ? 20 : 5), normalizedUnit: 'kg', normalizationStatus: 'EXACT', amount: d(where.storeId === 'a' ? 2000 : 500) }] }) },
    receiptItem: { findMany: async () => [] }, stockConsumption: { findMany: async () => [] }, lossClaimItem: { findMany: async () => [] },
    storeTransfer: { findFirst: async () => row, update: async ({data}: any) => Object.assign(row,data) },
    storeTransferItem: { findMany: async () => [line], update: async ({data}: any) => { for (const [k,v] of Object.entries(data) as any) line[k] = v && typeof v === 'object' && 'increment' in v ? d(line[k]).plus(v.increment) : v; return line } },
    storeTransferMovement: {
      findMany: async ({where}: any) => moves.filter(m => matches(m,where)),
      findFirst: async ({where}: any) => moves.find(m => matches(m,where)),
      create: async ({data}: any) => { moves.push({...data}); return data },
      aggregate: async ({where}: any) => ({ _sum: { amount: moves.filter(m => matches(m,where)).reduce((n,m) => n.plus(m.amount),d(0)) } }),
    },
  }
  const post = (action: any, requestKey: string, quantity?: number) => postStoreTransfer(tx,{ tenantId:'t', transferId:'tr', actorId:'sc', action, requestKey, ...(quantity == null ? {} : {items:[{itemId:'line',quantity}]}), note:'处置说明' })
  return { tx,line,row,moves,post }
}
describe('store transfer postings on trusted store cost', () => {
  it('ships at source-store cost, receives only actual quantity, returns remaining quantity, and replays once', async () => {
    const {tx,line,row,moves,post} = setup()
    await post('SHIP','ship')
    expect(line.cost.toString()).toBe('100'); expect(line.settlement.toString()).toBe('100')
    await post('RECEIVE','receive',9)
    expect(row.status).toBe('PARTIALLY_RECEIVED'); expect(transferRemaining(line).toString()).toBe('1')
    expect((await transferPosition(tx,'t','a','p')).quantity.toString()).toBe('10')
    expect((await transferPosition(tx,'t','b','p')).quantity.toString()).toBe('14')
    await post('RETURN','return',1); await post('RETURN','return',1)
    expect(row.status).toBe('RECEIVED'); expect(moves).toHaveLength(3)
    expect((await transferPosition(tx,'t','a','p')).value.toString()).toBe('1100')
    expect((await transferPosition(tx,'t','b','p')).value.toString()).toBe('1400')
  })
  it('records transit damage without adding goods back to either store', async () => {
    const {tx,line,moves,post} = setup(); await post('SHIP','ship'); await post('RECEIVE','receive',9); await post('DAMAGE','damage',1)
    expect(line.damagedQuantity.toString()).toBe('1'); expect(moves[2].quantityDelta.toString()).toBe('0'); expect(moves[2].amount.toString()).toBe('100')
    expect((await transferPosition(tx,'t','a','p')).quantity.toString()).toBe('10'); expect((await transferPosition(tx,'t','b','p')).quantity.toString()).toBe('14')
  })
  it('rejects over-receipt, conflicting replay, missing baseline, and uncosted stock', async () => {
    const {tx,post} = setup(); await post('SHIP','ship'); await post('RECEIVE','receive',9)
    await expect(post('RETURN','return',2)).rejects.toThrow('超过剩余'); await expect(post('RECEIVE','receive',8)).rejects.toThrow('相同请求')
    tx.inventorySnapshot.findFirst = async () => null; await expect(transferPosition(tx,'t','a','p')).rejects.toThrow('可信盘点')
    const next=setup();next.tx.inventorySnapshot.findFirst=async()=>({snapshotDate:new Date('2026-01-01Z'),items:[{normalizedQuantity:d(20),normalizedUnit:'kg',normalizationStatus:'EXACT',amount:d(0)}]})
    await expect(next.post('SHIP','ship')).rejects.toThrow('可靠账面成本')
  })
  it('allocates the last amount remainder exactly once across receiving, return and damage', async () => {
    const {tx,line,moves,post} = setup();line.quantity=d(3)
    tx.inventorySnapshot.findFirst=async()=>({snapshotDate:new Date('2026-01-01Z'),items:[{normalizedQuantity:d(3),normalizedUnit:'kg',normalizationStatus:'EXACT',amount:d(1)}]})
    await post('SHIP','ship');await post('RECEIVE','r1',1);await post('RETURN','r2',1);await post('DAMAGE','r3',1)
    expect(line.outAmount.toString()).toBe('1')
    expect(moves.slice(1).reduce((n,m)=>n.plus(m.amount),d(0)).toString()).toBe('1')
    expect(moves[3].amount.toString()).toBe('0.3334')
  })
  it('rejects a shipment above available quantity before adding any movements', async () => {
    const {tx,moves,post}=setup()
    tx.inventorySnapshot.findFirst=async()=>({snapshotDate:new Date('2026-01-01Z'),items:[{normalizedQuantity:d(5),normalizedUnit:'kg',normalizationStatus:'EXACT',amount:d(500)}]})
    await expect(post('SHIP','ship')).rejects.toThrow('可用库存不足');expect(moves).toHaveLength(0)
  })
  it('refuses automatic posting of historical shipped documents without outbound evidence', async () => {
    const {row,post}=setup();row.status='SHIPPED'
    await expect(post('RECEIVE','receive',9)).rejects.toThrow('历史调拨')
  })

})
