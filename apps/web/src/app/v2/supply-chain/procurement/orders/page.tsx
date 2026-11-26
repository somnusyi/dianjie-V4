'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { money, shortDate, unitPriceMoney, UPSTREAM_ORDER_STATUS_LABEL } from '@/lib/upstream-procurement'

type Supplier = { id: string; no: string; name: string }
type Warehouse = { id: string; code: string; name: string }
type OrderLine = {
  id: string
  productCodeSnapshot?: string | null
  productNameSnapshot: string
  productSpecSnapshot?: string | null
  purchaseUnit: string
  orderedQty: string | number
  confirmedQty?: string | number | null
  shippedQty?: string | number
  receivedQty?: string | number
  unitPrice: string | number
  totalAmount?: string | number
}
type RevisionLine = { id: string; quantity: string | number; unitPrice: string | number }
type Revision = {
  id: string
  status: string
  reason: string
  revisionNo: number
  beforeSnapshot?: { lines?: RevisionLine[] }
  afterSnapshot?: { lines?: RevisionLine[] }
}
type Order = {
  id: string
  no: string
  createdAt: string
  status: string
  supplierId: string
  supplier: Supplier
  warehouse: Warehouse
  expectedArrivalAt?: string | null
  currency?: string
  totalAmount: string | number
  note?: string | null
  lines?: OrderLine[]
  _count?: { lines: number; shipments: number; receipts: number }
  rowVersion?: number
  revisions?: Revision[]
}
type OrderAction = 'send' | 'send-legacy' | 'accept-price' | 'reject-price'
type Filters = { orderQuery: string; supplierId: string; dateFrom: string; dateTo: string; productQuery: string; status: string }

const EMPTY_FILTERS: Filters = { orderQuery: '', supplierId: '', dateFrom: '', dateTo: '', productQuery: '', status: '' }
const PAGE_SIZE = 20
const FILTER_FIELD_CLASS = 'mt-1 h-10 w-full min-w-0 rounded-md border border-[#c9c9c9] bg-white px-3 text-caption text-gray1 shadow-sm outline-none placeholder:text-[#aaa] focus:border-[#ff8200] focus:ring-2 focus:ring-[#ff8200]/20'

function orderStatusTone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'gray' {
  if (['RECEIVED', 'SETTLED', 'CLOSED'].includes(status)) return 'green'
  if (status === 'CANCELLED') return 'red'
  if (['PENDING_APPROVAL', 'CHANGE_PROPOSED', 'SETTLEMENT_PENDING'].includes(status)) return 'amber'
  if (['SUBMITTED_TO_SUPPLIER', 'SUPPLIER_ACCEPTED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'PARTIALLY_RECEIVED'].includes(status)) return 'blue'
  return 'gray'
}

function shanghaiDateTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
}

export default function PurchaseOrderHistoryPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Order | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [action, setAction] = useState<OrderAction | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [notice, setNotice] = useState('')

  const loadOrders = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ paginated: 'true', page: String(page), pageSize: String(PAGE_SIZE), dateField: 'createdAt' })
      for (const [key, value] of Object.entries(filters)) if (value.trim()) query.set(key, value.trim())
      const result = await apiFetch<{ items: Order[]; total: number }>(`/api/upstream/purchase-orders?${query}`)
      setOrders(result.items || [])
      setTotal(result.total || 0)
      const lastPage = Math.max(1, Math.ceil((result.total || 0) / PAGE_SIZE))
      if (page > lastPage) setPage(lastPage)
    } catch (reason: any) {
      setError(reason?.message || '采购记录加载失败')
      setOrders([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [filters, page])

  useEffect(() => { void loadOrders() }, [loadOrders])
  useEffect(() => {
    let active = true
    apiFetch<{ suppliers: Supplier[] }>('/api/upstream/setup-options')
      .then(result => { if (active) setSuppliers(result.suppliers || []) })
      .catch(() => { if (active) setSuppliers([]) })
    return () => { active = false }
  }, [])

  async function openDetail(order: Order) {
    setDetailLoading(true)
    setError('')
    setAction(null)
    setRejectReason('')
    try {
      setDetail(await apiFetch<Order>(`/api/upstream/purchase-orders/${encodeURIComponent(order.id)}`))
    } catch (reason: any) {
      setError(reason?.message || '采购单明细加载失败')
    } finally {
      setDetailLoading(false)
    }
  }

  async function applyOrderAction() {
    if (!detail || !action || actionLoading) return
    const pendingRevision = detail.revisions?.find(revision => revision.status === 'PENDING')
    if ((action === 'accept-price' || action === 'reject-price') && (!pendingRevision || detail.rowVersion == null)) {
      setError('改单已变化，请刷新采购单后重试')
      return
    }
    if (action === 'reject-price' && !rejectReason.trim()) {
      setError('请填写驳回理由')
      return
    }
    setActionLoading(true)
    setError('')
    try {
      const path = `/api/upstream/purchase-orders/${encodeURIComponent(detail.id)}`
      if (action === 'send') await apiFetch(`${path}/send-to-supplier`, { method: 'POST' })
      else if (action === 'send-legacy') await apiFetch(`${path}/approve-and-send`, { method: 'POST' })
      else await apiFetch(`${path}/revisions/${encodeURIComponent(pendingRevision!.id)}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision: action === 'accept-price' ? 'ACCEPT' : 'REJECT', rowVersion: detail.rowVersion, ...(action === 'reject-price' ? { note: rejectReason.trim() } : {}) }),
      })
      setNotice(action === 'send' || action === 'send-legacy' ? '采购单已发送供应商' : action === 'accept-price' ? '已同意调价' : '已驳回调价')
      setAction(null)
      setRejectReason('')
      setDetail(await apiFetch<Order>(path))
      await loadOrders()
    } catch (reason: any) {
      setError(reason?.message || '操作失败，请刷新后重试')
    } finally {
      setActionLoading(false)
    }
  }

  function applyFilters() {
    if (draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo) {
      setError('结束日期不能早于开始日期')
      return
    }
    setError('')
    setPage(1)
    setFilters({ ...draft })
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(1)
    setError('')
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <div className="min-h-screen bg-white px-4 py-5 lg:px-8 lg:py-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <h1 className="text-h1">采购记录</h1>
        <Link href="/v2/supply-chain/procurement" className="rounded-cta border border-border bg-white px-4 py-2 text-button">返回发起采购</Link>
      </header>

      <section aria-label="采购记录筛选" className="my-4 border border-[#dedede] bg-white p-4">
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-caption font-medium text-gray1">采购单号<input aria-label="采购单号" value={draft.orderQuery} onChange={event => setDraft(current => ({ ...current, orderQuery: event.target.value }))} placeholder="输入单号" className={FILTER_FIELD_CLASS} /></label>
          <label className="block text-caption font-medium text-gray1">供应商<select aria-label="供应商" value={draft.supplierId} onChange={event => setDraft(current => ({ ...current, supplierId: event.target.value }))} className={FILTER_FIELD_CLASS}><option value="">全部供应商</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}</select></label>
          <label className="block text-caption font-medium text-gray1">商品<input aria-label="商品" value={draft.productQuery} onChange={event => setDraft(current => ({ ...current, productQuery: event.target.value }))} placeholder="名称或编码" className={FILTER_FIELD_CLASS} /></label>
          <label className="block text-caption font-medium text-gray1">状态<select aria-label="状态" value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value }))} className={FILTER_FIELD_CLASS}><option value="">全部状态</option>{Object.entries(UPSTREAM_ORDER_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="block text-caption font-medium text-gray1">下单开始日期<input aria-label="开始日期" type="date" value={draft.dateFrom} onChange={event => setDraft(current => ({ ...current, dateFrom: event.target.value }))} className={FILTER_FIELD_CLASS} /></label>
          <label className="block text-caption font-medium text-gray1">下单结束日期<input aria-label="结束日期" type="date" value={draft.dateTo} onChange={event => setDraft(current => ({ ...current, dateTo: event.target.value }))} className={FILTER_FIELD_CLASS} /></label>
          <div className="flex items-end gap-2"><button type="button" onClick={applyFilters} className="h-10 rounded-md border border-gray1 bg-gray1 px-5 text-button text-white hover:bg-gray2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">查询</button><button type="button" onClick={resetFilters} className="h-10 rounded-md border border-[#c9c9c9] bg-white px-5 text-button text-gray1 hover:border-[#ff8200] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8200]">重置</button></div>
          <div className="flex items-end justify-start text-caption text-gray2 lg:justify-end">共 {total} 张采购单</div>
        </div>
      </section>

      {error && <div role="alert" className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {notice && <div role="status" className="mb-4 rounded-card border border-green/30 bg-green/10 p-3 text-caption text-green">{notice}</div>}
      {loading ? <div className="rounded-card border border-border bg-white py-16 text-center text-caption text-gray3">正在加载采购记录…</div> : orders.length === 0 ? <div className="rounded-card border border-border bg-white py-16 text-center text-caption text-gray3">没有符合筛选条件的采购单</div> : <div className="overflow-x-auto border border-border bg-white">
        <table className="w-full min-w-[980px] table-fixed text-left text-caption"><thead className="bg-bg text-gray1"><tr><th className="w-[19%] px-3 py-2.5">采购单号 / 下单时间</th><th className="w-[17%] px-3 py-2.5">供应商</th><th className="w-[17%] px-3 py-2.5">商品</th><th className="w-[18%] px-3 py-2.5">收货仓 / 到货日</th><th className="w-[11%] px-3 py-2.5 text-right">金额</th><th className="w-[10%] px-3 py-2.5">状态</th><th className="w-[8%] px-3 py-2.5">操作</th></tr></thead>
          <tbody className="divide-y divide-border">{orders.map((order, index) => <tr key={order.id} className={index % 2 ? "bg-bg/60" : "bg-white"}><td className="px-3 py-2.5 align-top"><button type="button" onClick={() => void openDetail(order)} aria-label={`查看采购单 ${order.no} 明细`} className="font-medium text-accent underline">{order.no}</button><div className="mt-1 whitespace-nowrap text-gray3">{shanghaiDateTime(order.createdAt)}</div></td><td className="px-3 py-2.5 align-top"><b>{order.supplier.name}</b><div className="text-gray3">{order.supplier.no}</div></td><td className="max-w-xs px-3 py-2.5 align-top"><div className="truncate">{order.lines?.map(line => line.productNameSnapshot).join('、') || '—'}</div><div className="mt-1 text-gray3">{order._count?.lines || order.lines?.length || 0} 项</div></td><td className="px-3 py-2.5 align-top"><b>{order.warehouse.name}</b><div className="mt-1 text-gray3">{shortDate(order.expectedArrivalAt)}</div></td><td className="px-3 py-2.5 text-right align-top font-num">{money(order.totalAmount)}</td><td className="px-3 py-2.5 align-top"><Chip tone={orderStatusTone(order.status)}>{UPSTREAM_ORDER_STATUS_LABEL[order.status] || order.status}</Chip></td><td className="px-3 py-2.5 align-top"><button type="button" disabled={detailLoading} onClick={() => void openDetail(order)} className="text-accent underline disabled:opacity-50">{['DRAFT', 'PENDING_APPROVAL', 'CHANGE_PROPOSED'].includes(order.status) ? '查看并处理' : '查看明细'}</button></td></tr>)}</tbody>
        </table>
      </div>}

      <div className="mt-4 flex items-center justify-end gap-3 text-caption"><button type="button" disabled={loading || page <= 1} onClick={() => setPage(value => value - 1)} className="rounded-cta border border-border bg-white px-3 py-2 disabled:opacity-40">上一页</button><span>第 {page} / {pageCount} 页 · 每页 {PAGE_SIZE} 条</span><button type="button" disabled={loading || page >= pageCount} onClick={() => setPage(value => value + 1)} className="rounded-cta border border-border bg-white px-3 py-2 disabled:opacity-40">下一页</button></div>

      {detail && <div role="dialog" aria-modal="true" aria-label={`采购单明细 ${detail.no}`} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-6" onMouseDown={event => { if (event.target === event.currentTarget) setDetail(null) }}><section className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-t-card bg-white p-5 shadow-xl md:rounded-card"><header className="flex items-start justify-between gap-4 border-b border-border pb-4"><div><div className="flex items-center gap-2"><h2 className="text-h2">采购单明细 · {detail.no}</h2><Chip tone={orderStatusTone(detail.status)}>{UPSTREAM_ORDER_STATUS_LABEL[detail.status] || detail.status}</Chip></div><p className="mt-1 text-caption text-gray3">{detail.supplier.name} · {detail.warehouse.name} · {shanghaiDateTime(detail.createdAt)}</p></div><button type="button" onClick={() => setDetail(null)} aria-label="关闭明细" className="px-2 text-h2 text-gray3">×</button></header>
        <dl className="grid gap-3 border-b border-border py-4 text-caption md:grid-cols-4"><div><dt className="text-gray3">预计到货日</dt><dd className="mt-1 font-medium">{shortDate(detail.expectedArrivalAt)}</dd></div><div><dt className="text-gray3">币种</dt><dd className="mt-1 font-medium">{detail.currency || 'CNY'}</dd></div><div><dt className="text-gray3">商品数</dt><dd className="mt-1 font-medium">{detail.lines?.length || 0} 项</dd></div><div><dt className="text-gray3">采购单金额</dt><dd className="mt-1 font-medium">{money(detail.totalAmount)}</dd></div></dl>
        <div className="overflow-x-auto py-4"><table className="w-full min-w-[760px] text-left text-caption"><thead className="bg-bg text-gray3"><tr><th className="p-3">序号</th><th className="p-3">商品</th><th className="p-3">采购单位</th><th className="p-3 text-right">下单数量</th><th className="p-3 text-right">已发 / 已收</th><th className="p-3 text-right">单价</th><th className="p-3 text-right">金额</th></tr></thead><tbody className="divide-y divide-border">{detail.lines?.map((line, index) => <tr key={line.id}><td className="p-3">{index + 1}</td><td className="p-3"><b>{line.productNameSnapshot}</b><div className="text-gray3">{line.productCodeSnapshot || '—'}{line.productSpecSnapshot ? ` · ${line.productSpecSnapshot}` : ''}</div></td><td className="p-3">{line.purchaseUnit}</td><td className="p-3 text-right font-num">{Number(line.orderedQty).toLocaleString('zh-CN')}</td><td className="p-3 text-right font-num">{Number(line.shippedQty || 0).toLocaleString('zh-CN')} / {Number(line.receivedQty || 0).toLocaleString('zh-CN')}</td><td className="p-3 text-right font-num">{unitPriceMoney(line.unitPrice)}</td><td className="p-3 text-right font-num">{money(line.totalAmount ?? Number(line.orderedQty) * Number(line.unitPrice))}</td></tr>)}</tbody></table>{!detail.lines?.length && <p className="py-10 text-center text-caption text-gray3">该采购单暂无商品明细</p>}</div>
        {detail.note && <div className="rounded-cta bg-bg p-3 text-caption"><span className="text-gray3">备注：</span>{detail.note}</div>}
        {detail.status === 'CHANGE_PROPOSED' && detail.revisions?.find(revision => revision.status === 'PENDING') && (() => {
          const revision = detail.revisions!.find(item => item.status === 'PENDING')!
          return <section className="mt-4 border-t border-border pt-4" aria-label="待确认调价">
            <h3 className="text-h3">供应商调价申请</h3>
            <p className="mt-1 text-caption">原因：{revision.reason}</p>
            <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-caption"><thead className="bg-bg"><tr><th className="p-2">商品</th><th className="p-2">原单价</th><th className="p-2">申请单价</th></tr></thead><tbody>{revision.afterSnapshot?.lines?.map(after => {
              const before = revision.beforeSnapshot?.lines?.find(item => item.id === after.id)
              const line = detail.lines?.find(item => item.id === after.id)
              if (!before || String(before.unitPrice) === String(after.unitPrice)) return null
              return <tr key={after.id} className="border-t border-border"><td className="p-2">{line?.productNameSnapshot || '—'}</td><td className="p-2">{unitPriceMoney(before.unitPrice)} 元/{line?.purchaseUnit || '—'}</td><td className="p-2 font-medium">{unitPriceMoney(after.unitPrice)} 元/{line?.purchaseUnit || '—'}</td></tr>
            })}</tbody></table></div>
          </section>
        })()}
        {['DRAFT', 'PENDING_APPROVAL', 'CHANGE_PROPOSED'].includes(detail.status) && <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          {detail.status === 'DRAFT' && <button type="button" onClick={() => setAction('send')} className="rounded-cta bg-accent px-4 py-2 text-button text-white">发送供应商</button>}
          {detail.status === 'PENDING_APPROVAL' && <button type="button" onClick={() => setAction('send-legacy')} className="rounded-cta bg-accent px-4 py-2 text-button text-white">发送供应商</button>}
          {detail.status === 'CHANGE_PROPOSED' && <><button type="button" onClick={() => setAction('reject-price')} className="rounded-cta border border-border px-4 py-2 text-button">驳回调价</button><button type="button" onClick={() => setAction('accept-price')} className="rounded-cta bg-accent px-4 py-2 text-button text-white">同意调价</button></>}
        </div>}
        {action && <div className="mt-4 rounded-cta border border-border bg-bg p-4" aria-label="确认采购操作">
          <p className="font-medium">{action === 'send' || action === 'send-legacy' ? '确认发送给供应商？' : action === 'accept-price' ? '确认按申请单价更新采购单？' : '确认驳回供应商调价？'}</p>
          {action === 'reject-price' && <textarea aria-label="驳回理由" value={rejectReason} onChange={event => setRejectReason(event.target.value)} placeholder="填写驳回理由" className="input mt-3 min-h-20" />}
          <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setAction(null)} disabled={actionLoading} className="rounded-cta border border-border bg-white px-4 py-2 text-button">取消</button><button type="button" onClick={() => void applyOrderAction()} disabled={actionLoading} className="rounded-cta bg-accent px-4 py-2 text-button text-white disabled:opacity-50">{actionLoading ? '处理中…' : '确认'}</button></div>
        </div>}
      </section></div>}
    </div>
  )
}
