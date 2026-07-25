import { describe, expect, it } from 'vitest'
import { receiptListFilterSchema, buildReceiptListWhere } from '../../src/routes/receipts'

const baseUser = { tenantId: 'tenant-1', role: 'ADMIN' } as const
const supplierUser = { tenantId: 'tenant-1', role: 'SUPPLIER_OWNER', supplierId: 'sup-1' } as const
const managerUser = { tenantId: 'tenant-1', role: 'MANAGER', storeId: 'store-1' } as const
const unboundManagerUser = { tenantId: 'tenant-1', role: 'MANAGER' } as const

describe('receipt list filter schema', () => {
  it('accepts empty query and applies defaults', () => {
    const result = receiptListFilterSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(1)
      expect(result.data.pageSize).toBe(20)
      expect(result.data.status).toBeUndefined()
      expect(result.data.keyword).toBeUndefined()
      expect(result.data.dateFrom).toBeUndefined()
      expect(result.data.dateTo).toBeUndefined()
    }
  })

  it('coerces empty-string status to undefined', () => {
    const result = receiptListFilterSchema.safeParse({ status: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.status).toBeUndefined()
  })

  it('accepts every valid receipt status', () => {
    for (const status of ['DRAFT', 'PENDING', 'PENDING_CONFIRM', 'CONFIRMED', 'ACCOUNTED', 'VOID', 'REJECTED'] as const) {
      const result = receiptListFilterSchema.safeParse({ status })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.status).toBe(status)
    }
  })

  it('rejects invalid status', () => {
    expect(receiptListFilterSchema.safeParse({ status: 'INVALID' }).success).toBe(false)
  })

  it('trims keyword and rejects over-length', () => {
    const ok = receiptListFilterSchema.safeParse({ keyword: '  白菜  ' })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.keyword).toBe('白菜')

    const tooLong = receiptListFilterSchema.safeParse({ keyword: 'a'.repeat(81) })
    expect(tooLong.success).toBe(false)
  })

  it('accepts valid dateFrom / dateTo', () => {
    const result = receiptListFilterSchema.safeParse({ dateFrom: '2026-07-01', dateTo: '2026-07-25' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.dateFrom).toBe('2026-07-01')
      expect(result.data.dateTo).toBe('2026-07-25')
    }
  })

  it('rejects invalid date format', () => {
    expect(receiptListFilterSchema.safeParse({ dateFrom: '2026/07/01' }).success).toBe(false)
    expect(receiptListFilterSchema.safeParse({ dateTo: 'not-a-date' }).success).toBe(false)
  })

  it('rejects impossible calendar dates', () => {
    expect(receiptListFilterSchema.safeParse({ dateFrom: '2026-02-29' }).success).toBe(false)
    expect(receiptListFilterSchema.safeParse({ dateTo: '2026-04-31' }).success).toBe(false)
  })

  it('rejects dateFrom > dateTo', () => {
    const result = receiptListFilterSchema.safeParse({ dateFrom: '2026-07-20', dateTo: '2026-07-15' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('dateFrom')
    }
  })

  it('accepts dateFrom == dateTo (same-day range)', () => {
    const result = receiptListFilterSchema.safeParse({ dateFrom: '2026-07-15', dateTo: '2026-07-15' })
    expect(result.success).toBe(true)
  })

  it('coerces page / pageSize from strings', () => {
    const result = receiptListFilterSchema.safeParse({ page: '3', pageSize: '50' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(3)
      expect(result.data.pageSize).toBe(50)
    }
  })

  it('rejects page <= 0 or non-integer', () => {
    expect(receiptListFilterSchema.safeParse({ page: '0' }).success).toBe(false)
    expect(receiptListFilterSchema.safeParse({ page: '1.5' }).success).toBe(false)
  })

  it('rejects pageSize > 100', () => {
    expect(receiptListFilterSchema.safeParse({ pageSize: '101' }).success).toBe(false)
  })
})

describe('buildReceiptListWhere', () => {
  it('always includes tenantId', () => {
    const q = receiptListFilterSchema.parse({})
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.tenantId).toBe('tenant-1')
  })

  it('applies status filter', () => {
    const q = receiptListFilterSchema.parse({ status: 'CONFIRMED' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.status).toBe('CONFIRMED')
  })

  it('forces supplier scope for supplier role', () => {
    const q = receiptListFilterSchema.parse({})
    const where = buildReceiptListWhere(q, supplierUser)
    expect(where.supplierId).toBe('sup-1')
  })

  it('ignores query supplierId for supplier role', () => {
    const q = receiptListFilterSchema.parse({ supplierId: 'other-sup' })
    const where = buildReceiptListWhere(q, supplierUser)
    expect(where.supplierId).toBe('sup-1')
  })

  it('applies query supplierId for non-supplier role', () => {
    const q = receiptListFilterSchema.parse({ supplierId: 'target-sup' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.supplierId).toBe('target-sup')
  })

  it('forces store scope for store-scoped role', () => {
    const q = receiptListFilterSchema.parse({})
    const where = buildReceiptListWhere(q, managerUser)
    expect(where.storeId).toBe('store-1')
  })

  it('ignores query storeId for store-scoped role', () => {
    const q = receiptListFilterSchema.parse({ storeId: 'other-store' })
    const where = buildReceiptListWhere(q, managerUser)
    expect(where.storeId).toBe('store-1')
  })

  it('fails closed when a store-scoped role has no store binding', () => {
    const q = receiptListFilterSchema.parse({})
    const where = buildReceiptListWhere(q, unboundManagerUser)
    expect(where.storeId).toBe('__NONE__')
  })

  it('applies query storeId for admin role', () => {
    const q = receiptListFilterSchema.parse({ storeId: 'target-store' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.storeId).toBe('target-store')
  })

  it('builds keyword OR with snapshot and current product fields', () => {
    const q = receiptListFilterSchema.parse({ keyword: '松茸' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.AND).toBeDefined()
    expect(where.AND).toHaveLength(1)
    const orClause = where.AND[0].OR
    expect(orClause).toBeDefined()
    const itemsSome = orClause.find((c: any) => c.items?.some)
    expect(itemsSome).toBeDefined()
    const innerOR = itemsSome.items.some.OR
    const snapshotFields = innerOR.map((c: any) => Object.keys(c)[0])
    expect(snapshotFields).toContain('productNameSnapshot')
    expect(snapshotFields).toContain('productCodeSnapshot')
    expect(snapshotFields).toContain('productSpecSnapshot')
    const productRelation = innerOR.find((c: any) => c.product)
    expect(productRelation).toBeDefined()
    expect(productRelation.product.OR).toHaveLength(3)
  })

  it('matches receipt no and store name in keyword OR', () => {
    const q = receiptListFilterSchema.parse({ keyword: 'RK2026' })
    const where = buildReceiptListWhere(q, baseUser)
    const orClause = where.AND[0].OR
    expect(orClause).toEqual(
      expect.arrayContaining([
        { no: { contains: 'RK2026', mode: 'insensitive' } },
        { store: { name: { contains: 'RK2026', mode: 'insensitive' } } },
      ]),
    )
  })

  it('omits AND when no keyword', () => {
    const q = receiptListFilterSchema.parse({ status: 'DRAFT' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.AND).toBeUndefined()
  })

  it('builds date range on the business delivery date', () => {
    const q = receiptListFilterSchema.parse({ dateFrom: '2026-07-01', dateTo: '2026-07-25' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.deliveryDate).toBeDefined()
    expect(where.deliveryDate.gte).toEqual(new Date('2026-07-01T00:00:00.000Z'))
    expect(where.deliveryDate.lte).toEqual(new Date('2026-07-25T00:00:00.000Z'))
  })

  it('supports dateFrom only', () => {
    const q = receiptListFilterSchema.parse({ dateFrom: '2026-07-01' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.deliveryDate.gte).toBeDefined()
    expect(where.deliveryDate.lte).toBeUndefined()
  })

  it('supports dateTo only', () => {
    const q = receiptListFilterSchema.parse({ dateTo: '2026-07-25' })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.deliveryDate.lte).toBeDefined()
    expect(where.deliveryDate.gte).toBeUndefined()
  })

  it('combines keyword, date, status and scope', () => {
    const q = receiptListFilterSchema.parse({
      keyword: '松茸', dateFrom: '2026-07-01', dateTo: '2026-07-25', status: 'CONFIRMED', storeId: 's1',
    })
    const where = buildReceiptListWhere(q, baseUser)
    expect(where.tenantId).toBe('tenant-1')
    expect(where.status).toBe('CONFIRMED')
    expect(where.storeId).toBe('s1')
    expect(where.AND).toHaveLength(1)
    expect(where.deliveryDate).toBeDefined()
  })
})
