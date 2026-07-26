import { describe, expect, it } from 'vitest'
import {
  PRODUCT_QUANTITY_MAX,
  productMinOrderQuantityCreateSchema,
  productMinOrderQuantityPatchSchema,
  productMinStockCreateSchema,
  productStepQuantityCreateSchema,
  productStepQuantityPatchSchema,
  productStockCreateSchema,
} from '../../src/services/productQuantity'

const createSchemas = [
  productStockCreateSchema,
  productMinStockCreateSchema,
  productMinOrderQuantityCreateSchema,
  productStepQuantityCreateSchema,
]

describe('product quantity API validation', () => {
  it.each([0.001, 1.001, 1.23, Number(PRODUCT_QUANTITY_MAX)])(
    'accepts a JSON number with at most three decimal places: %s',
    value => {
      for (const schema of createSchemas) {
        expect(schema.safeParse(value)).toMatchObject({ success: true, data: value })
      }
    },
  )

  it('treats numeric exponent notation by its parsed JSON number value', () => {
    const parsedJsonNumber = JSON.parse('1e-3')

    expect(parsedJsonNumber).toBe(0.001)
    for (const schema of createSchemas) {
      expect(schema.safeParse(parsedJsonNumber)).toMatchObject({ success: true, data: 0.001 })
    }
  })

  it.each([0.0001, 1.0001, 1.2345])('rejects four decimal places: %s', value => {
    for (const schema of createSchemas) {
      expect(schema.safeParse(value).success).toBe(false)
    }
  })

  it('enforces nonnegative stock and strictly positive order quantities', () => {
    expect(productStockCreateSchema.safeParse(0).success).toBe(true)
    expect(productMinStockCreateSchema.safeParse(0).success).toBe(true)
    expect(productMinOrderQuantityCreateSchema.safeParse(0).success).toBe(false)
    expect(productMinOrderQuantityPatchSchema.safeParse(0).success).toBe(false)
    expect(productStepQuantityPatchSchema.safeParse(0).success).toBe(false)

    for (const schema of createSchemas) {
      expect(schema.safeParse(-0.001).success).toBe(false)
    }
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite numbers instead of defaulting: %s', value => {
    for (const schema of createSchemas) {
      expect(schema.safeParse(value).success).toBe(false)
    }
  })

  it.each(['0.001', '1', '1e-3'])('rejects numeric strings: %s', value => {
    for (const schema of createSchemas) {
      expect(schema.safeParse(value).success).toBe(false)
    }
  })

  it('rejects values above the exact upper bound', () => {
    for (const schema of createSchemas) {
      expect(schema.safeParse(1_000_000_000).success).toBe(false)
    }
  })

  it('keeps create defaults for null and empty strings', () => {
    expect(productStockCreateSchema.parse(null)).toBe(0)
    expect(productMinStockCreateSchema.parse('')).toBe(0)
    expect(productMinOrderQuantityCreateSchema.parse(null)).toBe(1)
    expect(productStepQuantityCreateSchema.parse('')).toBe(1)
  })

  it('keeps the create-only step zero compatibility default', () => {
    expect(productStepQuantityCreateSchema.parse(0)).toBe(1)
    expect(productStepQuantityPatchSchema.safeParse(0).success).toBe(false)
  })

  it('applies the same precision and maximum to editable PATCH quantities', () => {
    for (const schema of [productMinOrderQuantityPatchSchema, productStepQuantityPatchSchema]) {
      expect(schema.safeParse(undefined).success).toBe(true)
      expect(schema.safeParse(1.001).success).toBe(true)
      expect(schema.safeParse(Number(PRODUCT_QUANTITY_MAX)).success).toBe(true)
      expect(schema.safeParse(1.0001).success).toBe(false)
      expect(schema.safeParse(-0.001).success).toBe(false)
      expect(schema.safeParse(1_000_000_000).success).toBe(false)
      expect(schema.safeParse('1e-3').success).toBe(false)
      expect(schema.safeParse(NaN).success).toBe(false)
      expect(schema.safeParse(Infinity).success).toBe(false)
    }
  })
})
