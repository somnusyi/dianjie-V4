import { describe, expect, it, vi } from 'vitest'
import {
  businessNoFloor,
  buildOrderSnapshot,
  diffOrderSnapshots,
  lineAmount,
  nextBusinessNo,
  revisionType,
  snapshotHash,
  sumOrderAmount,
} from '../../src/services/purchaseOrderIntegrity'

const baseOrder = () => ({
  no: 'PO202607000001',
  tenantId: 'tenant-1',
  storeId: 'store-1',
  supplierId: 'supplier-1',
  expectedDate: new Date('2026-07-16T00:00:00.000Z'),
  note: '上午送达',
  submittedAt: new Date('2026-07-15T01:00:00.000Z'),
  createdAt: new Date('2026-07-15T01:00:00.000Z'),
  currentRevisionNo: 0,
  store: { id: 'store-1', name: '瑶海店' },
  supplier: { id: 'supplier-1', name: '测试供应商' },
  createdBy: { id: 'user-1', name: '店长', role: 'MANAGER' },
  items: [
    {
      id: 'line-1', productId: 'product-1', quantity: '10.00', unitPrice: '3.33', amount: '33.30',
      originalQuantity: '10.00', originalUnitPrice: '3.33', originalAmount: '33.30',
      lineOrigin: 'ORIGINAL' as const, isActive: true,
      product: { code: 'SKU-1', name: '土豆', spec: '一级', unit: 'kg' },
    },
  ],
})

describe('purchase order integrity', () => {
  it('uses decimal arithmetic for line and order totals', () => {
    expect(lineAmount('0.10', '0.20').toFixed(2)).toBe('0.02')
    expect(sumOrderAmount([
      { quantity: '3', unitPrice: '0.10' },
      { quantity: '7', unitPrice: '0.10' },
    ]).toFixed(2)).toBe('1.00')
  })

  it('keeps the original snapshot stable when current quantities change', () => {
    const order = baseOrder()
    const before = buildOrderSnapshot(order, 'original')
    order.items[0].quantity = '8.00'
    order.items[0].amount = '26.64'
    const after = buildOrderSnapshot(order, 'original')
    expect(after).toEqual(before)
    expect(snapshotHash(after)).toBe(snapshotHash(before))
  })

  it('hashes canonical snapshot objects deterministically', () => {
    const snapshot = buildOrderSnapshot(baseOrder(), 'original')
    const reordered = JSON.parse(JSON.stringify(snapshot))
    reordered.createdBy = { role: snapshot.createdBy.role, name: snapshot.createdBy.name, id: snapshot.createdBy.id }
    expect(snapshotHash(reordered)).toBe(snapshotHash(snapshot))
  })

  it('detects quantity, item, date and note changes', () => {
    const before = buildOrderSnapshot(baseOrder(), 'current')
    const after = {
      ...before,
      expectedDate: '2026-07-17',
      note: '下午送达',
      items: [
        { ...before.items[0], quantity: '8.00', amount: '26.64' },
        {
          lineId: 'revision:product-2', productId: 'product-2', code: 'SKU-2', name: '青椒', spec: null,
          unit: 'kg', quantity: '2.00', unitPrice: '4.00', amount: '8.00', lineOrigin: 'APPROVED_REVISION' as const,
        },
      ],
      totalAmount: '34.64',
      revisionNo: 1,
    }
    const changes = diffOrderSnapshots(before, after)
    expect(changes.map(change => change.kind).sort()).toEqual([
      'ADD_ITEM', 'CHANGE_EXPECTED_DATE', 'CHANGE_NOTE', 'CHANGE_QTY',
    ])
    expect(revisionType(changes)).toBe('MIXED')
  })

  it('excludes approved revision lines from the original snapshot', () => {
    const order = baseOrder()
    order.items.push({
      id: 'line-2', productId: 'product-2', quantity: '2.00', unitPrice: '4.00', amount: '8.00',
      originalQuantity: null as any, originalUnitPrice: null as any, originalAmount: null as any,
      lineOrigin: 'APPROVED_REVISION' as const, isActive: true,
      product: { code: 'SKU-2', name: '青椒', spec: '', unit: 'kg' },
    })
    expect(buildOrderSnapshot(order, 'original').items).toHaveLength(1)
    expect(buildOrderSnapshot(order, 'current').items).toHaveLength(2)
  })

  it('starts a new business sequence above historical document numbers', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const upsert = vi.fn().mockResolvedValue({ value: 43 })
    const tx = { businessSequence: { updateMany, upsert } } as any

    const no = await nextBusinessNo(tx, 'tenant-1', 'RECEIPT', '202607', 'RK', 42)

    expect(no).toBe('RK202607000043')
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', scope: 'RECEIPT', period: '202607', value: { lt: 42 } },
      data: { value: 42 },
    })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ value: 43 }),
    }))
  })

  it('extracts the historical floor from a current-period business number', () => {
    expect(businessNoFloor('PO202607000016', 'PO', '202607')).toBe(16)
    expect(businessNoFloor('PO202606000999', 'PO', '202607')).toBe(0)
    expect(businessNoFloor('PO202607BAD', 'PO', '202607')).toBe(0)
    expect(businessNoFloor(null, 'PO', '202607')).toBe(0)
  })
})
