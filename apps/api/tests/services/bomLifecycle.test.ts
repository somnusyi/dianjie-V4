import { describe, expect, it } from 'vitest'
import {
  bomDateRangesOverlap,
  calculateBomConsumptions,
  isBomVersionEffective,
  selectEffectiveBomVersion,
} from '../../src/services/bomLifecycle'

const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'v1', variantKey: '', versionNo: 1, status: 'PUBLISHED',
  effectiveFrom: '2026-07-01', effectiveTo: null,
  items: [{ productId: 'p1', quantity: 0.2, lossRate: 0.05 }],
  ...overrides,
})

describe('BOM lifecycle', () => {
  it('selects the version effective on the business date', () => {
    const selected = selectEffectiveBomVersion([
      version({ id: 'old', effectiveTo: '2026-07-15' }),
      version({ id: 'new', versionNo: 2, effectiveFrom: '2026-07-16' }),
    ], '2026-07-16', '')
    expect(selected?.id).toBe('new')
  })

  it('prefers an exact specification and falls back to the default BOM', () => {
    const versions = [version(), version({ id: 'large', variantKey: '大份' })]
    expect(selectEffectiveBomVersion(versions, '2026-07-10', '大份')?.id).toBe('large')
    expect(selectEffectiveBomVersion(versions, '2026-07-10', '小份')?.id).toBe('v1')
  })

  it('never executes drafts or future versions', () => {
    expect(isBomVersionEffective(version({ status: 'DRAFT' }), '2026-07-10')).toBe(false)
    expect(isBomVersionEffective(version({ effectiveFrom: '2026-07-11' }), '2026-07-10')).toBe(false)
  })

  it('detects overlapping published ranges', () => {
    expect(bomDateRangesOverlap(
      { effectiveFrom: '2026-07-01', effectiveTo: '2026-07-15' },
      { effectiveFrom: '2026-07-15', effectiveTo: null },
    )).toBe(true)
    expect(bomDateRangesOverlap(
      { effectiveFrom: '2026-07-01', effectiveTo: '2026-07-14' },
      { effectiveFrom: '2026-07-15', effectiveTo: null },
    )).toBe(false)
  })

  it('calculates and aggregates consumption to six decimals', () => {
    expect(calculateBomConsumptions(10, [
      { productId: 'p1', quantity: 0.2, lossRate: 0.05 },
      { productId: 'p1', quantity: 0.1, lossRate: 0 },
    ])).toEqual([{ productId: 'p1', quantity: 3.1 }])
  })
})
