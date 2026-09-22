import { describe, expect, it } from 'vitest'
import { isOrderEntryStockBlocked, isOrderEntryZeroStock } from './order-entry-stock-policy'

describe('门店订货库存策略', () => {
  it('外部严格库存供应商零库存只提醒，不在门店提交阶段阻断', () => {
    const product = { stock: 8, availableStock: 0 }
    expect(isOrderEntryZeroStock(product, { inventoryMode: 'STRICT' })).toBe(true)
    expect(isOrderEntryStockBlocked(product, { inventoryMode: 'STRICT' })).toBe(false)
  })

  it('严格库存供应商仍有可用库存时允许加入', () => {
    expect(isOrderEntryStockBlocked({ stock: 8, availableStock: 2 }, { inventoryMode: 'STRICT' })).toBe(false)
  })

  it('非管控库存供应商的 0 只是未知库存，不拦截下单', () => {
    expect(isOrderEntryStockBlocked({ stock: 0, availableStock: 0 }, { inventoryMode: 'NOT_TRACKED' })).toBe(false)
  })

  it('内部总仓以商品行返回的仓库账策略为准', () => {
    expect(isOrderEntryStockBlocked(
      { stock: 99, availableStock: 0, inventoryEnforced: true },
      { inventoryMode: 'NOT_TRACKED' },
    )).toBe(true)
    expect(isOrderEntryStockBlocked(
      { stock: 0, availableStock: 0, inventoryEnforced: false },
      { inventoryMode: 'STRICT' },
    )).toBe(false)
  })

  it('仅提醒策略下仍识别零库存，但不阻断提交', () => {
    const product = {
      stock: 99,
      availableStock: 0,
      inventoryTracked: true,
      inventoryEnforced: false,
    }
    expect(isOrderEntryZeroStock(product, { inventoryMode: 'NOT_TRACKED' })).toBe(true)
    expect(isOrderEntryStockBlocked(product, { inventoryMode: 'NOT_TRACKED' })).toBe(false)
  })

  it('未启用库存投影时仍保留旧 stock=0 的断货提醒，但不阻断', () => {
    const product = {
      stock: 0,
      availableStock: 0,
      inventoryTracked: false,
      inventoryEnforced: false,
    }
    expect(isOrderEntryZeroStock(product, { inventoryMode: 'NOT_TRACKED' })).toBe(true)
    expect(isOrderEntryStockBlocked(product, { inventoryMode: 'NOT_TRACKED' })).toBe(false)
  })

  it('旧供应商响应没有库存模式时保持原兼容行为', () => {
    expect(isOrderEntryStockBlocked({ stock: 0 }, undefined)).toBe(false)
  })
})
