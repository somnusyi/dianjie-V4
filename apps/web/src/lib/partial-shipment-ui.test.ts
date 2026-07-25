import { describe, expect, it } from 'vitest'
import {
  buildPartialShipmentLines,
  buildShipmentConfirmBody,
  computeShipmentNewTotal,
  getClosedRemainderLines,
  hasAnyPositiveShipment,
  mapFulfillmentToCloseSummary,
  type OrderItemForShip,
} from './partial-shipment-ui'

const items: OrderItemForShip[] = [
  { id: 'a', productId: 'p1', quantity: 10, shippedQty: 0, unitPrice: 5, product: { name: '白菜', unit: 'kg' } },
  { id: 'b', productId: 'p2', quantity: 6, shippedQty: 0, unitPrice: 3, product: { name: '萝卜', unit: '斤' } },
]

describe('buildPartialShipmentLines', () => {
  it('defaults sq to remaining when shipQty map is empty', () => {
    const lines = buildPartialShipmentLines(items, {})
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ orig: 10, previous: 0, remaining: 10, sq: 10, changed: false })
    expect(lines[1]).toMatchObject({ orig: 6, previous: 0, remaining: 6, sq: 6, changed: false })
  })

  it('marks changed when sq differs from remaining', () => {
    const lines = buildPartialShipmentLines(items, { a: 7 })
    expect(lines[0].changed).toBe(true)
    expect(lines[0].sq).toBe(7)
    expect(lines[1].changed).toBe(false)
  })

  it('handles previously shipped quantities', () => {
    const partial: OrderItemForShip[] = [
      { id: 'a', productId: 'p1', quantity: 10, shippedQty: 4, unitPrice: 5, product: { name: '白菜', unit: 'kg' } },
    ]
    const lines = buildPartialShipmentLines(partial, {})
    expect(lines[0]).toMatchObject({ orig: 10, previous: 4, remaining: 6, sq: 6, changed: false })
  })

  it('treats null shippedQty as zero', () => {
    const nullShipped: OrderItemForShip[] = [
      { id: 'a', productId: 'p1', quantity: 10, shippedQty: null, unitPrice: 5, product: { name: '白菜', unit: 'kg' } },
    ]
    const lines = buildPartialShipmentLines(nullShipped, {})
    expect(lines[0].previous).toBe(0)
    expect(lines[0].remaining).toBe(10)
  })
})

describe('computeShipmentNewTotal', () => {
  it('sums sq * unitPrice for all lines', () => {
    const lines = buildPartialShipmentLines(items, { a: 8, b: 3 })
    expect(computeShipmentNewTotal(lines)).toBe(8 * 5 + 3 * 3)
  })

  it('returns 0 when all sq are 0', () => {
    const lines = buildPartialShipmentLines(items, { a: 0, b: 0 })
    expect(computeShipmentNewTotal(lines)).toBe(0)
  })
})

describe('hasAnyPositiveShipment', () => {
  it('returns false when all sq are 0', () => {
    const lines = buildPartialShipmentLines(items, { a: 0, b: 0 })
    expect(hasAnyPositiveShipment(lines)).toBe(false)
  })

  it('returns true when at least one sq > 0', () => {
    const lines = buildPartialShipmentLines(items, { a: 5, b: 0 })
    expect(hasAnyPositiveShipment(lines)).toBe(true)
  })

  it('returns true for full shipment', () => {
    const lines = buildPartialShipmentLines(items, {})
    expect(hasAnyPositiveShipment(lines)).toBe(true)
  })
})

describe('getClosedRemainderLines', () => {
  it('returns empty for full shipment', () => {
    const lines = buildPartialShipmentLines(items, {})
    expect(getClosedRemainderLines(lines)).toEqual([])
  })

  it('returns closed quantities for partial shipment', () => {
    const lines = buildPartialShipmentLines(items, { a: 7 })
    const closed = getClosedRemainderLines(lines)
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ name: '白菜', ordered: 10, shipped: 7, closed: 3, unit: 'kg' })
  })

  it('includes items where sq is 0 and remaining > 0', () => {
    const lines = buildPartialShipmentLines(items, { a: 0 })
    const closed = getClosedRemainderLines(lines)
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ name: '白菜', ordered: 10, shipped: 0, closed: 10 })
  })

  it('includes all items with unshipped remainder', () => {
    const lines = buildPartialShipmentLines(items, { a: 5, b: 2 })
    const closed = getClosedRemainderLines(lines)
    expect(closed).toHaveLength(2)
    expect(closed[0]).toMatchObject({ name: '白菜', closed: 5 })
    expect(closed[1]).toMatchObject({ name: '萝卜', closed: 4 })
  })

  it('closes only the current remainder when historical shipped quantity exists', () => {
    const historical: OrderItemForShip[] = [
      { id: 'a', productId: 'p1', quantity: 10, shippedQty: 4, unitPrice: 5, product: { name: '白菜', unit: 'kg' } },
    ]
    const lines = buildPartialShipmentLines(historical, { a: 3 })
    expect(getClosedRemainderLines(lines)).toEqual([
      { name: '白菜', ordered: 10, shipped: 3, closed: 3, unit: 'kg' },
    ])
  })
})

describe('buildShipmentConfirmBody', () => {
  it('includes full-shipment text without close warning', () => {
    const lines = buildPartialShipmentLines(items, {})
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal: 68, oldTotal: 68,
    })
    expect(body).toContain('2 件商品')
    expect(body).toContain('本次配送金额 ¥68')
    expect(body).not.toContain('永久关闭')
    expect(body).not.toContain('不会补送')
  })

  it('includes close warning for partial shipment', () => {
    const lines = buildPartialShipmentLines(items, { a: 7 })
    const newTotal = computeShipmentNewTotal(lines)
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal, oldTotal: 68,
    })
    expect(body).toContain('已调整 1 项')
    expect(body).toContain('永久关闭')
    expect(body).toContain('不会补送')
    expect(body).toContain('白菜')
    expect(body).toContain('未发 3kg')
    expect(body).toContain('门店重新下单')
  })

  it('includes STRICT inventory mode text', () => {
    const lines = buildPartialShipmentLines(items, {})
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal: 68, oldTotal: 68, inventoryMode: 'STRICT',
    })
    expect(body).toContain('自动扣减供应商库存')
  })

  it('includes NOT_TRACKED inventory mode text', () => {
    const lines = buildPartialShipmentLines(items, {})
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal: 68, oldTotal: 68, inventoryMode: 'NOT_TRACKED',
    })
    expect(body).toContain('未核算供应商仓库库存')
  })

  it('includes fulfillment policy hint when partial', () => {
    const lines = buildPartialShipmentLines(items, { a: 7 })
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal: 53, oldTotal: 68,
      fulfillment: {
        policy: 'CLOSE_UNSHIPPED_REMAINDER',
        remainderClosed: true,
        hasClosedRemainder: true,
        isPartial: true,
        lines: [],
      },
    })
    expect(body).toContain('首次有效发货后')
    expect(body).toContain('释放预占')
  })

  it('does not include fulfillment hint for full shipment', () => {
    const lines = buildPartialShipmentLines(items, {})
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal: 68, oldTotal: 68,
      fulfillment: {
        policy: 'CLOSE_UNSHIPPED_REMAINDER',
        remainderClosed: true,
        hasClosedRemainder: false,
        isPartial: false,
        lines: [],
      },
    })
    expect(body).not.toContain('释放预占')
  })

  it('does not include old text about 继续补送', () => {
    const lines = buildPartialShipmentLines(items, { a: 0 })
    const body = buildShipmentConfirmBody({
      itemCount: 2, lines, newTotal: 18, oldTotal: 68,
    })
    expect(body).not.toContain('可在本次收货完成后继续补送')
    expect(body).not.toContain('继续补送')
  })
})

describe('mapFulfillmentToCloseSummary', () => {
  it('maps a full-shipment fulfillment result', () => {
    const result = mapFulfillmentToCloseSummary({
      policy: 'CLOSE_UNSHIPPED_REMAINDER',
      remainderClosed: true,
      hasClosedRemainder: false,
      isPartial: false,
      lines: [{ itemId: 'a', productId: 'p1', orderedQty: 10, shippedQty: 10, closedQty: 0 }],
    })
    expect(result).toMatchObject({
      policy: 'CLOSE_UNSHIPPED_REMAINDER',
      remainderClosed: true,
      hasClosedRemainder: false,
      isPartial: false,
    })
    expect(result!.lines).toHaveLength(1)
    expect(result!.lines[0]).toMatchObject({ orderedQty: 10, shippedQty: 10, closedQty: 0 })
  })

  it('maps a partial-shipment fulfillment with closed remainder', () => {
    const result = mapFulfillmentToCloseSummary({
      policy: 'CLOSE_UNSHIPPED_REMAINDER',
      remainderClosed: true,
      hasClosedRemainder: true,
      isPartial: true,
      lines: [
        { itemId: 'a', productId: 'p1', productName: '白菜', orderedQty: 10, shippedQty: 7, closedQty: 3 },
        { itemId: 'b', productId: 'p2', productName: '萝卜', orderedQty: 6, shippedQty: 6, closedQty: 0 },
      ],
    })
    expect(result).toMatchObject({
      hasClosedRemainder: true,
      isPartial: true,
    })
    expect(result!.lines[0]).toMatchObject({ productName: '白菜', closedQty: 3 })
  })

  it('returns null for null/undefined input', () => {
    expect(mapFulfillmentToCloseSummary(null as any)).toBeNull()
    expect(mapFulfillmentToCloseSummary(undefined as any)).toBeNull()
  })

  it('returns null when remainderClosed is false', () => {
    expect(mapFulfillmentToCloseSummary({ remainderClosed: false })).toBeNull()
  })

  it('defaults missing fields safely', () => {
    const result = mapFulfillmentToCloseSummary({ remainderClosed: true })
    expect(result).toMatchObject({
      policy: 'CLOSE_UNSHIPPED_REMAINDER',
      hasClosedRemainder: false,
      isPartial: false,
    })
    expect(result!.lines).toEqual([])
  })
})
