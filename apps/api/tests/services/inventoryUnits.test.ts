import { describe, expect, it } from 'vitest'
import {
  convertBomUsageToProductUnit,
  convertQuantityBetweenProductUnits,
  convertQuantityToInventoryUnit,
  isValidProductUnitFactor,
  normalizeInventoryQuantity,
  normalizeProductUnitName,
  physicalAmountPerPackage,
  purchasePriceToInventoryUnitCost,
  resolveProductFourUnits,
  resolveProductInventoryUnit,
} from '../../src/services/inventoryUnits'

describe('inventory unit normalization', () => {
  it('parses package physical totals', () => {
    expect(physicalAmountPerPackage('箱/20包/500g')).toEqual({ dimension: 'mass', value: 10000 })
    expect(physicalAmountPerPackage('500g*20包/箱')).toEqual({ dimension: 'mass', value: 10000 })
    expect(physicalAmountPerPackage('件/24瓶/330ml')).toEqual({ dimension: 'volume', value: 7920 })
    expect(physicalAmountPerPackage('箱/10斤/500g')).toEqual({ dimension: 'mass', value: 5000 })
  })

  it('converts jin into a 1kg purchasing piece', () => {
    const result = normalizeInventoryQuantity({
      quantity: 6, rawUnit: '斤', rawSpec: '件/1000g', productUnit: '件', productSpec: '件/1000g',
    })
    expect(result.status).toBe('CONVERTED')
    expect(result.normalizedQuantity).toBe(3)
  })

  it('converts bags and bottles into cases', () => {
    expect(normalizeInventoryQuantity({
      quantity: 13, rawUnit: '袋', rawSpec: '箱/20包/500g', productUnit: '箱', productSpec: '箱/20包/500g',
    }).normalizedQuantity).toBe(0.65)
    expect(normalizeInventoryQuantity({
      quantity: 29, rawUnit: '瓶', rawSpec: '件/24瓶/330ml', productUnit: '箱', productSpec: '件/24瓶/330ml',
    }).normalizedQuantity).toBeCloseTo(29 / 24)
    expect(normalizeInventoryQuantity({
      quantity: 1, rawUnit: '罐', rawSpec: '330*24/箱', productUnit: '箱', productSpec: '330*24/箱',
    }).normalizedQuantity).toBeCloseTo(1 / 24)
  })

  it('uses physical package ratios when package labels differ', () => {
    const result = normalizeInventoryQuantity({
      quantity: 8.6, rawUnit: '件', rawSpec: '件/500g', productUnit: '箱', productSpec: '件/5Kg',
    })
    expect(result.normalizedQuantity).toBeCloseTo(0.86)
  })

  it('converts confirmed gift gross usage into purchasing units', () => {
    expect(convertBomUsageToProductUnit({
      quantity: 32, bomUnit: 'g', productUnit: '箱', productSpec: '件/5Kg',
    }).normalizedQuantity).toBeCloseTo(0.0064)
    expect(convertBomUsageToProductUnit({
      quantity: 50, bomUnit: 'g', productUnit: '件', productSpec: '桶/3KG',
    }).normalizedQuantity).toBeCloseTo(1 / 60)
  })

  it('respects an inner purchasing unit described inside an outer-case spec', () => {
    expect(convertBomUsageToProductUnit({
      quantity: 139.6, bomUnit: 'g', productUnit: '包', productSpec: '箱/10包/2500g',
    }).normalizedQuantity).toBeCloseTo(139.6 / 2500)
  })

  it('treats 件 as the outer case when a bare inner multiplier ends in 箱', () => {
    expect(convertBomUsageToProductUnit({
      quantity: 75, bomUnit: 'g', productUnit: '件', productSpec: '1.5kg*6/箱',
    }).normalizedQuantity).toBeCloseTo(75 / 9000)
  })

  it('keeps outer-case conversion for explicit inner package counts', () => {
    expect(convertBomUsageToProductUnit({
      quantity: 120, bomUnit: 'g', productUnit: '箱', productSpec: '箱/60包/120g',
    }).normalizedQuantity).toBeCloseTo(1 / 60)
  })

  it('marks an ambiguous conversion pending', () => {
    expect(normalizeInventoryQuantity({
      quantity: 2, rawUnit: '盒', rawSpec: '盒', productUnit: '件', productSpec: null,
    }).status).toBe('PENDING')
  })

  it('rejects malformed physical unit tokens instead of guessing grams', () => {
    expect(physicalAmountPerPackage('3Gg/桶')).toBeNull()
    expect(convertBomUsageToProductUnit({
      quantity: 55, bomUnit: 'g', productUnit: '桶', productSpec: '3Gg/桶',
    })).toMatchObject({
      status: 'PENDING', normalizedQuantity: null,
    })
  })

  it('keeps a deterministic factor when the physical count is zero', () => {
    expect(normalizeInventoryQuantity({
      quantity: 0, rawUnit: '斤', productUnit: '桶', productSpec: '45kg/桶',
    })).toMatchObject({
      status: 'CONVERTED', normalizedQuantity: 0, normalizedUnit: '桶', factor: 1 / 90,
    })
  })

  it('uses a structured case-to-each contract for oysters', () => {
    const product = {
      unit: '箱', inventoryUnit: '个', inventoryUnitsPerPurchaseUnit: 18,
      unitConversionStatus: 'VERIFIED',
    }
    expect(resolveProductInventoryUnit(product)).toMatchObject({
      purchaseUnit: '箱', inventoryUnit: '个', inventoryUnitsPerPurchaseUnit: 18,
      status: 'VERIFIED', structured: true,
    })
    expect(convertQuantityToInventoryUnit({ quantity: 2, sourceUnit: '箱', product })).toMatchObject({
      status: 'CONVERTED', normalizedQuantity: 36, normalizedUnit: '个', factor: 18,
    })
    expect(convertQuantityToInventoryUnit({ quantity: 2, sourceUnit: '个', product })).toMatchObject({
      status: 'EXACT', normalizedQuantity: 2, normalizedUnit: '个', factor: 1,
    })
  })

  it('converts purchase price into moving-average inventory-unit cost', () => {
    const product = {
      unit: '箱', inventoryUnit: '罐', inventoryUnitsPerPurchaseUnit: '6',
      unitConversionStatus: 'INFERRED',
    }
    expect(purchasePriceToInventoryUnitCost({ purchaseUnitPrice: 180, product })).toBe(30)
  })

  it('does not override a structured contract with specification heuristics', () => {
    const product = {
      unit: '箱', inventoryUnit: '个', inventoryUnitsPerPurchaseUnit: 18,
      unitConversionStatus: 'VERIFIED',
    }
    expect(convertQuantityToInventoryUnit({
      quantity: 500, sourceUnit: 'g', product, productSpec: '18个/箱',
    })).toMatchObject({ status: 'PENDING', normalizedQuantity: null, normalizedUnit: '个' })
  })

  it('keeps unmigrated products readable without marking them verified', () => {
    expect(resolveProductInventoryUnit({ unit: '袋' })).toEqual({
      purchaseUnit: '袋', inventoryUnit: '袋', inventoryUnitsPerPurchaseUnit: 1,
      status: 'PENDING', structured: false,
    })
  })

  it('resolves and converts all four units through the inventory basis', () => {
    const product = {
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '托',
      costUnit: '打',
      inventoryUnitsPerPurchaseUnit: 12,
      inventoryUnitsPerOrderUnit: 144,
      inventoryUnitsPerCostUnit: 6,
      unitConversionStatus: 'VERIFIED',
    }
    expect(resolveProductFourUnits(product)).toMatchObject({
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '托',
      costUnit: '打',
      inventoryUnitsPerPurchaseUnit: 12,
      inventoryUnitsPerOrderUnit: 144,
      inventoryUnitsPerCostUnit: 6,
    })
    expect(convertQuantityBetweenProductUnits({
      quantity: 2,
      source: 'order',
      target: 'cost',
      product,
    })).toMatchObject({
      status: 'CONVERTED',
      normalizedQuantity: 48,
      normalizedUnit: '打',
      factor: 24,
    })
  })

  it('uses deterministic legacy factor compatibility without reading the specification', () => {
    expect(resolveProductFourUnits({
      unit: '箱',
      inventoryUnit: '瓶',
      inventoryUnitsPerPurchaseUnit: 12,
    })).toMatchObject({
      purchaseUnit: '箱',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 12,
      inventoryUnitsPerOrderUnit: 12,
      inventoryUnitsPerCostUnit: 12,
    })
  })

  it('validates unit names and finite positive six-decimal factors', () => {
    expect(normalizeProductUnitName('  瓶  ')).toBe('瓶')
    expect(() => normalizeProductUnitName('   ')).toThrow('单位名不能为空')
    expect(() => normalizeProductUnitName('12345678901234567')).toThrow('不能超过 16 个字符')
    expect(isValidProductUnitFactor(0.000001)).toBe(true)
    expect(isValidProductUnitFactor(0.0000001)).toBe(false)
    expect(isValidProductUnitFactor(0)).toBe(false)
    expect(isValidProductUnitFactor(Number.POSITIVE_INFINITY)).toBe(false)
  })
})
