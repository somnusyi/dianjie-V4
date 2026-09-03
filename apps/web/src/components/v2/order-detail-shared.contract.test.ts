import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const singlePage = readFileSync(new URL('../../app/v2/supplier/orders/[id]/page.tsx', import.meta.url), 'utf8')
const groupPage = readFileSync(new URL('../../app/v2/supply-chain/fulfillment/group/[groupId]/page.tsx', import.meta.url), 'utf8')
const deliveryNotePage = readFileSync(new URL('../../app/v2/supplier/orders/[id]/delivery-note/page.tsx', import.meta.url), 'utf8')
const sharedComponent = readFileSync(new URL('./order-detail-shared.tsx', import.meta.url), 'utf8')

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

  it('loads the complete warehouse-scoped product catalog on both editing pages', () => {
    for (const source of [singlePage, groupPage]) {
      expect(source).toContain('loadAllWarehouseProductCatalog')
      expect(source).toContain("from '@/lib/load-product-catalog'")
      expect(source).toContain('await loadAllWarehouseProductCatalog(')
      expect(source).toContain('matchesWarehouseProductSearch')
      expect(source).toContain('搜索商品名称')
      expect(source).not.toContain('名称 / 编码 / 规格 / 分类')
    }
  })

  it('keeps the shared product table as the only owner of its save control and column order', () => {
    expect(sharedComponent.match(/\{props\.saving \? '保存中…' : '保存'\}/g)).toHaveLength(1)
    expect(sharedComponent).toContain('序号</th><th className="px-3 py-2">名称</th><th className="px-3 py-2">规格</th>')
    expect(sharedComponent).toContain('数量</th><th className="px-3 py-2 text-right">单价</th><th className="px-3 py-2 text-right">总价</th>')
    expect(sharedComponent).toContain('w-full table-auto')
  })

  it('makes add-product actions and selected catalog rows visually unambiguous', () => {
    expect(sharedComponent).toContain('border border-amber bg-amber px-3 py-1.5 text-button text-white shadow-sm')

    expect(singlePage).toContain('aria-pressed={selected}')
    expect(singlePage).toContain("selected ? 'border-l-amber bg-amber/20' : 'border-l-transparent hover:bg-bg'")
    expect(singlePage).toContain('✓ 已选择')
  })

  it('uses one page-level vertical scroll while keeping the delivery action fixed', () => {
    const productTable = sharedComponent.slice(sharedComponent.indexOf('export function OrderProductTable'))
    expect(productTable).not.toContain('max-h-[60vh]')
    expect(productTable).not.toContain('overflow-y-auto')
    expect(productTable).not.toContain('sticky top-0')

    const deliveringAction = singlePage.slice(
      singlePage.indexOf("order.status === 'DELIVERING'"),
      singlePage.indexOf('接单前改单申请抽屉'),
    )
    expect(deliveringAction).toContain('fixed bottom-0 left-0 right-0')
    expect(singlePage).toContain('min-h-screen bg-bg pb-32')
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
    expect(deliveryNotePage).toContain("['#', '品名', '规格', '单位', '数量', '单价(¥)', '发货金额(¥)', '成本金额(¥)']")
    expect(deliveryNotePage).toContain("['合计', '', '', '', totalQtyLocal, '', Number(totalLocal.toFixed(2)),")
    expect(deliveryNotePage).toContain("it.costAmount != null ? Number(Number(it.costAmount).toFixed(2)) : '—'")
    expect(deliveryNotePage).toContain('exportOrder.costAmount == null ? null : Number(exportOrder.costAmount)')
    expect(deliveryNotePage).toContain("['F', 'G', 'H']")
    expect(deliveryNotePage).toContain('>实发金额</td>')
    expect(deliveryNotePage).not.toContain('原订货单总额')
  })

  it('does not reintroduce duplicate legacy sections or a second group delivery-note action', () => {
    for (const forbidden of ['打印集合送货单', '保存明细', '改单记录', '自定义商品']) {
      expect(groupPage).not.toContain(forbidden)
    }
    for (const source of [singlePage, groupPage]) expect(source).not.toContain('待门店确认')
    expect(groupPage.match(/\/delivery-note\?preview=/g)).toHaveLength(1)
  })
})
