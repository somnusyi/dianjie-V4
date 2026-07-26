import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WAREHOUSE_ID,
  DEFAULT_WAREHOUSE_NAME,
  assertInboundWarehouseResponse,
  assertRealWarehouseResponse,
  resolveWarehouseDisplayName,
  withSupplierWarehouseParams,
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

describe('withSupplierWarehouseParams', () => {
  it('appends supplierId and warehouseId=default to a bare path', () => {
    const result = withSupplierWarehouseParams('/api/supplier/stock/inbound', 'sup-1')
    expect(result).toContain('supplierId=sup-1')
    expect(result).toContain('warehouseId=default')
    expect(result.startsWith('/api/supplier/stock/inbound?')).toBe(true)
  })

  it('preserves existing query params while overriding supplierId and warehouseId', () => {
    const result = withSupplierWarehouseParams('/api/supplier/stock/inbound?page=1', 'sup-1')
    expect(result).toContain('supplierId=sup-1')
    expect(result).toContain('warehouseId=default')
    expect(result).toContain('page=1')
  })

  it('overrides an existing supplierId', () => {
    const result = withSupplierWarehouseParams('/api/supplier/stock/inbound?supplierId=old', 'sup-1')
    expect(result).toContain('supplierId=sup-1')
    expect(result).not.toContain('supplierId=old')
  })

  it('overrides an existing warehouseId with default', () => {
    const result = withSupplierWarehouseParams('/api/supplier/stock/inbound?warehouseId=other', 'sup-1')
    expect(result).toContain('warehouseId=default')
    expect(result).not.toContain('warehouseId=other')
  })

  it('url-encodes supplierId', () => {
    const result = withSupplierWarehouseParams('/api/supplier/stock/inbound', 'sup 测试')
    expect(result).toContain('supplierId=sup+%E6%B5%8B%E8%AF%95')
  })

  it('trims supplierId and rejects an empty selection', () => {
    const result = withSupplierWarehouseParams('/api/supplier/stock/inbound', '  sup-1  ')
    expect(new URL(result, 'http://localhost').searchParams.get('supplierId')).toBe('sup-1')
    expect(() => withSupplierWarehouseParams('/api/supplier/stock/inbound', '   ')).toThrow(
      '入库前必须选择供应商',
    )
  })

  it('does not mutate the original string', () => {
    const original = '/api/supplier/stock/inbound'
    const copy = original
    withSupplierWarehouseParams(original, 'sup-1')
    expect(original).toBe(copy)
  })
})

describe('assertInboundWarehouseResponse', () => {
  it('returns warehouseId and warehouseName for a valid real-warehouse response', () => {
    const result = assertInboundWarehouseResponse({
      ok: true,
      count: 1,
      warehouseId: 'wh-real-001',
      warehouse: { id: 'wh-real-001', name: '主仓' },
    })
    expect(result).toEqual({ warehouseId: 'wh-real-001', warehouseName: '主仓' })
  })

  it('throws when warehouseId is missing', () => {
    expect(() =>
      assertInboundWarehouseResponse({ ok: true, warehouse: { id: 'wh-real', name: '主仓' } }),
    ).toThrow('入库响应未返回真实仓库 ID')
  })

  it('throws when warehouseId is still the default alias', () => {
    expect(() =>
      assertInboundWarehouseResponse({
        ok: true,
        warehouseId: 'default',
        warehouse: { id: 'default', name: '默认仓' },
      }),
    ).toThrow('入库响应未返回真实仓库 ID')
  })

  it('trims IDs before rejecting a whitespace-padded default alias', () => {
    expect(() =>
      assertInboundWarehouseResponse({
        ok: true,
        warehouseId: ' default ',
        warehouse: { id: ' default ', name: '默认仓' },
      }),
    ).toThrow('入库响应未返回真实仓库 ID')
  })

  it('throws when warehouse is missing', () => {
    expect(() =>
      assertInboundWarehouseResponse({ ok: true, warehouseId: 'wh-real-001' }),
    ).toThrow('入库响应缺少仓库元数据')
  })

  it('throws when warehouse.id differs from warehouseId', () => {
    expect(() =>
      assertInboundWarehouseResponse({
        ok: true,
        warehouseId: 'wh-real-001',
        warehouse: { id: 'wh-other', name: '主仓' },
      }),
    ).toThrow('入库响应仓库 ID 不一致')
  })

  it('throws when warehouse.name is empty', () => {
    expect(() =>
      assertInboundWarehouseResponse({
        ok: true,
        warehouseId: 'wh-real-001',
        warehouse: { id: 'wh-real-001', name: '' },
      }),
    ).toThrow('入库响应缺少仓库名称')
  })

  it('throws when warehouse.name is whitespace-only', () => {
    expect(() =>
      assertInboundWarehouseResponse({
        ok: true,
        warehouseId: 'wh-real-001',
        warehouse: { id: 'wh-real-001', name: '   ' },
      }),
    ).toThrow('入库响应缺少仓库名称')
  })

  it('throws when response is not an object', () => {
    expect(() => assertInboundWarehouseResponse(null)).toThrow('入库响应格式异常')
    expect(() => assertInboundWarehouseResponse('ok')).toThrow('入库响应格式异常')
    expect(() => assertInboundWarehouseResponse([])).toThrow('入库响应格式异常')
  })

  it('returns normalized warehouse values', () => {
    expect(
      assertInboundWarehouseResponse({
        ok: true,
        warehouseId: ' wh-real-001 ',
        warehouse: { id: 'wh-real-001', name: ' 主仓 ' },
      }),
    ).toEqual({ warehouseId: 'wh-real-001', warehouseName: '主仓' })
  })
})

describe('assertRealWarehouseResponse', () => {
  it('returns warehouseId and warehouseName for a valid real-warehouse response', () => {
    const result = assertRealWarehouseResponse({
      warehouseId: 'wh-real-001',
      warehouse: { id: 'wh-real-001', name: '默认总仓' },
    })
    expect(result).toEqual({ warehouseId: 'wh-real-001', warehouseName: '默认总仓' })
  })

  it('rejects the default alias', () => {
    expect(() =>
      assertRealWarehouseResponse({
        warehouseId: 'default',
        warehouse: { id: 'default', name: '默认仓' },
      }),
    ).toThrow('响应未返回真实仓库 ID')
  })

  it('rejects mismatched warehouse.id', () => {
    expect(() =>
      assertRealWarehouseResponse({
        warehouseId: 'wh-real-001',
        warehouse: { id: 'wh-other', name: '默认总仓' },
      }),
    ).toThrow('响应仓库 ID 不一致')
  })

  it('rejects empty warehouse name', () => {
    expect(() =>
      assertRealWarehouseResponse({
        warehouseId: 'wh-real-001',
        warehouse: { id: 'wh-real-001', name: '' },
      }),
    ).toThrow('响应缺少仓库名称')
  })

  it('rejects non-object response', () => {
    expect(() => assertRealWarehouseResponse(null)).toThrow('响应格式异常')
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
