import { describe, expect, it } from 'vitest'
import { partitionDeliveryNoteRows } from './delivery-note-print'
describe('delivery print page capacity', () => {
  it('keeps uneven long rows whole and preserves every row exactly once', () => {
    const heights = [20, 180, 40, 160, 20, 110]
    const pages = partitionDeliveryNoteRows(heights, 240)
    expect(pages).toEqual([[0, 1, 2], [3, 4], [5]])
    expect(pages.flat()).toEqual(heights.map((_, index) => index))
  })
  it('supports an exact full page, empty details, and a single oversized row without looping', () => {
    expect(partitionDeliveryNoteRows([120, 120, 20], 240)).toEqual([[0, 1], [2]])
    expect(partitionDeliveryNoteRows([], 240)).toEqual([[]])
    expect(partitionDeliveryNoteRows([300, 20], 240)).toEqual([[0], [1]])
  })
  it('rejects a header that leaves no printable content space', () => {
    expect(() => partitionDeliveryNoteRows([20], 0)).toThrow('抬头或备注过长')
  })
})
