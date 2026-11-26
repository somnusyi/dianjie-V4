import { describe, it, expect } from 'vitest'
import { projectInventoryNetCost as project } from '../../src/services/inventoryNetCost'

describe('inventory net-cost replay', () => {
  it('weights different frozen tax bases before outbound', () => {
    const r = project([
      { id: 'a', quantityDelta: 10, valueDelta: 113, netValueDelta: 100 },
      { id: 'b', quantityDelta: 10, valueDelta: 106, netValueDelta: 100 },
      { id: 'out', quantityDelta: -5, valueDelta: -54.75 },
    ])
    expect(r.netAmount?.toString()).toBe('150')
    expect(r.netPrice?.toString()).toBe('10')
  })
  it('does not turn unknown historic gross cost into net cost', () => {
    const r = project([
      { id: 'old', quantityDelta: 10, valueDelta: 113 },
      { id: 'reserve', quantityDelta: 0, valueDelta: 0 },
      { id: 'new', quantityDelta: 10, valueDelta: 100, netValueDelta: 100 },
    ])
    expect(r.netAmount).toBeNull()
    expect(r.unresolvedMovementIds).toEqual(['old'])
  })
  it('reestablishes a reliable pool only after unknown stock is exhausted', () => {
    const r = project([
      { id: 'old', quantityDelta: 3, valueDelta: 33 },
      { id: 'out', quantityDelta: -3, valueDelta: -33 },
      { id: 'new', quantityDelta: 2, valueDelta: 22.6, netValueDelta: 20 },
    ])
    expect(r.netAmount?.toString()).toBe('20')
    expect(r.unresolvedMovementIds).toEqual([])
  })
  it('uses original frozen basis for reversal rather than the new average', () => {
    const r = project([
      { id: 'a', quantityDelta: 10, valueDelta: 113, netValueDelta: 100 },
      { id: 'b', quantityDelta: 5, valueDelta: 106, netValueDelta: 100 },
      { id: 'reverse', quantityDelta: -5, valueDelta: -106, netValueDelta: -100 },
    ])
    expect(r.netAmount?.toString()).toBe('100')
  })
  it('allocates all fractional cost on the final depletion', () => {
    const r = project([
      { id: 'a', quantityDelta: 3, valueDelta: 1.13, netValueDelta: 1 },
      { id: 'x', quantityDelta: -1, valueDelta: -0.3767 },
      { id: 'y', quantityDelta: -2, valueDelta: -0.7533 },
    ])
    expect(r.netAmount?.toString()).toBe('0')
    expect(r.movements[2].netValueDelta?.toString()).toBe('-0.6667')
  })
  it('rejects duplicate movements and physical overdraw', () => {
    expect(() => project([{ id: 'x', quantityDelta: -1, valueDelta: -1 }])).toThrow()
    expect(() => project([{ id: 'x', quantityDelta: 0, valueDelta: 0 }, { id: 'x', quantityDelta: 0, valueDelta: 0 }])).toThrow()
  })
})

it('restores partial reversals from the original frozen net cost and places rounding remainder on the last part',()=>{
 const r=project([{id:'in',quantityDelta:3,valueDelta:1.13,netValueDelta:1},{id:'out',quantityDelta:-3,valueDelta:-1.13},{id:'r1',quantityDelta:1,valueDelta:0.3767,reversalOfId:'out'},{id:'r2',quantityDelta:2,valueDelta:0.7533,reversalOfId:'out'}])
 expect(r.movements[2].netValueDelta?.toString()).toBe('0.3333');expect(r.movements[3].netValueDelta?.toString()).toBe('0.6667');expect(r.netAmount?.toString()).toBe('1')
})
it('rejects excessive cumulative reversals and mismatched original gross amount',()=>{
 const prefix=[{id:'in',quantityDelta:10,valueDelta:113,netValueDelta:100},{id:'out',quantityDelta:-10,valueDelta:-113}]
 expect(()=>project([...prefix,{id:'r1',quantityDelta:6,valueDelta:67.8,reversalOfId:'out'},{id:'r2',quantityDelta:5,valueDelta:56.5,reversalOfId:'out'}])).toThrow('exceeds original')
 expect(()=>project([...prefix,{id:'r1',quantityDelta:2,valueDelta:25,reversalOfId:'out'}])).toThrow('original frozen cost')
})
it('does not restore an unknown source from a current average or a missing original reference',()=>{
 const r=project([{id:'in',quantityDelta:10,valueDelta:113},{id:'out',quantityDelta:-10,valueDelta:-113},{id:'back',quantityDelta:2,valueDelta:22.6,reversalOfId:'out'}]);expect(r.netAmount).toBeNull()
 const missing=project([{id:'back',quantityDelta:2,valueDelta:22.6,reversalOfId:'absent'}]);expect(missing.netAmount).toBeNull()
})

it('counts explicitly confirmed partial reversal against the same original before allocating the final remainder',()=>{
 const r=project([{id:'in',quantityDelta:3,valueDelta:1.13,netValueDelta:1},{id:'out',quantityDelta:-3,valueDelta:-1.13},{id:'r1',quantityDelta:1,valueDelta:0.3767,netValueDelta:0.3333,reversalOfId:'out'},{id:'r2',quantityDelta:2,valueDelta:0.7533,reversalOfId:'out'}]);expect(r.movements[3].netValueDelta?.toString()).toBe('0.6667');expect(r.netAmount?.toString()).toBe('1')
})

it('preserves quantity-zero amount-only full reversals and frozen amount partial reversals with limits',()=>{
 const prefix=[{id:'in',quantityDelta:10,valueDelta:113,netValueDelta:100},{id:'adjust',quantityDelta:0,valueDelta:11.3,netValueDelta:10}]
 const full=project([...prefix,{id:'back',quantityDelta:0,valueDelta:-11.3,reversalOfId:'adjust'}]);expect(full.netAmount?.toString()).toBe('100');expect(full.movements[2].netValueDelta?.toString()).toBe('-10')
 const parts=project([...prefix,{id:'r1',quantityDelta:0,valueDelta:-3.7667,reversalOfId:'adjust'},{id:'r2',quantityDelta:0,valueDelta:-7.5333,reversalOfId:'adjust'}]);expect(parts.netAmount?.toString()).toBe('100');expect(parts.movements[2].netValueDelta?.toString()).toBe('-3.3334');expect(parts.movements[3].netValueDelta?.toString()).toBe('-6.6666')
 expect(()=>project([...prefix,{id:'r1',quantityDelta:0,valueDelta:-12,reversalOfId:'adjust'}])).toThrow('exceeds original')
})

it('includes sequential documented source corrections in a later reversal without rewriting historical movement costs',()=>{
 const r=project([{id:'a',quantityDelta:10,valueDelta:113,netValueDelta:100},{id:'b',quantityDelta:10,valueDelta:113,netValueDelta:100},{id:'up',quantityDelta:0,valueDelta:22.6,netValueDelta:20,adjustmentOfId:'a'},{id:'down',quantityDelta:0,valueDelta:-11.3,netValueDelta:-10,adjustmentOfId:'a'},{id:'back',quantityDelta:-10,valueDelta:-124.3,reversalOfId:'a'}])
 expect(r.netAmount?.toString()).toBe('100')
 expect(r.movements.map(m=>m.netValueDelta?.toString())).toEqual(['100','100','20','-10','-110'])
})
it('does not invent net cost for an undocumented source correction',()=>{
 const r=project([{id:'a',quantityDelta:10,valueDelta:113,netValueDelta:100},{id:'b',quantityDelta:10,valueDelta:113,netValueDelta:100},{id:'up',quantityDelta:0,valueDelta:11.3,adjustmentOfId:'a'},{id:'back',quantityDelta:-10,valueDelta:-124.3,reversalOfId:'a'}])
 expect(r.netAmount).toBeNull();expect(r.movements[3].netValueDelta).toBeNull()
})
it('rejects source corrections after reversal or against a missing or overdrawn source',()=>{
 const original={id:'a',quantityDelta:10,valueDelta:113,netValueDelta:100}
 expect(()=>project([original,{id:'bad',quantityDelta:0,valueDelta:1,netValueDelta:1,adjustmentOfId:'missing'}])).toThrow('Invalid source value adjustment')
 expect(()=>project([original,{id:'back',quantityDelta:-5,valueDelta:-56.5,reversalOfId:'a'},{id:'bad',quantityDelta:0,valueDelta:1,netValueDelta:1,adjustmentOfId:'a'}])).toThrow('Invalid source value adjustment')
 expect(()=>project([original,{id:'bad',quantityDelta:0,valueDelta:-114,netValueDelta:-100,adjustmentOfId:'a'}])).toThrow('Source value adjustment exceeds original value')
})
