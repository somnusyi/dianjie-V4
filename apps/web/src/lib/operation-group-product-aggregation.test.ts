import { describe, expect, it } from 'vitest'
import {
  groupOperationGroupProductRows,
  setOperationGroupProductRemoval,
  updateOperationGroupProductQuantity,
} from './operation-group-product-aggregation'
import { buildOperationGroupDeliveryNoteProjection } from './operation-group-delivery-note-preview'

type Row = {
  key: string
  orderId: string
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  originalQuantity: number
  unitPrice: number
  pendingRemoval: boolean
}

const rows: Row[] = [
  { key: 'o1:a', orderId: 'o1', productId: 'a', name: '赤松茸A', spec: '件/2250g', unit: '件', quantity: 3, originalQuantity: 3, unitPrice: 135, pendingRemoval: false },
  { key: 'o1:b', orderId: 'o1', productId: 'b', name: '黑牛肝菌', spec: '件/1000g', unit: 'kg', quantity: 5, originalQuantity: 5, unitPrice: 70, pendingRemoval: false },
  { key: 'o1:c', orderId: 'o1', productId: 'c', name: '金耳菌', spec: '件/1000g', unit: 'kg', quantity: 2.5, originalQuantity: 2.5, unitPrice: 28, pendingRemoval: false },
  { key: 'o2:a', orderId: 'o2', productId: 'a', name: '赤松茸A', spec: '件/2250g', unit: '件', quantity: 1, originalQuantity: 1, unitPrice: 135, pendingRemoval: false },
  { key: 'o2:b', orderId: 'o2', productId: 'b', name: '黑牛肝菌', spec: '件/1000g', unit: 'kg', quantity: 5, originalQuantity: 5, unitPrice: 70, pendingRemoval: false },
  { key: 'o2:c', orderId: 'o2', productId: 'c', name: '金耳菌', spec: '件/1000g', unit: 'kg', quantity: 2.5, originalQuantity: 2.5, unitPrice: 28, pendingRemoval: false },
  { key: 'o2:d', orderId: 'o2', productId: 'd', name: '羊肚菌', spec: '件/1000g', unit: 'kg', quantity: 1, originalQuantity: 1, unitPrice: 175, pendingRemoval: false },
]

describe('operation-group product aggregation', () => {
  it('shows the seven source rows as the same four products used by the delivery note', () => {
    const grouped = groupOperationGroupProductRows(rows)
    expect(grouped.map(row => [row.name, row.quantity, row.amount])).toEqual([
      ['赤松茸A', 4, 540],
      ['黑牛肝菌', 10, 700],
      ['金耳菌', 5, 140],
      ['羊肚菌', 1, 175],
    ])
    expect(grouped[0].memberKeys).toEqual(['o1:a', 'o2:a'])
    const deliveryNote = buildOperationGroupDeliveryNoteProjection(rows)
    expect(grouped.map(({ name, spec, unit, quantity, unitPrice, amount }) => ({
      name, spec, unit, quantity, unitPrice, amount,
    }))).toEqual(deliveryNote.items.map(({ name, spec, unit, quantity, unitPrice, amount }) => ({
      name, spec, unit, quantity, unitPrice, amount,
    })))
  })

  it('edits the merged total while preserving the original document rows underneath', () => {
    const mergeKey = groupOperationGroupProductRows(rows)[0].mergeKey
    const increased = updateOperationGroupProductQuantity(rows, mergeKey, 6, () => true)
    expect(increased.error).toBeNull()
    expect(increased.rows.filter(row => row.productId === 'a').map(row => row.quantity)).toEqual([3, 3])

    const zeroed = updateOperationGroupProductQuantity(increased.rows, mergeKey, 0, () => true)
    expect(zeroed.error).toBeNull()
    expect(zeroed.rows.filter(row => row.productId === 'a').map(row => row.quantity)).toEqual([0, 0])

    const directFour = updateOperationGroupProductQuantity(rows, mergeKey, 4, () => true)
    const backToFour = updateOperationGroupProductQuantity(zeroed.rows, mergeKey, 4, () => true)
    expect(backToFour.rows.filter(row => row.productId === 'a').map(row => row.quantity))
      .toEqual(directFour.rows.filter(row => row.productId === 'a').map(row => row.quantity))
  })

  it('removes and restores every source row represented by one merged product', () => {
    const mergeKey = groupOperationGroupProductRows(rows)[1].mergeKey
    const removed = setOperationGroupProductRemoval(rows, mergeKey, true, () => true)
    expect(removed.error).toBeNull()
    expect(removed.rows.filter(row => row.productId === 'b').every(row => row.pendingRemoval)).toBe(true)
    expect(groupOperationGroupProductRows(removed.rows).find(row => row.productId === 'b')?.pendingRemoval).toBe(true)

    const restored = setOperationGroupProductRemoval(removed.rows, mergeKey, false, () => true)
    expect(restored.error).toBeNull()
    expect(restored.rows.filter(row => row.productId === 'b').every(row => !row.pendingRemoval)).toBe(true)
  })

  it('does not merge different frozen product wording or units', () => {
    const variants = [
      rows[0],
      { ...rows[3], name: '赤松茸B' },
      { ...rows[3], key: 'o3:a', orderId: 'o3', unit: 'kg' },
    ]
    expect(groupOperationGroupProductRows(variants)).toHaveLength(3)
  })

  it('keeps a mixed locked product read-only instead of changing the wrong document', () => {
    const mergeKey = groupOperationGroupProductRows(rows)[0].mergeKey
    const result = updateOperationGroupProductQuantity(rows, mergeKey, 2, row => row.orderId === 'o2')
    expect(result.error).toBe('该商品已有 3 件 不可修改')
    expect(result.rows).toBe(rows)
    expect(setOperationGroupProductRemoval(rows, mergeKey, true, row => row.orderId === 'o2').error)
      .toBe('该商品包含当前不能修改的明细')
  })
})
