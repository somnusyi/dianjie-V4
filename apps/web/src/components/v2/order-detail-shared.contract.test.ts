import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const singlePage = readFileSync(new URL('../../app/v2/supplier/orders/[id]/page.tsx', import.meta.url), 'utf8')
const groupPage = readFileSync(new URL('../../app/v2/supply-chain/fulfillment/group/[groupId]/page.tsx', import.meta.url), 'utf8')
const deliveryNotePage = readFileSync(new URL('../../app/v2/supplier/orders/[id]/delivery-note/page.tsx', import.meta.url), 'utf8')
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

  it('loads the complete paginated product catalog on both editing pages', () => {
    for (const source of [singlePage, groupPage]) {
      expect(source).toContain("import { loadAllProductCatalog } from '@/lib/load-product-catalog'")
      expect(source).toContain('await loadAllProductCatalog(')
    }
  })

  it('keeps the shared product table as the only owner of its save control and column order', () => {
    expect(sharedComponent.match(/\{props\.saving \? '保存中…' : '保存'\}/g)).toHaveLength(1)
    expect(sharedComponent).toContain('序号</th><th className="px-3 py-2">名称</th><th className="px-3 py-2">规格</th>')
    expect(sharedComponent).toContain('数量</th><th className="px-3 py-2 text-right">单价</th><th className="px-3 py-2 text-right">总价</th>')
  })

  it('keeps horizontal range controls out of shared order details', () => {
    expect(sharedComponent).not.toContain('HorizontalDragArea')
    expect(sharedComponent).not.toContain('aria-label="横向拖动查看完整内容"')
    const productTable = sharedComponent.slice(sharedComponent.indexOf('export function OrderProductTable'))
    expect(productTable).not.toContain('type="range"')
  })

  it('flattens delivery products into one numbered list without delivery numbers or grouping', () => {
    const groupLines = groupPage.slice(
      groupPage.indexOf('const deliveryLines ='),
      groupPage.indexOf('const filteredCatalog ='),
    )
    expect(groupLines).toContain('flatMap(delivery =>')
    expect(groupLines).toContain('delivery.items.map(item =>')
    expect(groupLines).not.toContain('delivery.no')

    const singleLines = singlePage.slice(
      singlePage.indexOf('<OrderDeliverySummary lines='),
      singlePage.indexOf('<OrderProgressCard'),
    )
    expect(singleLines).toContain('.flatMap(delivery => delivery.items.map(item =>')
    expect(singleLines).not.toContain('delivery.no')
    expect(sharedComponent).toContain('{index + 1}.')
  })

  it('keeps the simplified amount language on both pages', () => {
    expect(sharedComponent).toContain('原始订单金额 ¥{props.originalOrderAmount}')
    for (const source of [singlePage, groupPage]) {
      expect(source).not.toContain('原始订货')
      expect(source).not.toContain('当前第 {order.currentRevisionNo} 版')
      expect(source).not.toContain('三者不混用')
      expect(source).not.toContain('SUPPLIER_MONEY_TERMS.payableAmount')
    }
    expect(groupPage).not.toContain('>订货金额</th>')
    expect(singlePage).toContain('order.originalTotalAmount ?? order.totalAmount')
    expect(groupPage).toContain('detail.totals.originalOrderAmount')
    expect(singlePage).toContain('displayedShipmentAmount')
    expect(groupPage).toContain('detailEditable ? productTotal : detail.totals.hasAnyShipment ? detail.totals.shipmentAmount : productTotal')
  })

  it('places the original order amount in the same left-hand block below the store name', () => {
    const card = sharedComponent.slice(
      sharedComponent.indexOf('export function OrderAmountCard'),
      sharedComponent.indexOf('export function OrderDeliverySummary'),
    )
    const nameIndex = card.indexOf('{props.name}')
    const originalIndex = card.indexOf('原始订单金额 ¥{props.originalOrderAmount}')
    const shipmentLabelIndex = card.indexOf('{props.amountLabel}')
    expect(nameIndex).toBeGreaterThan(-1)
    expect(originalIndex).toBeGreaterThan(nameIndex)
    expect(originalIndex).toBeLessThan(shipmentLabelIndex)
  })

  it('keeps a batch shipment path after a group has been accepted', () => {
    expect(groupPage).toContain("const shipmentEditable = detail?.source === 'accepted'")
    expect(groupPage).toContain("order.status === 'CONFIRMED'")
    expect(groupPage).toContain('`/api/orders/${encodeURIComponent(order.id)}/ship`')
    expect(groupPage).toContain('批量确认发货')
  })

  it('keeps zero quantity and removal as separate actions', () => {
    expect(singlePage).toContain('return { ...prev, [pid]: q }')
    expect(singlePage).toContain('removeOrderProduct(row.productId)')
    const orderRevisionPayload = groupPage.slice(
      groupPage.indexOf('const orders = detail.orders.map(order => ({'),
      groupPage.indexOf('const requestKey = requestKeyRef.current'),
    )
    expect(orderRevisionPayload).toContain('row.orderId === order.id).map(row => ({ productId: row.productId, quantity: row.quantity }))')
    expect(orderRevisionPayload).not.toContain('row.quantity > 0')
  })

  it('labels printed and exported totals as shipment amount', () => {
    expect(deliveryNotePage).toContain("['发货金额', '', '', '', totalQtyLocal")
    expect(deliveryNotePage).toContain("['成本金额', '', '', '', '', '', costTotalLocal")
    expect(deliveryNotePage).toContain('order.costAmount == null ? null : Number(order.costAmount)')
    expect(deliveryNotePage).toContain('>实发金额</td>')
    expect(deliveryNotePage).not.toContain('原订货单总额')
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
