import { describe, expect, it } from 'vitest'
import {
  applySingleOrderPreview,
  buildSingleOrderPreviewPayload,
  parseSingleOrderPreviewPayload,
  singleOrderServerSignature,
  type SingleDeliveryNoteDraftRow,
  type SingleDeliveryNoteVersionSource,
} from './single-delivery-note-preview'
import {
  buildOperationGroupDeliveryNoteProjection,
  parseOperationGroupDeliveryNoteProjection,
} from './operation-group-delivery-note-preview'

type Phase = 'SUBMITTED' | 'CONFIRMED' | 'DELIVERING'

const detailRows: SingleDeliveryNoteDraftRow[] = [
  {
    key: 'changed',
    itemId: 'line-changed',
    productId: 'product-changed',
    name: '改数量商品',
    spec: null,
    unit: '件',
    quantity: 3,
    unitPrice: 10,
  },
  {
    key: 'zero',
    itemId: 'line-zero',
    productId: 'product-zero',
    name: '零数量商品',
    spec: null,
    unit: '件',
    quantity: 0,
    unitPrice: 20,
  },
  {
    key: 'removed',
    itemId: 'line-removed',
    productId: 'product-removed',
    name: '已移除商品',
    spec: null,
    unit: '件',
    quantity: 1,
    unitPrice: 99,
    pendingRemoval: true,
  },
  {
    key: 'new-added',
    productId: 'product-added',
    name: '新增商品',
    spec: null,
    unit: '盒',
    quantity: 2,
    unitPrice: 7.5,
  },
]

const expectedLines = [
  ['product-changed', 3, 10, 30],
  ['product-zero', 0, 20, 0],
  ['product-added', 2, 7.5, 15],
]

function orderForPhase(phase: Phase): SingleDeliveryNoteVersionSource {
  if (phase === 'SUBMITTED') return { id: 'order-1', rowVersion: 3, status: phase, deliveries: [] }
  if (phase === 'CONFIRMED') {
    return {
      id: 'order-1',
      rowVersion: 4,
      status: phase,
      deliveries: [{ id: 'draft-1', rowVersion: 2, status: 'DRAFT' }],
    }
  }
  return {
    id: 'order-1',
    rowVersion: 5,
    status: phase,
    deliveries: [{ id: 'delivery-1', rowVersion: 3, status: 'SHIPPED', receipt: null }],
  }
}

describe('single-order delivery-note detail consistency', () => {
  it.each<Phase>(['SUBMITTED', 'CONFIRMED', 'DELIVERING'])(
    'projects the current %s detail quantity, removal, addition, and money exactly',
    phase => {
      const order = orderForPhase(phase)
      const payload = buildSingleOrderPreviewPayload({
        order,
        ownerUserId: 'user-1',
        tenantKey: 'tenant-1',
        rows: detailRows,
        now: 1_000,
      })
      const parsed = parseSingleOrderPreviewPayload({
        raw: JSON.stringify(payload),
        orderId: order.id,
        ownerUserId: 'user-1',
        tenantKey: 'tenant-1',
        now: 1_001,
      })

      expect(parsed).not.toBeNull()
      expect(parsed?.serverSignature).toBe(singleOrderServerSignature(order))
      expect(parsed?.items.map(item => [item.productId, item.quantity, item.unitPrice, item.amount]))
        .toEqual(expectedLines)
      expect(parsed?.items.some(item => item.productId === 'product-removed')).toBe(false)
      expect(parsed?.totalAmount).toBe(45)

      const document = applySingleOrderPreview({
        totalAmount: '10000',
        items: [{
          id: 'stale', quantity: '100', shippedQty: '100', unitPrice: '100', amount: '10000',
          product: { name: '不应显示的旧行', spec: null, unit: '件', code: 'stale' },
        }],
      }, parsed!)
      expect(document.items.map(item => [
        item.product?.code,
        Number(item.quantity),
        Number(item.unitPrice),
        Number(item.amount),
      ])).toEqual(expectedLines)
      expect(Number(document.totalAmount)).toBe(45)
    },
  )

  it('rejects a preview whose line amount or total was altered', () => {
    const payload = buildSingleOrderPreviewPayload({
      order: orderForPhase('CONFIRMED'),
      ownerUserId: 'user-1',
      tenantKey: 'tenant-1',
      rows: detailRows,
      now: 1_000,
    })
    const parse = (next: unknown) => parseSingleOrderPreviewPayload({
      raw: JSON.stringify(next),
      orderId: 'order-1',
      ownerUserId: 'user-1',
      tenantKey: 'tenant-1',
      now: 1_001,
    })

    expect(parse({ ...payload, items: payload.items.map((item, index) => (
      index === 0 ? { ...item, amount: item.amount + 1 } : item
    )) })).toBeNull()
    expect(parse({ ...payload, totalAmount: payload.totalAmount + 1 })).toBeNull()
  })

  it('rounds each source line before summing the document total', () => {
    const payload = buildSingleOrderPreviewPayload({
      order: orderForPhase('SUBMITTED'),
      ownerUserId: 'user-1',
      tenantKey: 'tenant-1',
      rows: [
        { ...detailRows[0], key: 'cent-a', itemId: 'cent-a', quantity: 2.01, unitPrice: 0.5 },
        { ...detailRows[0], key: 'cent-b', itemId: 'cent-b', productId: 'cent-b', quantity: 2.01, unitPrice: 0.5 },
      ],
      now: 1_000,
    })
    const parsed = parseSingleOrderPreviewPayload({
      raw: JSON.stringify(payload),
      orderId: 'order-1',
      ownerUserId: 'user-1',
      tenantKey: 'tenant-1',
      now: 1_001,
    })

    expect(payload.items.map(item => item.amount)).toEqual([1.01, 1.01])
    expect(payload.totalAmount).toBe(2.02)
    expect(parsed?.items.map(item => item.amount)).toEqual([1.01, 1.01])
    expect(parsed?.totalAmount).toBe(2.02)
  })

  it('keeps an intentionally empty detail empty instead of reviving server rows', () => {
    const payload = buildSingleOrderPreviewPayload({
      order: orderForPhase('CONFIRMED'),
      ownerUserId: 'user-1',
      tenantKey: 'tenant-1',
      rows: detailRows.map(row => ({ ...row, pendingRemoval: true })),
      now: 1_000,
    })
    const document = applySingleOrderPreview({
      totalAmount: '30',
      items: [{
        id: 'stale', quantity: '3', shippedQty: '3', unitPrice: '10', amount: '30',
        product: { name: '不应复活的旧行', spec: null, unit: '件', code: 'stale' },
      }],
    }, payload)

    expect(document.items).toEqual([])
    expect(document.totalAmount).toBe('0')
  })
})

describe('operation-group delivery-note detail consistency', () => {
  it('projects the already phase-resolved current rows without choosing a second data source', () => {
    // SUBMITTED/order, CONFIRMED/DRAFT and DELIVERING/formal-delivery source
    // selection is exercised in the API three-state test. The page projection
    // is deliberately phase-independent: its sole source is the visible rows.
    const projection = buildOperationGroupDeliveryNoteProjection(detailRows)

    expect(projection.items.map(item => [item.productId, item.quantity, item.unitPrice, item.amount]))
      .toEqual(expectedLines)
    expect(projection.items.some(item => item.productId === 'product-removed')).toBe(false)
    expect(projection.totals).toEqual({ quantity: 5, amount: 45 })
  })

  it('merges matching member rows without losing their authoritative line amount', () => {
    const projection = buildOperationGroupDeliveryNoteProjection([
      { ...detailRows[0], quantity: 1, unitPrice: 10 },
      { ...detailRows[0], quantity: 2, unitPrice: 12 },
    ])

    expect(projection.items).toHaveLength(1)
    expect(projection.items[0]).toMatchObject({
      productId: 'product-changed',
      quantity: 3,
      unitPrice: 11.33,
      amount: 34,
    })
    expect(projection.totals).toEqual({ quantity: 3, amount: 34 })
  })

  it('rounds each member line before merging and summing cents', () => {
    const projection = buildOperationGroupDeliveryNoteProjection([
      { ...detailRows[0], quantity: 2.01, unitPrice: 0.5 },
      { ...detailRows[0], quantity: 2.01, unitPrice: 0.5 },
    ])

    expect(projection.items).toHaveLength(1)
    expect(projection.items[0]).toMatchObject({ quantity: 4.02, amount: 2.02 })
    expect(projection.totals).toEqual({ quantity: 4.02, amount: 2.02 })
  })

  it('rebuilds a valid stored preview from its draft rows', () => {
    const projection = buildOperationGroupDeliveryNoteProjection(detailRows)

    expect(parseOperationGroupDeliveryNoteProjection({
      draftRows: detailRows,
      items: projection.items,
      totals: projection.totals,
    })).toEqual(projection)
  })

  it('rejects finite printable values that no longer match their draft rows', () => {
    const projection = buildOperationGroupDeliveryNoteProjection(detailRows)
    const parse = (draftRows: unknown, items: unknown, totals: unknown) => (
      parseOperationGroupDeliveryNoteProjection({ draftRows, items, totals })
    )

    expect(parse(detailRows, projection.items.map((item, index) => (
      index === 0 ? { ...item, amount: item.amount + 1 } : item
    )), projection.totals)).toBeNull()
    expect(parse(detailRows, projection.items, {
      ...projection.totals,
      amount: projection.totals.amount + 1,
    })).toBeNull()
    expect(parse(detailRows.map((row, index) => (
      index === 0 ? { ...row, quantity: row.quantity + 1 } : row
    )), projection.items, projection.totals)).toBeNull()
    expect(parse(detailRows.map(row => (
      row.productId === 'product-removed' ? { ...row, pendingRemoval: false } : row
    )), projection.items, projection.totals)).toBeNull()
    expect(parse([...detailRows, {
      ...detailRows[0],
      key: 'late-addition',
      productId: 'late-addition',
      name: '未同步新增商品',
    }], projection.items, projection.totals)).toBeNull()
  })
})
