import { describe, expect, it } from 'vitest'
import {
  buildFourUnitCreateBody,
  buildFourUnitEditBody,
  buildFourUnitValues,
  computeOrderUnitPrice,
  countDecimals,
  DEFAULT_FOUR_UNIT_FORM,
  fallbackFourUnitsFromLegacy,
  formatCompactUnitSummary,
  formatConversionSummary,
  formatOrderUnitPriceHint,
  fourUnitFormFromProduct,
  inferUnitContractStatus,
  isSimpleFourUnitContract,
  lockCostUnitToMinimum,
  normalizeUnit,
  parseConversionFactor,
  parseSpecConversion,
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

  it('rejects a cost unit coarser than the inventory unit', () => {
    // 人工见手青场景：库存 g，成本单位填成件（1件=1000g），比库存更粗，应被禁止。
    expect(validateFourUnitForm({
      purchaseUnit: '件',
      inventoryUnit: 'g',
      orderUnit: '件',
      costUnit: '件',
      inventoryUnitsPerPurchaseUnit: '1000',
      inventoryUnitsPerOrderUnit: '1000',
      inventoryUnitsPerCostUnit: '1000',
    })).toBe('成本单位必须与库存单位一致（成本单位需为最小单位）')
  })

  it('accepts cost unit equal to the inventory unit', () => {
    expect(validateFourUnitForm({
      purchaseUnit: '件',
      inventoryUnit: 'g',
      orderUnit: '件',
      costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '1000',
      inventoryUnitsPerOrderUnit: '1000',
      inventoryUnitsPerCostUnit: '1',
    })).toBeNull()
  })

  it('keeps rejecting a coarser cost unit by default, but allows it for untouched legacy edits', () => {
    // 汤底调味粉场景（2026-08-18）：建档口径 costUnit=箱 / inventoryUnit=g。
    // 编辑弹窗原样加载该口径时，任何字段（如分类）的保存都不应被单位规则锁死；
    // 但一旦用户改动单位区（allowLegacyCostUnit 不再传入），严格规则恢复生效。
    const legacyForm = {
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: '15000',
      inventoryUnitsPerOrderUnit: '15000',
      inventoryUnitsPerCostUnit: '15000',
    }
    expect(validateFourUnitForm(legacyForm))
      .toBe('成本单位必须与库存单位一致（成本单位需为最小单位）')
    expect(validateFourUnitForm(legacyForm, { allowLegacyCostUnit: true })).toBeNull()
    expect(validateFourUnitForm(legacyForm, { allowLegacyCostUnit: false }))
      .toBe('成本单位必须与库存单位一致（成本单位需为最小单位）')
  })
})

describe('lockCostUnitToMinimum', () => {
  it('mirrors the inventory unit and pins the cost factor to 1', () => {
    const locked = lockCostUnitToMinimum({
      purchaseUnit: '件',
      inventoryUnit: 'g',
      orderUnit: '件',
      costUnit: '件',
      inventoryUnitsPerPurchaseUnit: '1000',
      inventoryUnitsPerOrderUnit: '1000',
      inventoryUnitsPerCostUnit: '1000',
    })
    expect(locked.costUnit).toBe('g')
    expect(locked.inventoryUnitsPerCostUnit).toBe('1')
    expect(locked.inventoryUnit).toBe('g')
    expect(locked.purchaseUnit).toBe('件')
  })

  it('produces a form that passes four-unit validation', () => {
    const locked = lockCostUnitToMinimum({
      purchaseUnit: '件',
      inventoryUnit: 'g',
      orderUnit: '件',
      costUnit: '件',
      inventoryUnitsPerPurchaseUnit: '1000',
      inventoryUnitsPerOrderUnit: '1000',
      inventoryUnitsPerCostUnit: '1000',
    })
    expect(validateFourUnitForm(locked)).toBeNull()
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

  it('submits nothing when a legacy cost-unit product is edited without touching units', () => {
    // 回归（2026-08-18）：costUnit=箱 / inventoryUnit=g 的历史档案，
    // 编辑弹窗必须原样加载——若被 lockCostUnitToMinimum 归一，
    // 这里会产出 costUnit/inventoryUnitsPerCostUnit 变更并被后端护栏拦死。
    const product = {
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '箱',
      costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: 15000,
      inventoryUnitsPerOrderUnit: 15000,
      inventoryUnitsPerCostUnit: 15000,
    }
    const loadedForm = fourUnitFormFromProduct(product)
    expect(loadedForm.costUnit).toBe('箱')
    expect(loadedForm.inventoryUnitsPerCostUnit).toBe('15000')
    const body = buildFourUnitEditBody(loadedForm, fourUnitFormFromProduct(product))
    expect(body).toEqual({})
  })
})

describe('inferUnitContractStatus', () => {
  it('returns INFERRED for legacy products without new fields', () => {
    expect(inferUnitContractStatus({ unit: '斤', inventoryUnitsPerPurchaseUnit: 1 })).toBe('INFERRED')
  })

  it('returns VERIFIED for complete and valid four-unit contract', () => {
    expect(inferUnitContractStatus({
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: 10,
      inventoryUnitsPerOrderUnit: 0.5,
      inventoryUnitsPerCostUnit: 1,
    })).toBe('VERIFIED')
  })

  it('returns PENDING when a unit is missing', () => {
    expect(inferUnitContractStatus({
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '',
      costUnit: '斤',
      inventoryUnitsPerOrderUnit: 0.5,
      inventoryUnitsPerCostUnit: 1,
    })).toBe('PENDING')
  })

  it('returns PENDING when a factor is non-positive', () => {
    expect(inferUnitContractStatus({
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerOrderUnit: 0,
      inventoryUnitsPerCostUnit: 1,
    })).toBe('PENDING')
  })

  it('returns PENDING when a factor is not finite', () => {
    expect(inferUnitContractStatus({
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerOrderUnit: NaN,
      inventoryUnitsPerCostUnit: 1,
    })).toBe('PENDING')
  })

  it('keeps the persisted PENDING status even when all fields look complete', () => {
    expect(inferUnitContractStatus({
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: 10,
      inventoryUnitsPerOrderUnit: 0.5,
      inventoryUnitsPerCostUnit: 1,
      unitConversionStatus: 'PENDING',
    })).toBe('PENDING')
  })
})

describe('computeOrderUnitPrice', () => {
  it('converts 500g price from 斤 cost', () => {
    // 1 斤 = 1 库存单位，1 500g = 0.5 库存单位，价格 10 元/斤
    const values = buildFourUnitValues({
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: '10',
      inventoryUnitsPerOrderUnit: '0.5',
      inventoryUnitsPerCostUnit: '1',
    })
    expect(computeOrderUnitPrice(10, values)).toBe(5)
  })

  it('keeps same price for same unit 1:1', () => {
    const values = buildFourUnitValues(DEFAULT_FOUR_UNIT_FORM)
    expect(computeOrderUnitPrice(12.5, values)).toBe(12.5)
  })

  it('handles six-decimal factors', () => {
    const values = buildFourUnitValues({
      purchaseUnit: '箱',
      inventoryUnit: 'kg',
      orderUnit: 'g',
      costUnit: 'kg',
      inventoryUnitsPerPurchaseUnit: '1',
      inventoryUnitsPerOrderUnit: '0.001234',
      inventoryUnitsPerCostUnit: '1',
    })
    expect(computeOrderUnitPrice(1000, values)).toBeCloseTo(1.234, 6)
  })

  it('returns null for negative cost unit price', () => {
    const values = buildFourUnitValues(DEFAULT_FOUR_UNIT_FORM)
    expect(computeOrderUnitPrice(-1, values)).toBeNull()
  })

  it('returns null for non-finite price', () => {
    const values = buildFourUnitValues(DEFAULT_FOUR_UNIT_FORM)
    expect(computeOrderUnitPrice(NaN, values)).toBeNull()
    expect(computeOrderUnitPrice(Infinity, values)).toBeNull()
  })

  it('returns null when order factor is not positive finite', () => {
    const values: import('./supply-product-four-units').FourUnitValues = {
      purchaseUnit: '件',
      inventoryUnit: '件',
      orderUnit: '件',
      costUnit: '件',
      inventoryUnitsPerPurchaseUnit: 1,
      inventoryUnitsPerOrderUnit: 0,
      inventoryUnitsPerCostUnit: 1,
    }
    expect(computeOrderUnitPrice(10, values)).toBeNull()
  })
})

describe('formatOrderUnitPriceHint', () => {
  it('shows 约 ¥x / orderUnit for different units', () => {
    expect(formatOrderUnitPriceHint(10, {
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: '10',
      inventoryUnitsPerOrderUnit: '0.5',
      inventoryUnitsPerCostUnit: '1',
    })).toBe('约 ¥5.00 / 500g')
  })

  it('returns null for same unit to avoid noise', () => {
    expect(formatOrderUnitPriceHint(10, DEFAULT_FOUR_UNIT_FORM)).toBeNull()
  })

  it('shows 待核验 for invalid factors when units differ', () => {
    expect(formatOrderUnitPriceHint(10, {
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: '1',
      inventoryUnitsPerOrderUnit: '0',
      inventoryUnitsPerCostUnit: '1',
    })).toBe('待核验')
  })

  it('shows 待核验 for a persisted PENDING contract', () => {
    expect(formatOrderUnitPriceHint(10, {
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: '10',
      inventoryUnitsPerOrderUnit: '0.5',
      inventoryUnitsPerCostUnit: '1',
      unitConversionStatus: 'PENDING',
    })).toBe('待核验')
  })

  it('shows 待核验 for non-finite factors when units differ', () => {
    expect(formatOrderUnitPriceHint(10, {
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerOrderUnit: NaN,
      inventoryUnitsPerCostUnit: 1,
    })).toBe('待核验')
  })

  it('rounds to 2 decimal places in zh-CN format', () => {
    expect(formatOrderUnitPriceHint(10, {
      purchaseUnit: '箱',
      inventoryUnit: '斤',
      orderUnit: '500g',
      costUnit: '斤',
      inventoryUnitsPerPurchaseUnit: '1',
      inventoryUnitsPerOrderUnit: '0.333333',
      inventoryUnitsPerCostUnit: '1',
    })).toBe('约 ¥3.33 / 500g')
  })
})

describe('parseSpecConversion', () => {
  it('parses 箱/150g*50包 (秘制底料真实规格)', () => {
    expect(parseSpecConversion('箱/150g*50包')).toEqual({ inventoryUnit: 'g', factor: 7500 })
  })

  it('parses 箱/2.5kg*8袋 (水牛毛肚真实规格)', () => {
    expect(parseSpecConversion('箱/2.5kg*8袋')).toEqual({ inventoryUnit: 'g', factor: 20000 })
  })

  it('parses 件/1000g', () => {
    expect(parseSpecConversion('件/1000g')).toEqual({ inventoryUnit: 'g', factor: 1000 })
  })

  it('parses 箱/2kg*10袋 (汤底调味粉真实规格)', () => {
    expect(parseSpecConversion('箱/2kg*10袋')).toEqual({ inventoryUnit: 'g', factor: 20000 })
  })

  it('parses volume specs', () => {
    expect(parseSpecConversion('箱/330ml*24瓶')).toEqual({ inventoryUnit: 'ml', factor: 7920 })
    expect(parseSpecConversion('桶/5L')).toEqual({ inventoryUnit: 'ml', factor: 5000 })
  })

  it('parses 斤 as 500g', () => {
    expect(parseSpecConversion('件/10斤')).toEqual({ inventoryUnit: 'g', factor: 5000 })
  })

  it('returns null when spec has no net content', () => {
    expect(parseSpecConversion('箱/24瓶')).toBeNull()
    expect(parseSpecConversion('')).toBeNull()
    expect(parseSpecConversion(null)).toBeNull()
    expect(parseSpecConversion('箱')).toBeNull()
  })
})

describe('isSimpleFourUnitContract', () => {
  it('accepts uniform 箱 contract', () => {
    expect(isSimpleFourUnitContract(buildFourUnitValues(DEFAULT_FOUR_UNIT_FORM))).toBe(true)
  })

  it('accepts 箱采购/克库存 contract (order follows purchase, cost follows inventory)', () => {
    expect(isSimpleFourUnitContract(buildFourUnitValues({
      purchaseUnit: '箱', orderUnit: '箱', inventoryUnit: 'g', costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '7500', inventoryUnitsPerOrderUnit: '7500',
      inventoryUnitsPerCostUnit: '1',
    }))).toBe(true)
  })

  it('rejects legacy costUnit≠inventoryUnit archives', () => {
    expect(isSimpleFourUnitContract(buildFourUnitValues({
      purchaseUnit: '箱', orderUnit: '箱', inventoryUnit: 'g', costUnit: '箱',
      inventoryUnitsPerPurchaseUnit: '15000', inventoryUnitsPerOrderUnit: '15000',
      inventoryUnitsPerCostUnit: '15000',
    }))).toBe(false)
  })

  it('rejects distinct order unit', () => {
    expect(isSimpleFourUnitContract(buildFourUnitValues({
      purchaseUnit: '箱', orderUnit: '袋', inventoryUnit: 'g', costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '7500', inventoryUnitsPerOrderUnit: '150',
      inventoryUnitsPerCostUnit: '1',
    }))).toBe(false)
  })
})
