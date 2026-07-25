import { describe, expect, it } from 'vitest'
import {
  buildFourUnitCreateBody,
  buildFourUnitEditBody,
  buildFourUnitValues,
  countDecimals,
  DEFAULT_FOUR_UNIT_FORM,
  fallbackFourUnitsFromLegacy,
  formatCompactUnitSummary,
  formatConversionSummary,
  fourUnitFormFromProduct,
  normalizeUnit,
  parseConversionFactor,
  validateConversionFactor,
  validateFourUnitForm,
} from './supply-product-four-units'

describe('normalizeUnit', () => {
  it('trims whitespace', () => {
    expect(normalizeUnit('  kg  ')).toBe('kg')
  })

  it('keeps empty string empty', () => {
    expect(normalizeUnit('')).toBe('')
    expect(normalizeUnit('   ')).toBe('')
  })
})

describe('parseConversionFactor', () => {
  it('parses positive finite numbers', () => {
    expect(parseConversionFactor('6')).toBe(6)
    expect(parseConversionFactor('0.5')).toBe(0.5)
    expect(parseConversionFactor('  1.234567  ')).toBe(1.234567)
  })

  it('returns null for empty or whitespace-only values', () => {
    expect(parseConversionFactor('')).toBeNull()
    expect(parseConversionFactor('   ')).toBeNull()
  })

  it('rejects zero, negative, NaN and infinity', () => {
    expect(parseConversionFactor('0')).toBeNull()
    expect(parseConversionFactor('-1')).toBeNull()
    expect(parseConversionFactor('abc')).toBeNull()
    expect(parseConversionFactor('NaN')).toBeNull()
    expect(parseConversionFactor('Infinity')).toBeNull()
    expect(parseConversionFactor('-Infinity')).toBeNull()
  })
})

describe('countDecimals', () => {
  it('counts decimal places', () => {
    expect(countDecimals(1)).toBe(0)
    expect(countDecimals(1.2)).toBe(1)
    expect(countDecimals(1.234567)).toBe(6)
    expect(countDecimals(1.2345678)).toBe(7)
  })
})

describe('validateConversionFactor', () => {
  it('accepts positive numbers up to 6 decimals', () => {
    expect(validateConversionFactor('1')).toBeNull()
    expect(validateConversionFactor('6')).toBeNull()
    expect(validateConversionFactor('1.234567')).toBeNull()
  })

  it('rejects empty value', () => {
    expect(validateConversionFactor('')).toBe('换算因子必填')
  })

  it('rejects zero', () => {
    expect(validateConversionFactor('0')).toBe('换算因子必须大于 0')
  })

  it('rejects negative numbers', () => {
    expect(validateConversionFactor('-2')).toBe('换算因子必须是正数')
  })

  it('rejects NaN', () => {
    expect(validateConversionFactor('abc')).toBe('换算因子必须是有限数字')
  })

  it('rejects infinity', () => {
    expect(validateConversionFactor('Infinity')).toBe('换算因子必须是有限数字')
  })

  it('rejects more than 6 decimal places', () => {
    expect(validateConversionFactor('1.2345678')).toBe('换算因子最多 6 位小数')
    expect(validateConversionFactor('1e-7')).toBe('换算因子最多 6 位小数')
  })

  it('rejects factors above the API limit', () => {
    expect(validateConversionFactor('1000000000')).toBeNull()
    expect(validateConversionFactor('1000000000.000001')).toBe('换算因子超过系统上限')
  })
})

describe('validateFourUnitForm', () => {
  it('accepts valid four-unit form', () => {
    expect(validateFourUnitForm(DEFAULT_FOUR_UNIT_FORM)).toBeNull()
  })

  it('rejects empty units', () => {
    expect(validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, purchaseUnit: '' })).toBe('采购单位必填')
    expect(validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, inventoryUnit: '   ' })).toBe('库存单位必填')
    expect(validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, orderUnit: '' })).toBe('订货单位必填')
    expect(validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, costUnit: '   ' })).toBe('成本单位必填')
  })

  it('rejects invalid factors', () => {
    expect(
      validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, inventoryUnitsPerPurchaseUnit: '0' }),
    ).toBe('换算因子必须大于 0')
    expect(
      validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, inventoryUnitsPerOrderUnit: '-1' }),
    ).toBe('换算因子必须是正数')
    expect(
      validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, inventoryUnitsPerCostUnit: '1.2345678' }),
    ).toBe('换算因子最多 6 位小数')
  })

  it('matches API unit name length and format boundaries', () => {
    expect(
      validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, purchaseUnit: '超长单位名称超过十六个字符的限制值' }),
    ).toBe('采购单位不能超过 16 个字符')
    expect(
      validateFourUnitForm({ ...DEFAULT_FOUR_UNIT_FORM, orderUnit: '24瓶' }),
    ).toBe('订货单位不能以数字开头')
  })

  it('rejects different factors for the same named unit', () => {
    expect(validateFourUnitForm({
      purchaseUnit: '箱',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '罐',
      inventoryUnitsPerPurchaseUnit: '24',
      inventoryUnitsPerOrderUnit: '6',
      inventoryUnitsPerCostUnit: '1',
    })).toBe('同名单位「箱」必须使用相同的库存换算因子')

    expect(validateFourUnitForm({
      ...DEFAULT_FOUR_UNIT_FORM,
      inventoryUnitsPerCostUnit: '2',
    })).toBe('同名单位「件」必须使用相同的库存换算因子')
  })
})

describe('buildFourUnitValues', () => {
  it('normalizes units and factors', () => {
    const values = buildFourUnitValues({
      purchaseUnit: ' 箱 ',
      inventoryUnit: ' 罐 ',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: '6',
      inventoryUnitsPerOrderUnit: '6',
      inventoryUnitsPerCostUnit: '1',
    })
    expect(values).toEqual({
      purchaseUnit: '箱',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 6,
      inventoryUnitsPerOrderUnit: 6,
      inventoryUnitsPerCostUnit: 1,
    })
  })

  it('falls back empty units to 件 and invalid factors to 1', () => {
    const values = buildFourUnitValues({
      purchaseUnit: '',
      inventoryUnit: '   ',
      orderUnit: '',
      costUnit: '',
      inventoryUnitsPerPurchaseUnit: '0',
      inventoryUnitsPerOrderUnit: 'abc',
      inventoryUnitsPerCostUnit: '-1',
    })
    expect(values.purchaseUnit).toBe('件')
    expect(values.inventoryUnit).toBe('件')
    expect(values.inventoryUnitsPerPurchaseUnit).toBe(1)
    expect(values.inventoryUnitsPerOrderUnit).toBe(1)
    expect(values.inventoryUnitsPerCostUnit).toBe(1)
  })
})

describe('fallbackFourUnitsFromLegacy', () => {
  it('falls back legacy unit and existing purchase conversion', () => {
    const form = fallbackFourUnitsFromLegacy({
      unit: '箱',
      inventoryUnit: '罐',
      inventoryUnitsPerPurchaseUnit: 6,
    })
    expect(form).toEqual({
      purchaseUnit: '箱',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: '6',
      inventoryUnitsPerOrderUnit: '6',
      inventoryUnitsPerCostUnit: '6',
    })
  })

  it('uses legacy unit as inventory unit when inventory unit is missing', () => {
    const form = fallbackFourUnitsFromLegacy({ unit: 'kg' })
    expect(form.inventoryUnit).toBe('kg')
    expect(form.inventoryUnitsPerPurchaseUnit).toBe('1')
    expect(form.inventoryUnitsPerOrderUnit).toBe('1')
  })

  it('defaults to 件 when legacy unit is empty', () => {
    const form = fallbackFourUnitsFromLegacy({ unit: null })
    expect(form.purchaseUnit).toBe('件')
  })
})

describe('fourUnitFormFromProduct', () => {
  it('uses new fields when present', () => {
    const form = fourUnitFormFromProduct({
      unit: '箱',
      purchaseUnit: '袋',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 12,
      inventoryUnitsPerOrderUnit: 6,
      inventoryUnitsPerCostUnit: 6,
    })
    expect(form.purchaseUnit).toBe('袋')
    expect(form.inventoryUnitsPerPurchaseUnit).toBe('12')
  })

  it('falls back for old products without new fields', () => {
    const form = fourUnitFormFromProduct({
      unit: '箱',
      inventoryUnit: '罐',
      inventoryUnitsPerPurchaseUnit: 6,
    })
    expect(form.purchaseUnit).toBe('箱')
    expect(form.orderUnit).toBe('箱')
    expect(form.costUnit).toBe('箱')
    expect(form.inventoryUnitsPerPurchaseUnit).toBe('6')
  })
})

describe('formatConversionSummary', () => {
  it('shows simple message when all units are the same', () => {
    const summary = formatConversionSummary(buildFourUnitValues(DEFAULT_FOUR_UNIT_FORM))
    expect(summary).toBe('四单位均为 件')
  })

  it('shows explicit conversions', () => {
    const summary = formatConversionSummary(
      buildFourUnitValues({
        purchaseUnit: '箱',
        inventoryUnit: '罐',
        orderUnit: '托',
        costUnit: '罐',
        inventoryUnitsPerPurchaseUnit: '24',
        inventoryUnitsPerOrderUnit: '6',
        inventoryUnitsPerCostUnit: '1',
      }),
    )
    expect(summary).toContain('1 箱 = 24 罐')
    expect(summary).toContain('1 托 = 6 罐')
  })
})

describe('formatCompactUnitSummary', () => {
  it('shows order unit, inventory unit and conversion', () => {
    const summary = formatCompactUnitSummary(
      buildFourUnitValues({
        purchaseUnit: '箱',
        inventoryUnit: '罐',
        orderUnit: '托',
        costUnit: '罐',
        inventoryUnitsPerPurchaseUnit: '24',
        inventoryUnitsPerOrderUnit: '6',
        inventoryUnitsPerCostUnit: '1',
      }),
    )
    expect(summary).toBe('订货：托，库存：罐（1 托 = 6 罐）')
  })
})

describe('buildFourUnitCreateBody', () => {
  it('includes all fixed contract fields and legacy unit mapped to order unit', () => {
    const body = buildFourUnitCreateBody({
      purchaseUnit: '箱',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: '24',
      inventoryUnitsPerOrderUnit: '6',
      inventoryUnitsPerCostUnit: '1',
    })
    expect(body).toEqual({
      purchaseUnit: '箱',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 24,
      inventoryUnitsPerOrderUnit: 6,
      inventoryUnitsPerCostUnit: 1,
      unit: '箱',
    })
  })

  it('trims units and normalizes factors', () => {
    const body = buildFourUnitCreateBody({
      purchaseUnit: ' 箱 ',
      inventoryUnit: ' 罐 ',
      orderUnit: ' 箱 ',
      costUnit: ' 箱 ',
      inventoryUnitsPerPurchaseUnit: ' 6 ',
      inventoryUnitsPerOrderUnit: ' 6 ',
      inventoryUnitsPerCostUnit: ' 1 ',
    })
    expect(body.purchaseUnit).toBe('箱')
    expect(body.inventoryUnit).toBe('罐')
    expect(body.inventoryUnitsPerPurchaseUnit).toBe(6)
  })
})

describe('buildFourUnitEditBody', () => {
  it('returns empty object when nothing changed', () => {
    const original = DEFAULT_FOUR_UNIT_FORM
    const body = buildFourUnitEditBody(DEFAULT_FOUR_UNIT_FORM, original)
    expect(body).toEqual({})
  })

  it('returns only changed fields and legacy unit when four units change', () => {
    const original: typeof DEFAULT_FOUR_UNIT_FORM = {
      ...DEFAULT_FOUR_UNIT_FORM,
      purchaseUnit: '箱',
      inventoryUnit: '罐',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: '6',
    }
    const form: typeof DEFAULT_FOUR_UNIT_FORM = {
      ...original,
      inventoryUnitsPerPurchaseUnit: '12',
    }
    const body = buildFourUnitEditBody(form, original)
    expect(body).toEqual({
      inventoryUnitsPerPurchaseUnit: 12,
      unit: '箱',
    })
  })

  it('detects order unit change and maps legacy unit', () => {
    const original = DEFAULT_FOUR_UNIT_FORM
    const form = { ...DEFAULT_FOUR_UNIT_FORM, orderUnit: '袋' }
    const body = buildFourUnitEditBody(form, original)
    expect(body).toEqual({
      orderUnit: '袋',
      unit: '袋',
    })
  })

  it('does not claim changes for old product fallback values', () => {
    const product = {
      unit: '箱',
      inventoryUnit: '罐',
      inventoryUnitsPerPurchaseUnit: 6,
    }
    const originalForm = fallbackFourUnitsFromLegacy(product)
    const body = buildFourUnitEditBody(originalForm, originalForm)
    expect(body).toEqual({})
  })
})
