import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  calculateRevisionLineAmount,
  resolveRevisionCatalogPricing,
  resolveRevisionCustomProductDraft,
  sumRevisionLineAmounts,
} from './supplier-revision-cost-pricing'

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  name: '测试商品',
  status: 'ENABLED',
  price: '12.34',
  unit: '件',
  purchaseUnit: '件',
  inventoryUnit: '件',
  orderUnit: '件',
  costUnit: '件',
  inventoryUnitsPerPurchaseUnit: '1',
  inventoryUnitsPerOrderUnit: '1',
  inventoryUnitsPerCostUnit: '1',
  unitConversionStatus: 'VERIFIED',
  ...overrides,
})

describe('resolveRevisionCatalogPricing', () => {
  it('keeps 1:1 legacy product ready even without structured fields', () => {
    const result = resolveRevisionCatalogPricing(product({
      price: '8.50',
      unit: '包',
      purchaseUnit: null,
      inventoryUnit: null,
      orderUnit: null,
      costUnit: null,
      inventoryUnitsPerPurchaseUnit: null,
      inventoryUnitsPerOrderUnit: null,
      inventoryUnitsPerCostUnit: null,
      unitConversionStatus: 'PENDING',
    }))
    expect(result).toMatchObject({
      status: 'READY',
      orderUnitPrice: '8.50',
      orderUnit: '包',
      unitLabel: '元 / 包',
      costPriceSource: '成本价来源：¥8.50 / 包',
    })
  })

  it('converts a non-1:1 inferred contract to order unit price', () => {
    const result = resolveRevisionCatalogPricing(product({
      price: '20',
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '箱',
      costUnit: '打',
      inventoryUnitsPerPurchaseUnit: '12',
      inventoryUnitsPerOrderUnit: '12',
      inventoryUnitsPerCostUnit: '6',
      unitConversionStatus: 'INFERRED',
    }))
    expect(result.status).toBe('READY')
    if (result.status === 'READY') {
      expect(result.orderUnitPrice).toBe('40.00')
      expect(result.unitLabel).toBe('元 / 箱')
      expect(result.costPriceSource).toBe('成本价来源：¥20.00 / 打')
    }
  })

  it('converts cost per g into order price per 斤', () => {
    const result = resolveRevisionCatalogPricing(product({
      price: '0.02',
      unit: '斤',
      purchaseUnit: '箱',
      inventoryUnit: 'g',
      orderUnit: '斤',
      costUnit: 'g',
      inventoryUnitsPerPurchaseUnit: '10000',
      inventoryUnitsPerOrderUnit: '500',
      inventoryUnitsPerCostUnit: '1',
    }))
    expect(result.status).toBe('READY')
    if (result.status === 'READY') {
      expect(result.orderUnitPrice).toBe('10.00')
      expect(result.unitLabel).toBe('元 / 斤')
    }
  })

  it('does not guess an explicit non-1:1 PENDING contract', () => {
    const result = resolveRevisionCatalogPricing(product({
      unit: '箱',
      purchaseUnit: '箱',
      inventoryUnit: '瓶',
      orderUnit: '箱',
      costUnit: '瓶',
      inventoryUnitsPerPurchaseUnit: '12',
      inventoryUnitsPerOrderUnit: '12',
      inventoryUnitsPerCostUnit: '1',
      unitConversionStatus: 'PENDING',
    }))
    expect(result).toEqual({
      status: 'PENDING',
      message: '测试商品 的四单位换算待核验或不完整，暂不能计算订货价格',
    })
  })

  it.each([
    ['missing unit', { costUnit: null }],
    ['missing factor', { inventoryUnitsPerOrderUnit: null }],
    ['zero factor', { inventoryUnitsPerOrderUnit: 0 }],
    ['negative factor', { inventoryUnitsPerCostUnit: -1 }],
    ['invalid status on a non-1:1 contract', { purchaseUnit: '箱', unitConversionStatus: 'DRAFT' }],
  ])('returns PENDING for %s', (_case, overrides) => {
    const result = resolveRevisionCatalogPricing(product(overrides))
    expect(result.status).toBe('PENDING')
    expect((result as { message: string }).message).toContain('测试商品')
  })

  it('returns PENDING when the cost price is invalid', () => {
    const result = resolveRevisionCatalogPricing(product({ price: '-1' }))
    expect(result).toMatchObject({
      status: 'PENDING',
      message: '测试商品 的采购成本单价无效，暂不能计算订货价格',
    })
  })
})

describe('calculateRevisionLineAmount', () => {
  it('returns null when pricing is pending', () => {
    const pricing = { status: 'PENDING' as const, message: '待核验' }
    expect(calculateRevisionLineAmount(3, pricing)).toBeNull()
  })

  it('computes amount using the rounded order unit price', () => {
    const pricing = {
      status: 'READY' as const,
      orderUnitPrice: '10.00',
      orderUnit: '斤',
      unitLabel: '元 / 斤',
      costPriceSource: '成本价来源：¥0.02 / g',
    }
    expect(calculateRevisionLineAmount('2.5', pricing)).toBe('25.00')
  })
})

describe('sumRevisionLineAmounts', () => {
  it('sums ready amounts', () => {
    expect(sumRevisionLineAmounts(['25.00', '12.34'])).toBe('37.34')
  })

  it('returns null when any amount is missing', () => {
    expect(sumRevisionLineAmounts(['25.00', null])).toBeNull()
  })
})

describe('resolveRevisionCustomProductDraft', () => {
  it('normalizes a complete custom item for the direct revision API', () => {
    expect(resolveRevisionCustomProductDraft({
      name: '  时令菜  ',
      spec: ' 500g / 袋 ',
      unit: ' 袋 ',
      unitPrice: '12.30',
      quantity: '2.50',
    })).toEqual({
      status: 'READY',
      item: {
        customProduct: { name: '时令菜', spec: '500g / 袋', unit: '袋', unitPrice: 12.3 },
        quantity: 2.5,
      },
      lineAmount: '30.75',
    })
  })

  it('omits an empty optional specification', () => {
    const result = resolveRevisionCustomProductDraft({
      name: '临时商品', spec: '  ', unit: '件', unitPrice: '0', quantity: '1',
    })
    expect(result.status).toBe('READY')
    if (result.status === 'READY') {
      expect(result.item.customProduct).toEqual({ name: '临时商品', unit: '件', unitPrice: 0 })
    }
  })

  it.each([
    ['missing name', { name: '', spec: '', unit: '件', unitPrice: '1', quantity: '1' }],
    ['overlong spec', { name: '商品', spec: 'x'.repeat(81), unit: '件', unitPrice: '1', quantity: '1' }],
    ['numeric unit prefix', { name: '商品', spec: '', unit: '2箱', unitPrice: '1', quantity: '1' }],
    ['three-decimal price', { name: '商品', spec: '', unit: '件', unitPrice: '1.001', quantity: '1' }],
    ['zero quantity', { name: '商品', spec: '', unit: '件', unitPrice: '1', quantity: '0' }],
    ['three-decimal quantity', { name: '商品', spec: '', unit: '件', unitPrice: '1', quantity: '1.001' }],
  ])('rejects %s', (_case, draft) => {
    expect(resolveRevisionCustomProductDraft(draft)).toMatchObject({ status: 'INVALID' })
  })
})

describe('supplier revision page pricing contract', () => {
  const source = readFileSync(
    new URL('../app/v2/supplier/orders/[id]/page.tsx', import.meta.url),
    'utf8',
  )

  it('uses current four-unit pricing only for newly added catalog products', () => {
    expect(source).toContain('resolveRevisionCatalogPricing(p)')
    expect(source).toContain('pricing.orderUnitPrice')
    expect(source).not.toContain('Number(p.price)')
  })

  it('keeps existing rows on their frozen price and unit snapshots', () => {
    expect(source).toContain('existing.unitPrice')
    expect(source).toContain('existing.orderUnitSnapshot || existing.productUnitSnapshot')
    expect(source).toContain('历史冻结订货价')
  })

  it('blocks a catalog product whose current price is pending before inserting it', () => {
    expect(source).toContain("if (!existing && pricing?.status !== 'READY')")
    expect(source).toContain('该商品价格待核验，暂不能加入')
    expect(source).toContain("selectedPricing?.status !== 'READY'")
  })

  it('applies internal supply-chain revisions directly without a custom-product path', () => {
    expect(source).toContain("const isDirectOperationGroupRevision = viewerRole === 'SUPPLY_CHAIN'")
    expect(source).toContain('const items = catalogItems')
    expect(source).not.toContain('revisionCustomDrafts')
    expect(source).not.toContain('resolveRevisionCustomProductDraft')
    expect(source).not.toContain('customItems')
    expect(source).not.toContain('自定义商品')
    expect(source).toContain("confirmLabel: isDirectOperationGroupRevision ? '确认修改' : '提交申请'")
    expect(source).toContain('router.replace(`/v2/supply-chain/fulfillment/group/${encodeURIComponent(operationGroupId)}`)')
  })

  it('scopes the internal picker to warehouse stock and the order supplier', () => {
    expect(source).toContain('? await loadAllWarehouseProductCatalog(order.supplier.id)')
    expect(source).toContain(': await loadAllProductCatalog()')
    expect(source).toContain('matchesWarehouseProductSearch(product, deliveryAddSearch)')
  })

  it('reuses one request key for retries of the same open draft', () => {
    expect(source).toContain('const revisionRequestKeyRef = useRef<string | null>(null)')
    expect(source).toContain('const requestKey = revisionRequestKeyRef.current || clientRequestId()')
    expect(source).toContain('revisionRequestKeyRef.current = requestKey')
    expect(source).toContain('revisionRequestKeyRef.current = null')
    expect(source).toContain('requestKey,')
    expect(source).not.toContain('requestKey: clientRequestId()')
  })

  it('preserves the legacy supplier approval copy outside an operation group', () => {
    expect(source).toContain('提交后须门店确认，确认前不能接单。')
    expect(source).toContain("isDirectOperationGroupRevision ? '确认修改' : '提交申请'")
  })
})

describe('internal operation-group revision entry contract', () => {
  const source = readFileSync(
    new URL('../app/v2/supply-chain/fulfillment/group/[groupId]/page.tsx', import.meta.url),
    'utf8',
  )

  it('edits and atomically saves the whole group in place instead of routing into one order', () => {
    expect(source).toContain('const orders = detail.orders.map(order => ({')
    expect(source).toContain('rows.filter(row => row.orderId === order.id)')
    expect(source).toContain('`/api/orders/operation-groups/${encodeURIComponent(detail.group.id)}/items`')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('变化会同步回集合内原订单并整体生效或回滚')
    expect(source).not.toContain('operationGroup=${encodeURIComponent(detail.group.id)}&groupAdd=1')
    expect(source).not.toContain('接单前修改（数量 / 商品）')
    expect(source).not.toContain('自定义商品')
  })

  it('does not advertise a store-confirmation waiting step', () => {
    expect(source).not.toContain('待门店确认')
  })
})
