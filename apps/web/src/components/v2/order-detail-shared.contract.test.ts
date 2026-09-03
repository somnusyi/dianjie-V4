import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const singlePage = readFileSync(new URL('../../app/v2/supplier/orders/[id]/page.tsx', import.meta.url), 'utf8')
const groupPage = readFileSync(new URL('../../app/v2/supply-chain/fulfillment/group/[groupId]/page.tsx', import.meta.url), 'utf8')
const sharedComponent = readFileSync(new URL('./order-detail-shared.tsx', import.meta.url), 'utf8')
const singlePreview = readFileSync(new URL('../../../../../docs/preview/011-single-order-detail.html', import.meta.url), 'utf8')
const groupPreview = readFileSync(new URL('../../../../../docs/preview/011-batch-order-detail.html', import.meta.url), 'utf8')

const sharedImport = "from '@/components/v2/order-detail-shared'"
const sharedModules = [
  'OrderDetailHeader',
  'OrderAmountCard',
  'OrderDeliverySummary',
  'OrderProgressCard',
  'OrderProductTable',
]

describe('single and grouped fulfillment detail architecture', () => {
  it('renders both pages through the same shared order-detail module', () => {
    for (const source of [singlePage, groupPage]) {
      expect(source).toContain(sharedImport)
      for (const moduleName of sharedModules) expect(source).toContain(`<${moduleName}`)
    }
  })

  it('keeps the shared product table as the only owner of its save control and column order', () => {
    expect(sharedComponent.match(/\{props\.saving \? '保存中…' : '保存'\}/g)).toHaveLength(1)
    expect(sharedComponent).toContain('序号</th><th className="px-3 py-2">名称</th><th className="px-3 py-2">规格</th>')
    expect(sharedComponent).toContain('数量</th><th className="px-3 py-2 text-right">单价</th><th className="px-3 py-2 text-right">总价</th>')
  })

  it('does not reintroduce duplicate legacy sections or a second group delivery-note action', () => {
    for (const forbidden of ['打印集合送货单', '保存明细', '改单记录', '自定义商品']) {
      expect(groupPage).not.toContain(forbidden)
    }
    expect(groupPage.match(/delivery-note/g)).toHaveLength(1)
  })

  it('keeps both standalone previews on the exact same embedded shared-module renderer', () => {
    const renderer = (html: string) => html.slice(
      html.indexOf('function renderSharedOrderDetail(m){'),
      html.indexOf('sharedRoot.innerHTML=renderSharedOrderDetail(model);'),
    ).trim()
    expect(singlePreview).toContain('data-source-component="apps/web/src/components/v2/order-detail-shared.tsx"')
    expect(groupPreview).toContain('data-source-component="apps/web/src/components/v2/order-detail-shared.tsx"')
    expect(renderer(singlePreview)).toBe(renderer(groupPreview))
    for (const forbidden of ['打印集合送货单', '保存明细', '改单记录', '自定义商品']) {
      expect(groupPreview).not.toContain(forbidden)
    }
  })
})
