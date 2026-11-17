import { describe, expect, it } from 'vitest'
import { partitionDeliveryNoteRows, planDeliveryNotePages } from './delivery-note-print'
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

describe('first-page order information and continuation capacity', () => {
  it('reclaims metadata space on continuation pages without losing or repeating goods', () => {
    const heights = Array(12).fill(30)
    const pages = planDeliveryNotePages(heights, 100, 200, 30)
    expect(pages).toEqual([[0, 1, 2], [3, 4, 5, 6, 7, 8], [9, 10, 11]])
    expect(pages.flat()).toEqual(heights.map((_, index) => index))
  })
  it('moves the last goods row with totals and signatures to the next page when necessary', () => {
    expect(planDeliveryNotePages([30, 30, 30], 100, 200, 50)).toEqual([[0, 1], [2]])
    expect(planDeliveryNotePages([], 100, 200, 30)).toEqual([[]])
    expect(planDeliveryNotePages([80], 100, 200, 150)).toEqual([[0], []])
  })
  it('fails visibly instead of clipping an unprintable line or footer', () => {
    expect(() => planDeliveryNotePages([201], 100, 200, 30)).toThrow('单行超出纸面')
    expect(() => planDeliveryNotePages([30], 100, 200, 201)).toThrow('备注过长')
  })
})
