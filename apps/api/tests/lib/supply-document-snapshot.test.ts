import { describe, expect, it } from 'vitest'
import { withDocumentProductSnapshot } from '../../src/lib/supply-document-snapshot'

describe('supply document product snapshots', () => {
  it('keeps the frozen wording after product master data changes', () => {
    const result = withDocumentProductSnapshot({
      product: { code: 'NEW', name: '新名称', unit: '箱', spec: '新规格', category: '新分类' },
      productCodeSnapshot: 'OLD',
      productNameSnapshot: '下单时名称',
      productUnitSnapshot: '斤',
      productSpecSnapshot: '下单时规格',
      productCategorySnapshot: '历史分类',
    })
    expect(result.product).toMatchObject({
      code: 'OLD', name: '下单时名称', unit: '斤', spec: '下单时规格', category: '历史分类',
    })
  })

  it('falls back to the current product for legacy rows', () => {
    const result = withDocumentProductSnapshot({ product: { code: 'P1', name: '旧数据商品', unit: '件' } })
    expect(result.product).toMatchObject({ code: 'P1', name: '旧数据商品', unit: '件' })
  })
})
