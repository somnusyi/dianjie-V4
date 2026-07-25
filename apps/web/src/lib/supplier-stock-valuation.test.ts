import { describe, expect, it } from 'vitest'
import {
  formatOrderUnitPriceLabel,
  formatValuationPendingWarning,
  isValuationPending,
} from './supplier-stock-valuation'

describe('isValuationPending', () => {
  it('returns false for VALUED with a finite non-negative price', () => {
    expect(isValuationPending({ orderUnitPrice: 12.5, valuationStatus: 'VALUED' })).toBe(false)
    expect(isValuationPending({ orderUnitPrice: 0, valuationStatus: 'VALUED' })).toBe(false)
  })

  it('returns true for explicit PENDING status', () => {
    expect(isValuationPending({ orderUnitPrice: 12.5, valuationStatus: 'PENDING' })).toBe(true)
  })

  it('returns true for null or undefined price', () => {
    expect(isValuationPending({ orderUnitPrice: null, valuationStatus: 'VALUED' })).toBe(true)
    expect(isValuationPending({ orderUnitPrice: undefined, valuationStatus: 'VALUED' })).toBe(true)
  })

  it('returns true for NaN, Infinity or negative price', () => {
    expect(isValuationPending({ orderUnitPrice: NaN, valuationStatus: 'VALUED' })).toBe(true)
    expect(isValuationPending({ orderUnitPrice: Infinity, valuationStatus: 'VALUED' })).toBe(true)
    expect(isValuationPending({ orderUnitPrice: -1, valuationStatus: 'VALUED' })).toBe(true)
  })

  it('returns true for unknown or missing status', () => {
    expect(isValuationPending({ orderUnitPrice: 12.5, valuationStatus: 'UNKNOWN' })).toBe(true)
    expect(isValuationPending({ orderUnitPrice: 12.5, valuationStatus: '' })).toBe(true)
    expect(isValuationPending({ orderUnitPrice: 12.5, valuationStatus: null })).toBe(true)
    expect(isValuationPending({ orderUnitPrice: 12.5 })).toBe(true)
  })
})

describe('formatOrderUnitPriceLabel', () => {
  it('shows formatted price with order unit when valued', () => {
    expect(
      formatOrderUnitPriceLabel({
        orderUnitPrice: 12.5,
        valuationStatus: 'VALUED',
        orderUnit: '斤',
      }),
    ).toBe('¥12.50 / 斤')
  })

  it('shows zero price when valid', () => {
    expect(
      formatOrderUnitPriceLabel({
        orderUnitPrice: 0,
        valuationStatus: 'VALUED',
        orderUnit: '件',
      }),
    ).toBe('¥0.00 / 件')
  })

  it('shows fallback for PENDING status', () => {
    expect(
      formatOrderUnitPriceLabel({
        orderUnitPrice: 12.5,
        valuationStatus: 'PENDING',
        orderUnit: '斤',
      }),
    ).toBe('货值待核验')
  })

  it('shows fallback for null price', () => {
    expect(
      formatOrderUnitPriceLabel({
        orderUnitPrice: null,
        valuationStatus: 'VALUED',
        orderUnit: '斤',
      }),
    ).toBe('货值待核验')
  })

  it('shows fallback for unknown status', () => {
    expect(
      formatOrderUnitPriceLabel({
        orderUnitPrice: 12.5,
        valuationStatus: 'UNKNOWN',
        orderUnit: '斤',
      }),
    ).toBe('货值待核验')
  })

  it('omits unit when order unit is missing', () => {
    expect(
      formatOrderUnitPriceLabel({
        orderUnitPrice: 12.5,
        valuationStatus: 'VALUED',
        orderUnit: null,
      }),
    ).toBe('¥12.50')
  })
})

describe('formatValuationPendingWarning', () => {
  it('returns null when there is no pending SKU', () => {
    expect(formatValuationPendingWarning(0)).toBeNull()
    expect(formatValuationPendingWarning(null)).toBeNull()
    expect(formatValuationPendingWarning(undefined)).toBeNull()
  })

  it('returns warning for a single pending SKU', () => {
    expect(formatValuationPendingWarning(1)).toBe('1 个四单位待核验 SKU 暂未计入货值')
  })

  it('returns warning for plural pending SKUs', () => {
    expect(formatValuationPendingWarning(3)).toBe('3 个四单位待核验 SKU 暂未计入货值')
  })

  it('returns null for non-finite counts', () => {
    expect(formatValuationPendingWarning(NaN)).toBeNull()
  })
})
