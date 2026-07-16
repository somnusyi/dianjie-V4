import { describe, expect, it } from 'vitest'
import { convertBomUsageToProductUnit, normalizeInventoryQuantity, physicalAmountPerPackage } from '../../src/services/inventoryUnits'

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

  it('marks an ambiguous conversion pending', () => {
    expect(normalizeInventoryQuantity({
      quantity: 2, rawUnit: '盒', rawSpec: '盒', productUnit: '件', productSpec: null,
    }).status).toBe('PENDING')
  })

  it('keeps a deterministic factor when the physical count is zero', () => {
    expect(normalizeInventoryQuantity({
      quantity: 0, rawUnit: '斤', productUnit: '桶', productSpec: '45kg/桶',
    })).toMatchObject({
      status: 'CONVERTED', normalizedQuantity: 0, normalizedUnit: '桶', factor: 1 / 90,
    })
  })
})
