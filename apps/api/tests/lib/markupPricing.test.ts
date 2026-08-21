import { describe, expect, it } from 'vitest'
import { computeMarkupPrice } from '../../src/services/markupPricing'

describe('computeMarkupPrice（比例加价核心公式）', () => {
  it('均价 × 成本单位因子 × (1+比例)，保留 2 位小数', () => {
    // 毛肚：均价 0.073/g × 2500g/包 × 1.25 = 228.13
    expect(computeMarkupPrice({ averageUnitCost: '0.073', inventoryUnitsPerCostUnit: 2500, markupPercent: 25 })?.toFixed(2)).toBe('228.13')
  })

  it('美团截图口径：60.36/kg × 1 × 1.2 = 72.43', () => {
    expect(computeMarkupPrice({ averageUnitCost: '60.36', inventoryUnitsPerCostUnit: 1, markupPercent: 20 })?.toFixed(2)).toBe('72.43')
  })

  it('比例 0 = 平进平出', () => {
    expect(computeMarkupPrice({ averageUnitCost: '0.05', inventoryUnitsPerCostUnit: 7500, markupPercent: 0 })?.toFixed(2)).toBe('375.00')
  })

  it('非法输入安静返回 null', () => {
    expect(computeMarkupPrice({ averageUnitCost: 0, inventoryUnitsPerCostUnit: 1, markupPercent: 20 })).toBeNull()
    expect(computeMarkupPrice({ averageUnitCost: '0.05', inventoryUnitsPerCostUnit: 0, markupPercent: 20 })).toBeNull()
    expect(computeMarkupPrice({ averageUnitCost: '0.05', inventoryUnitsPerCostUnit: 1, markupPercent: null })).toBeNull()
    expect(computeMarkupPrice({ averageUnitCost: '0.05', inventoryUnitsPerCostUnit: 1, markupPercent: -5 })).toBeNull()
    expect(computeMarkupPrice({ averageUnitCost: 'abc', inventoryUnitsPerCostUnit: 1, markupPercent: 20 })).toBeNull()
  })
})
