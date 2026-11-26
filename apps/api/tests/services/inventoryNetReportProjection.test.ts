import { describe, it, expect } from 'vitest'
import { Prisma } from '@dianjie/db'
import { summarizeNetReportCosts, netMovementReportCells } from '../../src/services/inventoryNetReportProjection'
const d = (n: number) => new Prisma.Decimal(n)
const event = (id: string, date: string, quantity: number, net: number | null) => ({ id, effectiveAt: new Date(date), physicalDelta: d(quantity), netValueDelta: net })
const start = new Date('2026-10-01T00:00:00Z'), end = new Date('2026-11-01T00:00:00Z')
describe('shared net-cost report cells', () => {
  it('reconciles opening + inbound - outbound and excludes next month', () => {
    const r = summarizeNetReportCosts([event('a','2026-09-30',10,100),event('b','2026-10-01',5,50),event('c','2026-10-31',-3,-30),event('d','2026-11-01',5,500)],start,end)
    expect(r).toMatchObject({ openingAmount:100,inAmount:50,outAmount:30,closingAmount:120,costStatus:'KNOWN' })
  })
  it('does not turn an unknown opening balance into zero', () => {
    const r = summarizeNetReportCosts([event('a','2026-09-30',10,null),event('b','2026-10-01',5,50)],start,end)
    expect(r.openingAmount).toBeNull();expect(r.closingAmount).toBeNull();expect(r.inAmount).toBe(50)
  })
  it('includes value-only corrections and reversal deltas', () => {
    const r = summarizeNetReportCosts([event('a','2026-10-01',10,100),event('b','2026-10-02',0,10),event('c','2026-10-03',-10,-100)],start,end)
    expect(r).toMatchObject({inAmount:110,outAmount:100,closingAmount:10})
  })
  it('uses original document units for detail unit cost and preserves missing cost', () => {
    expect(netMovementReportCells(d(-100),false,d(2))).toMatchObject({outAmount:100,outPrice:50,inAmount:0})
    expect(netMovementReportCells(null,true,d(2))).toMatchObject({inAmount:null,inPrice:null,costStatus:'PENDING_COST'})
  })
  it('shows a documented current pool without inventing historic purchase amounts', () => {
    const old = { ...event('old','2026-09-30',10,null), netValueAfter:null }
    const anchor = { ...event('anchor','2026-10-02',0,null), netValueAfter:100 }
    const r = summarizeNetReportCosts([old,anchor],start,end)
    expect(r.openingAmount).toBeNull();expect(r.inAmount).toBeNull()
    expect(r.closingAmount).toBe(100);expect(r.costStatus).toBe('PENDING_COST')
  })
  it('does not use a snapshot containing future business-dated postings', () => {
    const future = { ...event('future','2026-11-02',10,100), netValueAfter:100 }
    const backdated = { ...event('backdate','2026-10-02',5,50), netValueAfter:150 }
    expect(summarizeNetReportCosts([future,backdated],start,end).closingAmount).toBe(50)
  })

})
