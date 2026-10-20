import { describe, expect, it } from 'vitest'
import { Prisma } from '@dianjie/db'
import { approvedOrderRevision, proposeOrderRevision } from '../../src/domain/upstreamOrderRevision'
const lines = [{ id: 'line-a', orderedQty: '3', unitPrice: '10', shippedQty: '0', receivedQty: '0' }]
describe('upstream quantity and price revision snapshots', () => {
  it('proposal freezes both prices and quantities without changing the source order', () => {
    const proposal = proposeOrderRevision(lines, [{ lineId: 'line-a', quantity: 3, unitPrice: 10.123456 }])
    expect(proposal.before[0]).toEqual({ id: 'line-a', quantity: '3', unitPrice: '10' })
    expect(proposal.after[0]).toEqual({ id: 'line-a', quantity: '3', unitPrice: '10.123456' })
    expect(lines[0].unitPrice).toBe('10')
    const approved = approvedOrderRevision(lines, proposal.before, proposal.after)
    expect(approved[0].quantity.mul(approved[0].unitPrice).toDecimalPlaces(4).toString()).toBe('30.3704')
  })
  it('retains old price for historic quantity-only snapshots', () => {
    const rows = approvedOrderRevision(lines, [{ id: 'line-a', quantity: '3' }], [{ id: 'line-a', quantity: '5' }])
    expect(rows[0].quantity.eq(5)).toBe(true)
    expect(rows[0].unitPrice.eq(10)).toBe(true)
  })
  it.each([0, -1, Number.NaN, 1.1234567, 1000000000])('rejects invalid price %s', unitPrice => {
    expect(() => proposeOrderRevision(lines, [{ lineId: 'line-a', quantity: 3, unitPrice }])).toThrow()
  })
  it('rejects duplicate and foreign lines', () => {
    expect(() => proposeOrderRevision(lines, [{ lineId: 'line-a', quantity: 3 }, { lineId: 'line-a', quantity: 3 }])).toThrow('重复')
    expect(() => proposeOrderRevision(lines, [{ lineId: 'other', quantity: 3 }])).toThrow('不属于')
  })
  it('rejects shipped, received, stale and incomplete revisions', () => {
    const p = proposeOrderRevision(lines, [{ lineId: 'line-a', quantity: 3, unitPrice: 12 }])
    expect(() => proposeOrderRevision([{ ...lines[0], shippedQty: '1' }], [{ lineId: 'line-a', quantity: 3 }])).toThrow('已有发货')
    expect(() => approvedOrderRevision([{ ...lines[0], receivedQty: '1' }], p.before, p.after)).toThrow('已有发货')
    expect(() => approvedOrderRevision([{ ...lines[0], unitPrice: '11' }], p.before, p.after)).toThrow('已变化')
    expect(() => approvedOrderRevision(lines, p.before, [])).toThrow('不完整')
    expect(() => approvedOrderRevision(lines, p.before, [p.after[0], p.after[0]])).toThrow('重复')
  })
})
