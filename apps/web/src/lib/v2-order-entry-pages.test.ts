import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pageSources = [
  {
    name: '厨师长下单页',
    source: readFileSync(
      new URL('../app/v2/chef/purchase/new/page.tsx', import.meta.url),
      'utf8',
    ),
  },
  {
    name: '总厨代下单页',
    source: readFileSync(
      new URL('../app/v2/chef-director/purchase/new/page.tsx', import.meta.url),
      'utf8',
    ),
  },
]

describe.each(pageSources)('$name 的订货单位价格源合同', ({ source }) => {
  it('统一使用成本价折算 helper 生成订货价、行金额和合计', () => {
    expect(source).toContain("from '@/lib/order-entry-cost-pricing'")
    expect(source).toContain('resolveOrderEntryCostPricing')
    expect(source).toContain('calculateOrderEntryLineAmount')
    expect(source).toContain('sumOrderEntryLineAmounts')
    expect(source).toContain('unitPrice: Number(pricing.orderUnitPrice)')
    expect(source).toContain('items: submitItems')
    expect(source).toContain('pricing.unitLabel')
    expect(source).toContain('pricing.costPriceSource')
  })

  it('待核验价格不可加入，旧草稿提交前会被阻止并给出处理动作', () => {
    expect(source).toMatch(
      /if \(pricing\.status === 'PENDING'\) \{\s+setError\(`\$\{pricing\.message\}，请联系采购核验单位换算后再加入`\)\s+return/,
    )
    expect(source).toContain('以下草稿商品无法计算订货价，请先移除或联系采购核验单位换算')
    expect(source).toContain('pricePending')
    expect(source).toContain('aria-label="该商品价格待核验"')
  })

  it('不再把 Product.price 直接当作订货单位价或小计价格', () => {
    expect(source).not.toContain('Number(p.price)')
    expect(source).not.toMatch(/quantity\s*\*\s*[^;\n]*unitPrice/)
    expect(source).not.toMatch(/qty\s*\*\s*[^;\n]*price/)
  })
})
