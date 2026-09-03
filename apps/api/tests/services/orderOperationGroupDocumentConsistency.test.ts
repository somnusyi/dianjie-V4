import { describe, expect, it } from 'vitest'
import {
  mergeOperationGroupItems,
  operationGroupDocumentLines,
} from '../../src/services/orderOperationGroupDetails'

type Phase = 'SUBMITTED' | 'CONFIRMED' | 'DELIVERING'

const activeDocumentRows = [
  {
    id: 'line-changed',
    purchaseOrderItemId: 'line-changed',
    productId: 'product-changed',
    quantity: '3',
    shippedQty: '3',
    unitPrice: '10',
    unitPriceSnapshot: '10',
    amount: '30',
    productNameSnapshot: '改数量商品',
    productSpecSnapshot: null,
    productUnitSnapshot: '件',
  },
  {
    id: 'line-zero',
    purchaseOrderItemId: 'line-zero',
    productId: 'product-zero',
    quantity: '0',
    shippedQty: '0',
    unitPrice: '20',
    unitPriceSnapshot: '20',
    amount: '0',
    productNameSnapshot: '零数量商品',
    productSpecSnapshot: null,
    productUnitSnapshot: '件',
  },
  {
    id: 'line-added',
    purchaseOrderItemId: 'line-added',
    productId: 'product-added',
    quantity: '2',
    shippedQty: '2',
    unitPrice: '7.5',
    unitPriceSnapshot: '7.5',
    amount: '15',
    productNameSnapshot: '新增商品',
    productSpecSnapshot: null,
    productUnitSnapshot: '件',
  },
]

function orderForPhase(phase: Phase) {
  const orderRows = [
    ...activeDocumentRows.map(item => ({ ...item, isActive: true })),
    {
      id: 'line-removed',
      productId: 'product-removed',
      quantity: '1',
      unitPrice: '99',
      amount: '99',
      isActive: false,
      productNameSnapshot: '已移除商品',
      productSpecSnapshot: null,
      productUnitSnapshot: '件',
    },
  ]
  const deliveryItems = [
    ...activeDocumentRows.map(item => ({ ...item, removedAt: null })),
    {
      id: 'delivery-line-removed',
      purchaseOrderItemId: 'line-removed',
      productId: 'product-removed',
      shippedQty: '1',
      unitPriceSnapshot: '99',
      amount: '99',
      productNameSnapshot: '已移除商品',
      productSpecSnapshot: null,
      productUnitSnapshot: '件',
      removedAt: '2026-09-01T00:30:00.000Z',
    },
  ]

  if (phase === 'SUBMITTED') {
    return { status: phase, items: orderRows, deliveries: [] }
  }
  if (phase === 'CONFIRMED') {
    return {
      status: phase,
      items: [{
        id: 'ordered-stale', productId: 'ordered-stale', quantity: '100', unitPrice: '100', amount: '10000', isActive: true,
        productNameSnapshot: '不应回退的原订单行', productSpecSnapshot: null, productUnitSnapshot: '件',
      }],
      deliveries: [{
        id: 'draft-1', no: 'DR-1', status: 'DRAFT', rowVersion: 2,
        createdAt: '2026-09-01T00:00:00.000Z', items: deliveryItems,
      }],
    }
  }
  return {
    status: phase,
    items: [{
      id: 'ordered-stale', productId: 'ordered-stale', quantity: '100', unitPrice: '100', amount: '10000', isActive: true,
      productNameSnapshot: '不应回退的原订单行', productSpecSnapshot: null, productUnitSnapshot: '件',
    }],
    deliveries: [
      {
        id: 'draft-stale', no: 'DR-stale', status: 'DRAFT', rowVersion: 3,
        createdAt: '2026-09-01T00:00:00.000Z', items: [{
          ...activeDocumentRows[0], productId: 'draft-stale', productNameSnapshot: '不应显示的草稿行',
        }],
      },
      {
        id: 'delivery-1', no: 'DO-1', status: 'SHIPPED', rowVersion: 1,
        createdAt: '2026-09-01T01:00:00.000Z', items: deliveryItems,
      },
    ],
  }
}

describe('operation-group detail and delivery-note document consistency', () => {
  it.each<Phase>(['SUBMITTED', 'CONFIRMED', 'DELIVERING'])(
    'uses the exact active %s document rows for quantity, removal, addition, and money',
    phase => {
      const lines = operationGroupDocumentLines(orderForPhase(phase))
      const merged = mergeOperationGroupItems([{ no: 'PO-1', items: lines }])

      expect(merged.map(item => [item.productId, item.quantity, item.amount])).toEqual([
        ['product-changed', '3.00', '30.00'],
        ['product-zero', '0.00', '0.00'],
        ['product-added', '2.00', '15.00'],
      ])
      expect(merged.some(item => item.productId === 'product-removed')).toBe(false)
      expect(merged.some(item => item.productId === 'ordered-stale')).toBe(false)
      expect(merged.some(item => item.productId === 'draft-stale')).toBe(false)
      expect(merged.reduce((sum, item) => sum + Number(item.amount), 0)).toBe(45)
    },
  )

  it.each([
    {
      phase: 'SUBMITTED',
      order: {
        status: 'SUBMITTED',
        items: [{ ...activeDocumentRows[0], isActive: false }],
        deliveries: [],
      },
    },
    {
      phase: 'CONFIRMED',
      order: {
        status: 'CONFIRMED',
        items: [{ ...activeDocumentRows[0], isActive: true }],
        deliveries: [{
          id: 'empty-draft', status: 'DRAFT', rowVersion: 1, createdAt: '2026-09-01T00:00:00.000Z',
          items: [{ ...activeDocumentRows[0], removedAt: '2026-09-01T00:01:00.000Z' }],
        }],
      },
    },
    {
      phase: 'DELIVERING',
      order: {
        status: 'DELIVERING',
        items: [{ ...activeDocumentRows[0], isActive: true }],
        deliveries: [{
          id: 'empty-delivery', status: 'SHIPPED', rowVersion: 1, createdAt: '2026-09-01T00:00:00.000Z',
          items: [{ ...activeDocumentRows[0], removedAt: '2026-09-01T00:01:00.000Z' }],
        }],
      },
    },
  ])('keeps an intentionally empty $phase document empty instead of reviving ordered rows', ({ order }) => {
    expect(operationGroupDocumentLines(order)).toEqual([])
  })
})
