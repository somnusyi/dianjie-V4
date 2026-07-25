import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAREHOUSE_ID,
  DEFAULT_WAREHOUSE_NAME,
  resolveWarehouseDisplayName,
  withWarehouseBody,
  withWarehouseParam,
} from './supplier-default-warehouse'

describe('constants', () => {
  it('exposes the canonical warehouse id and display name', () => {
    expect(DEFAULT_WAREHOUSE_ID).toBe('default')
    expect(DEFAULT_WAREHOUSE_NAME).toBe('默认仓')
  })
})

describe('withWarehouseParam', () => {
  it('appends warehouseId to a bare path', () => {
    expect(withWarehouseParam('/api/supplier/stock'))
      .toBe('/api/supplier/stock?warehouseId=default')
  })

  it('appends warehouseId to a path with existing query params', () => {
    const result = withWarehouseParam('/api/supplier/stock?page=1&pageSize=50')
    expect(result).toContain('warehouseId=default')
    expect(result).toContain('page=1')
    expect(result).toContain('pageSize=50')
  })

  it('overrides an existing warehouseId value', () => {
    const result = withWarehouseParam('/api/supplier/stock?warehouseId=other&page=1')
    expect(result).toContain('warehouseId=default')
    expect(result).not.toContain('warehouseId=other')
    expect(result).toContain('page=1')
  })

  it('handles URL-encoded special characters in existing params', () => {
    const result = withWarehouseParam('/api/supplier/stock?q=%E8%8C%84%E5%AD%90&page=1')
    expect(result).toContain('warehouseId=default')
    expect(result).toContain('q=%E8%8C%84%E5%AD%90')
  })

  it('does not mutate the original string', () => {
    const original = '/api/supplier/stock?page=1'
    const copy = original
    withWarehouseParam(original)
    expect(original).toBe(copy)
  })

  it('handles a path with an empty query string', () => {
    const result = withWarehouseParam('/api/supplier/stock?')
    expect(result).toContain('warehouseId=default')
  })
})

describe('withWarehouseBody', () => {
  it('adds warehouseId to a plain object body', () => {
    const body = { productId: 'p1', newQty: 10, reason: '盘点' }
    const result = withWarehouseBody(body)
    expect(result.warehouseId).toBe('default')
    expect(result.productId).toBe('p1')
  })

  it('does not mutate the original body', () => {
    const body = { productId: 'p1', newQty: 10 }
    const snapshot = { ...body }
    withWarehouseBody(body)
    expect(body).toEqual(snapshot)
    expect(body).not.toHaveProperty('warehouseId')
  })

  it('overrides an existing warehouseId in the body', () => {
    const body = { items: [], source: 'MANUAL', warehouseId: 'old' }
    const result = withWarehouseBody(body)
    expect(result.warehouseId).toBe('default')
  })

  it('returns non-object values unchanged', () => {
    expect(withWarehouseBody(null as any)).toBeNull()
    expect(withWarehouseBody(undefined as any)).toBeUndefined()
  })

  it('returns arrays unchanged', () => {
    const arr = [1, 2, 3]
    expect(withWarehouseBody(arr as any)).toBe(arr)
  })

  it('preserves all original keys', () => {
    const body = { items: [{ productId: 'p1', qty: 5 }], source: 'EXCEL', reason: 'test' }
    const result = withWarehouseBody(body)
    expect(result.items).toEqual(body.items)
    expect(result.source).toBe('EXCEL')
    expect(result.reason).toBe('test')
    expect(result.warehouseId).toBe('default')
  })
})

describe('resolveWarehouseDisplayName', () => {
  it('returns the server name when warehouse metadata is valid', () => {
    expect(resolveWarehouseDisplayName({ id: 'default', name: '主仓' })).toBe('主仓')
  })

  it('falls back to 默认仓 for null', () => {
    expect(resolveWarehouseDisplayName(null)).toBe('默认仓')
  })

  it('falls back to 默认仓 for undefined', () => {
    expect(resolveWarehouseDisplayName(undefined)).toBe('默认仓')
  })

  it('falls back to 默认仓 for empty name', () => {
    expect(resolveWarehouseDisplayName({ id: 'default', name: '' })).toBe('默认仓')
  })

  it('falls back to 默认仓 for whitespace-only name', () => {
    expect(resolveWarehouseDisplayName({ id: 'default', name: '   ' })).toBe('默认仓')
  })

  it('falls back to 默认仓 for non-object', () => {
    expect(resolveWarehouseDisplayName('default')).toBe('默认仓')
    expect(resolveWarehouseDisplayName(42)).toBe('默认仓')
  })

  it('falls back to 默认仓 for array', () => {
    expect(resolveWarehouseDisplayName([{ name: 'test' }])).toBe('默认仓')
  })

  it('falls back to 默认仓 when name is not a string', () => {
    expect(resolveWarehouseDisplayName({ id: 'default', name: 123 })).toBe('默认仓')
  })
})
