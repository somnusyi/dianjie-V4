import { describe, expect, it } from 'vitest'
import { groupDeliveryReceiveDifferences } from '../../src/services/deliveryReceiveDifferences'

describe('门店验收逐商品差异分组', () => {
  it('同一收货单可把不同商品分别归入少发和破损差异单', () => {
    const groups = groupDeliveryReceiveDifferences([
      { productId: 'potato', kind: 'ARRIVAL_SHORTAGE' as const, reason: '少送 5 箱' },
      { productId: 'mushroom', kind: 'ARRIVAL_DAMAGE' as const, reason: '包装破损' },
      { productId: 'tripe', kind: 'ARRIVAL_SHORTAGE' as const, reason: '少送 2 件' },
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({
      kind: 'ARRIVAL_SHORTAGE',
      lines: [
        expect.objectContaining({ productId: 'potato', reason: '少送 5 箱' }),
        expect.objectContaining({ productId: 'tripe', reason: '少送 2 件' }),
      ],
    })
    expect(groups[1]).toEqual({
      kind: 'ARRIVAL_DAMAGE',
      lines: [expect.objectContaining({ productId: 'mushroom' })],
    })
  })

  it('同一类型即使原因不同也保持同一张差异单，原因留在商品明细', () => {
    const [group] = groupDeliveryReceiveDifferences([
      { productId: 'a', kind: 'ARRIVAL_DAMAGE' as const, reason: '外包装破损' },
      { productId: 'b', kind: 'ARRIVAL_DAMAGE' as const, reason: '变质' },
    ])

    expect(group.lines).toHaveLength(2)
    expect(group.lines.map(line => line.reason)).toEqual(['外包装破损', '变质'])
  })
})
