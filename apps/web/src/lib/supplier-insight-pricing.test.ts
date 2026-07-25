import { describe, expect, it } from 'vitest'
import {
  formatSkuRankPriceLabel,
  isSkuRankValuationPending,
} from './supplier-insight-pricing'

describe('formatSkuRankPriceLabel', () => {
  it('formats a valued price with order unit', () => {
    expect(formatSkuRankPriceLabel({
      orderUnitPrice: 10,
      valuationStatus: 'VALUED',
      orderUnit: '斤',
    })).toBe('¥10.00 / 斤')
  })

  it('returns 货值待核验 for PENDING status', () => {
    expect(formatSkuRankPriceLabel({
      orderUnitPrice: 10,
      valuationStatus: 'PENDING',
      orderUnit: '斤',
    })).toBe('货值待核验')
  })

  it('returns 货值待核验 for null price', () => {
    expect(formatSkuRankPriceLabel({
      orderUnitPrice: null,
      valuationStatus: 'VALUED',
      orderUnit: '斤',
    })).toBe('货值待核验')
  })

  it('omits unit when orderUnit is absent', () => {
    expect(formatSkuRankPriceLabel({
      orderUnitPrice: 8.5,
      valuationStatus: 'VALUED',
      orderUnit: null,
    })).toBe('¥8.50')
  })
})

describe('isSkuRankValuationPending', () => {
  it('returns false for a valued row', () => {
    expect(isSkuRankValuationPending({
      orderUnitPrice: 10,
      valuationStatus: 'VALUED',
      orderUnit: '斤',
    })).toBe(false)
  })

  it('returns true for PENDING', () => {
    expect(isSkuRankValuationPending({
      orderUnitPrice: 10,
      valuationStatus: 'PENDING',
      orderUnit: '斤',
    })).toBe(true)
  })

  it('returns true for null price even if status says VALUED', () => {
    expect(isSkuRankValuationPending({
      orderUnitPrice: null,
      valuationStatus: 'VALUED',
      orderUnit: '斤',
    })).toBe(true)
  })
})
