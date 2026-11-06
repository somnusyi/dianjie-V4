import React from 'react'
import dayjs from '@/lib/business-dayjs'
import { sortDeliveryNoteItems, type DeliveryProduct } from '@/lib/delivery-note-layout'

type PaperItem = {
  id: string; quantity: string; shippedQty: string | null; unitPrice: string; amount: string
  product?: DeliveryProduct
  note?: string | null
}
export type DeliveryNotePaperOrder = {
  no: string; documentCreatedAt?: string; purchaseOrderNo?: string; createdAt: string; expectedDate: string; shippedAt: string | null
  note: string | null; shippedNote: string | null
  supplier: { name: string; contactName?: string | null; contactPhone?: string | null }
  store: { name: string; address?: string | null; managerName?: string | null; phone?: string | null }
  consignee?: { name?: string | null; phone?: string | null }
  createdBy: { name: string }
  items: PaperItem[]
}
type Member = { id: string; no: string; deliveryNo?: string | null; deliveryNos?: string[]; createdAt: string }

export function DeliveryNotePaper({ order, members, categories = [], printedAt }: {
  order: DeliveryNotePaperOrder; members?: Member[] | null; categories?: string[]; printedAt: Date
}) {
  const items = sortDeliveryNoteItems(order.items, categories)
  const quantity = (item: PaperItem) => Number(item.shippedQty ?? item.quantity)
  const amount = (item: PaperItem) => item.amount != null ? Number(item.amount) : quantity(item) * Number(item.unitPrice)
  const total = items.reduce((sum, item) => sum + amount(item), 0)
  const totalQty = items.reduce((sum, item) => sum + quantity(item), 0)
  const references = members?.length ? members : [{ id: order.no, no: order.no, createdAt: order.createdAt }]
  const referenceDate = references[0].createdAt
  const referenceNumbers = Array.from(new Set(references.flatMap(member =>
    member.deliveryNos?.length ? member.deliveryNos : [member.deliveryNo || member.no],
  )))
  const contact = [order.supplier.contactName, order.supplier.contactPhone].filter(Boolean).join(' · ') || '—'
  const consignee = [order.consignee?.name ?? order.store.managerName, order.consignee?.phone ?? order.store.phone].filter(Boolean).join(' · ') || '—'
  return <div id="print-area" data-delivery-note-print className="print-page mx-auto my-6 bg-white shadow-md"
    style={{ width: '210mm', minHeight: '297mm', padding: '12mm' }}>
    <section data-delivery-note-header>
      <div data-delivery-note-letterhead><h1>送货单</h1><div data-delivery-note-company>{order.supplier.name}</div></div>
      <div data-delivery-note-references>
        <span data-delivery-note-time>下单日期：{dayjs(referenceDate).format(/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm')}</span>
        <div data-delivery-note-numbers><span>订单号：</span>{referenceNumbers.map(no =>
          <span data-delivery-note-reference key={no}>{no}</span>,
        )}</div>
      </div>
      <div data-delivery-note-parties>
        <div>收货方：{order.store.name}</div><div className="delivery-contact">供货方联系人：{contact}</div>
        <div className="delivery-contact">收货人：{consignee}</div><div>下单人：{order.createdBy?.name || '—'}</div>
        <div>期望到货：{dayjs(order.expectedDate).format('YYYY-MM-DD')}</div>
        <div>发货时间：{order.shippedAt ? dayjs(order.shippedAt).format('YYYY-MM-DD HH:mm') : '—'}</div>
      </div>
      {order.store.address && <div data-delivery-note-address>收货地址：{order.store.address}</div>}
      {order.purchaseOrderNo && <div data-delivery-note-address>来源订货单：{order.purchaseOrderNo}</div>}
      <div>收货人签字区域：________________</div>
      {order.note && <div>备注：{order.note}</div>}{order.shippedNote && <div>发货备注：{order.shippedNote}</div>}
    </section>
    <table data-delivery-note-items>
      <colgroup>{[6, 12, 12.5, 17, 11.5, 7, 7, 10, 11, 6].map((width, i) => <col key={i} style={{ width: `${width}%` }} />)}</colgroup>
      <thead><tr><th className="delivery-center" aria-label="序号" /><th className="delivery-center">库位</th><th className="delivery-center">物品类别</th>
        <th className="delivery-center">物品名称</th><th className="delivery-center">规格型号</th><th className="delivery-center">订货单位</th>
        <th className="delivery-center">发货数量</th><th className="delivery-center">单价</th><th className="delivery-center">发货金额</th><th className="delivery-center">备注</th></tr></thead>
      {items.map((item, index) => <tbody key={item.id} data-delivery-note-row data-category={item.product?.category || '其他'}><tr>
        <td className="delivery-center">{index + 1}</td><td className={`delivery-center ${item.product?.location?.trim() ? '' : 'delivery-location-empty'}`}>{item.product?.location || ''}</td>
        <td className="delivery-center">{item.product?.category || '其他'}</td><td className="delivery-name">{item.product?.name || '—'}</td>
        <td>{item.product?.spec || '—'}</td><td className="delivery-center">{item.product?.unit || '—'}</td>
        <td className="delivery-number">{quantity(item)}</td><td className="delivery-number">{Number(item.unitPrice).toFixed(2)}</td>
        <td className="delivery-number">{amount(item).toFixed(2)}</td><td>{item.note || ''}</td>
      </tr></tbody>)}
      <tbody data-delivery-note-totals><tr><td>合计</td><td /><td /><td /><td /><td />
        <td className="delivery-number">{Number(totalQty.toFixed(6))}</td><td /><td className="delivery-number">{total.toFixed(2)}</td><td />
      </tr></tbody>
    </table>
    <div data-delivery-note-footer>
      <div className="delivery-footer-info"><span>制单日期：{dayjs(order.documentCreatedAt || order.createdAt).format('YYYY-MM-DD HH:mm:ss')}</span>
        <span>收货电话：{order.consignee?.phone ?? order.store.phone ?? '—'}</span></div>
    </div>
  </div>
}
