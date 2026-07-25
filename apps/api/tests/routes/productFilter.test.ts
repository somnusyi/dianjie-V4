import { describe, expect, it } from 'vitest'
import { productListFilterSchema } from '../../src/routes/products'

describe('product list filter schema', () => {
  it('accepts empty query (no filters)', () => {
    const result = productListFilterSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBeUndefined()
      expect(result.data.status).toBeUndefined()
      expect(result.data.q).toBeUndefined()
    }
  })

  it('passes through category filter', () => {
    const result = productListFilterSchema.safeParse({ category: '蔬菜' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.category).toBe('蔬菜')
  })

  it('passes through status filter for every valid enum value', () => {
    for (const status of ['ENABLED', 'DISABLED', 'PENDING_APPROVAL', 'PENDING_DISABLE'] as const) {
      const result = productListFilterSchema.safeParse({ status })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.status).toBe(status)
    }
  })

  it('coerces empty-string status to undefined', () => {
    const result = productListFilterSchema.safeParse({ status: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBeUndefined()
  })

  it('rejects invalid status values', () => {
    const result = productListFilterSchema.safeParse({ status: 'INVALID' })
    expect(result.success).toBe(false)
  })

  it('passes through search keyword q', () => {
    const result = productListFilterSchema.safeParse({ q: '见手青' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.q).toBe('见手青')
  })

  it('trims whitespace from q', () => {
    const result = productListFilterSchema.safeParse({ q: '  白菜  ' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.q).toBe('白菜')
  })

  it('rejects q exceeding max length', () => {
    const result = productListFilterSchema.safeParse({ q: 'a'.repeat(81) })
    expect(result.success).toBe(false)
  })

  it('accepts combined category + status + q filters', () => {
    const result = productListFilterSchema.safeParse({
      category: '冻品', status: 'ENABLED', q: '虾',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.category).toBe('冻品')
      expect(result.data.status).toBe('ENABLED')
      expect(result.data.q).toBe('虾')
    }
  })

  it('ignores unknown filter fields (passthrough)', () => {
    const result = productListFilterSchema.safeParse({ category: '蔬菜', page: '1', pageSize: '20' })
    expect(result.success).toBe(true)
  })
})
