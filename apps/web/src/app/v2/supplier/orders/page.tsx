/**
 * 供应商 App · 订单 Tab  PDF: supplier_order_list_and_detail
 * 接真实 GET /api/orders (后端按 supplierId 自动过滤)
 * 发货必须进入详情页逐项核对实发数量。
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip, ProgressDots } from '@/components/v2'
import { apiFetch, getUser } from '@/lib/v2-auth'
import {
  SUPPLIER_MONEY_TERMS,
  supplierDeliveryStatusMeta,
  supplierOrderStatusMeta,
} from '@/lib/supplier-domain'
import dayjs from 'dayjs'
import { SUPPLIER_DIFFERENCES_PATH, supplierOrdersLegacyDifferenceRedirect } from './legacy-difference-redirect'

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  originalTotalAmount?: string | null; currentOrderAmount?: string | null
  expectedDate: string; createdAt: string; submittedAt?: string | null
  shippedAt: string | null
  store: { id: string; name: string }
  supplier?: { id: string; name: string }
  items: { id: string; quantity: string; unitPrice: string; product?: { name: string; unit: string } }[]
  lossClaims?: { id: string; status: string; totalLossAmount: string }[]
  deliveries?: { id: string; status: string; actualTotalAmount: string }[]
  receipts?: { id: string; status: string; totalAmount: string }[]
}

type Delivery = {
  id: string; no: string; status: string; actualTotalAmount: string
  createdAt: string; shippedAt?: string | null; deliveredAt?: string | null; receivedAt?: string | null
  store: { id: string; name: string }
  purchaseOrder: { id: string; no: string; status: string }
  receipt?: { id: string; no: string; status: string } | null
  items: {
    id: string; shippedQty: string; receivedQty?: string | null
    product: { id: string; code: string; name: string; unit: string; spec?: string | null }
  }[]
}

type SearchCriteria = { keyword: string; dateFrom: string; dateTo: string }
const EMPTY_SEARCH: SearchCriteria = { keyword: '', dateFrom: '', dateTo: '' }

type LossClaim = {
  id: string; status: string; totalLossAmount: string
}

export default function SupplierOrdersPage() {
  const internalSupplyChain = getUser()?.role === 'SUPPLY_CHAIN'
  const orderBase = internalSupplyChain ? '/v2/supply-chain/fulfillment' : '/v2/supplier/orders'
  const workspaceHome = internalSupplyChain ? '/v2/supply-chain/home' : '/v2/supplier/home'
  const inventoryHome = internalSupplyChain ? '/v2/supply-chain/inventory' : '/v2/supplier/inventory'
  const billingHome = internalSupplyChain ? '/v2/supply-chain/billing' : '/v2/supplier/billing'
  const [tab, setTab] = useState('orders')
  const [documentView, setDocumentView] = useState<'orders' | 'deliveries'>('orders')
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null)
  const [claims, setClaims] = useState<LossClaim[] | null>(null)
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [deliveriesTotal, setDeliveriesTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [loadingDeliveries, setLoadingDeliveries] = useState(false)
  const [searchDraft, setSearchDraft] = useState<SearchCriteria>(EMPTY_SEARCH)
  const [appliedSearch, setAppliedSearch] = useState<SearchCriteria>(EMPTY_SEARCH)
  const legacyDifferenceRedirect = typeof window === 'undefined' ? null : supplierOrdersLegacyDifferenceRedirect(window.location.search)
  const [filter, setFilter] = useState<'待接单' | '待发货' | '运送中' | '已完成' | '已取消'>(() => {
    if (typeof window === 'undefined') return '待接单'
    const sp = new URLSearchParams(window.location.search)
    const raw = sp.get('filter')
    return ['待接单', '待发货', '运送中', '已完成', '已取消'].includes(String(raw)) ? raw as any : '待接单'
  })

  function buildListQuery(page: number, pageSize: number, criteria = appliedSearch, orderFilter?: string) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (criteria.keyword.trim()) params.set('keyword', criteria.keyword.trim())
    if (criteria.dateFrom) params.set('dateFrom', criteria.dateFrom)
    if (criteria.dateTo) params.set('dateTo', criteria.dateTo)
    if (orderFilter === '已取消') params.set('status', 'CANCELLED')
    return params.toString()
  }

  async function load(criteria = appliedSearch, orderFilter = filter) {
    try {
      const [o, c] = await Promise.all([
        apiFetch<{ items: Order[]; total: number }>(`/api/orders?${buildListQuery(1, 50, criteria, orderFilter)}`),
        apiFetch<{ items: LossClaim[]; total: number }>('/api/loss-claims?page=1&pageSize=20')
          .catch(() => ({ items: [] as LossClaim[], total: 0 })),
      ])
      setOrders((o as any).items || (o as any) || [])
      setClaims((c as any).items || (c as any) || [])
      setOrdersTotal(Number((o as any).total ?? (o as any).items?.length ?? 0))
    } catch (e: any) { setError(e.message || '加载失败') }
  }

  async function loadDeliveries(criteria = appliedSearch) {
    setLoadingDeliveries(true)
    try {
      const d = await apiFetch<{ items: Delivery[]; total: number }>(`/api/deliveries?${buildListQuery(1, 50, criteria)}`)
      setDeliveries(d.items || [])
      setDeliveriesTotal(Number(d.total ?? d.items?.length ?? 0))
    } catch (e: any) {
      setError(e.message || '配送单加载失败')
    } finally {
      setLoadingDeliveries(false)
    }
  }

  useEffect(() => {
    if (legacyDifferenceRedirect) {
      location.href = internalSupplyChain ? '/v2/supply-chain/receipts' : legacyDifferenceRedirect
      return
    }
    void load()
    void loadDeliveries()
  }, [])

  function applySearch() {
    if (searchDraft.dateFrom && searchDraft.dateTo && searchDraft.dateFrom > searchDraft.dateTo) {
      setError('开始日期不能晚于结束日期')
      return
    }
    const next = { ...searchDraft, keyword: searchDraft.keyword.trim() }
    setError(null)
    setAppliedSearch(next)
    if (documentView === 'orders') void load(next)
    else void loadDeliveries(next)
  }

  function clearSearch() {
    setSearchDraft(EMPTY_SEARCH)
    setAppliedSearch(EMPTY_SEARCH)
    setError(null)
    if (documentView === 'orders') void load(EMPTY_SEARCH)
    else void loadDeliveries(EMPTY_SEARCH)
  }

  async function loadMoreOrders() {
    if (!orders || loadingOrders) return
    setLoadingOrders(true)
    try {
      const page = Math.floor(orders.length / 50) + 1
      const d = await apiFetch<{ items: Order[]; total: number }>(`/api/orders?${buildListQuery(page, 50, appliedSearch, filter)}`)
      setOrders(current => [...(current || []), ...(d.items || [])])
      setOrdersTotal(Number(d.total ?? ordersTotal))
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoadingOrders(false)
    }
  }

  async function loadMoreDeliveries() {
    if (!deliveries || loadingDeliveries) return
    setLoadingDeliveries(true)
    try {
      const page = Math.floor(deliveries.length / 50) + 1
      const d = await apiFetch<{ items: Delivery[]; total: number }>(`/api/deliveries?${buildListQuery(page, 50)}`)
      setDeliveries(current => [...(current || []), ...(d.items || [])])
      setDeliveriesTotal(Number(d.total ?? deliveriesTotal))
    } catch (e: any) {
      setError(e.message || '配送单加载失败')
    } finally {
      setLoadingDeliveries(false)
    }
  }

  const pendingClaims = (claims || []).filter(c => c.status === 'PENDING')

  function statusInTab(s: string, f: string) {
    if (f === '待接单') return s === 'SUBMITTED'
    if (f === '待发货') return s === 'CONFIRMED'
    if (f === '运送中') return s === 'PENDING_CONFIRM' || s === 'DELIVERING'   // DELIVERING 兼容老数据
    if (f === '已完成') return ['RECEIVED', 'COMPLETED'].includes(s)
    if (f === '已取消') return s === 'CANCELLED'
    return false
  }
  const visible = (orders || []).filter(o => statusInTab(o.status, filter))
  // Supplier orders deliberately remain the original one-order workflow.
  // Operation-group listing, batch confirmation, group printing, and group
  // add-product actions belong only to the internal supply-chain page.
  const displayOrders = visible
  const hasMoreOrders = orders !== null && orders.length < ordersTotal
  const hasMoreDeliveries = deliveries !== null && deliveries.length < deliveriesTotal

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">单据</h1>
          <p className="text-caption text-gray3">
            {documentView === 'orders'
              ? orders === null ? '加载中…' : `订货单 ${ordersTotal} 张`
              : deliveries === null || loadingDeliveries && deliveries.length === 0 ? '加载中…' : `配送单 ${deliveriesTotal} 张`}
          </p>
        </div>
      </header>

      <div className="px-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => { setDocumentView('orders'); void load(appliedSearch) }}
          className={`py-2 rounded-cta text-button ${documentView === 'orders' ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
          门店订货单
        </button>
        <button type="button" onClick={() => { setDocumentView('deliveries'); void loadDeliveries(appliedSearch) }}
          className={`py-2 rounded-cta text-button ${documentView === 'deliveries' ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
          配送单
        </button>
      </div>

      <form className="mx-4 mt-3 bg-white border border-border rounded-card p-3 space-y-2" onSubmit={e => { e.preventDefault(); applySearch() }}>
        <input
          value={searchDraft.keyword}
          onChange={e => setSearchDraft(current => ({ ...current, keyword: e.target.value }))}
          placeholder="搜索商品名称 / 编码 / 单号"
          className="w-full px-3 py-2 rounded-cta border border-border bg-bg text-caption outline-none focus:border-ink"
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-micro text-gray3">开始日期
            <input type="date" value={searchDraft.dateFrom}
              onChange={e => setSearchDraft(current => ({ ...current, dateFrom: e.target.value }))}
              className="mt-1 w-full px-2 py-2 rounded-cta border border-border bg-bg text-caption font-num" />
          </label>
          <label className="text-micro text-gray3">结束日期
            <input type="date" value={searchDraft.dateTo}
              onChange={e => setSearchDraft(current => ({ ...current, dateTo: e.target.value }))}
              className="mt-1 w-full px-2 py-2 rounded-cta border border-border bg-bg text-caption font-num" />
          </label>
        </div>
        <div className="grid grid-cols-[1fr_2fr] gap-2">
          <button type="button" onClick={clearSearch} className="py-2 border border-border rounded-cta text-caption text-gray2">清空</button>
          <button type="submit" className="py-2 bg-amber text-white rounded-cta text-button">查询</button>
        </div>
      </form>

      {/* 到货差异待处理 banner（仅 PENDING 数量 > 0 时显示，强制提醒）*/}
      {documentView === 'orders' && pendingClaims.length > 0 && (
        <button
          onClick={() => { location.href = internalSupplyChain ? '/v2/supply-chain/receipts' : SUPPLIER_DIFFERENCES_PATH }}
          className="mx-4 mt-2 w-[calc(100%-32px)] bg-red-bg border border-red/30 rounded-card p-3 flex items-center gap-3 text-left"
        >
          <span className="w-9 h-9 rounded-md bg-red text-white flex items-center justify-center text-h2">⚠</span>
          <div className="flex-1">
            <div className="text-h2 text-red-fg">{pendingClaims.length} 笔到货差异待确认</div>
            <p className="text-micro text-red-fg">涉及 ¥{pendingClaims.reduce((s, c) => s + Number(c.totalLossAmount || 0), 0).toFixed(2)} · 请及时处理；逾期补报须人工审批</p>
          </div>
          <span className="text-red-fg">›</span>
        </button>
      )}

      {documentView === 'orders' && <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {(['待接单', '待发货', '运送中', '到货差异', '已完成', '已取消'] as const).map((f) => {
          const cnt = f === '到货差异'
            ? pendingClaims.length
            : f === '已取消' && filter === '已取消'
              ? ordersTotal
            : (orders || []).filter(o => statusInTab(o.status, f)).length
          const isUrgent = (f === '待接单' || f === '到货差异') && cnt > 0
          return (
            <button key={f} onClick={() => f === '到货差异'
              ? location.href = internalSupplyChain ? '/v2/supply-chain/receipts' : SUPPLIER_DIFFERENCES_PATH
              : (setFilter(f), void load(appliedSearch, f))}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button relative ${f !== '到货差异' && filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              <span>{f}</span>
              {cnt > 0 && <span className={`font-num ml-1 ${f !== '到货差异' && filter === f ? '' : isUrgent ? 'text-red-fg' : 'text-gray3'}`}>{cnt}</span>}
              {isUrgent && (f === '到货差异' || filter !== f) && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red rounded-full" />}
            </button>
          )
        })}
      </div>}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 普通订单 tabs 内容 */}
      {documentView === 'orders' && (
      <ul className="px-4 mt-3 space-y-2">
        {visible.length === 0 && orders !== null && (
          <li className="text-caption text-gray3 text-center py-12">暂无{filter}订单</li>
        )}
        {displayOrders.map(o => {
          const status = supplierOrderStatusMeta(o.status)
          const tone = status.tone
          const stepIdx = Math.max(0, status.progressStep - 1)
          const isToShip = o.status === 'SUBMITTED' || o.status === 'CONFIRMED'
          const orderedAmount = Number(o.currentOrderAmount ?? o.originalTotalAmount ?? o.totalAmount)
          const shippedAmount = (o.deliveries || []).reduce((sum, delivery) => sum + Number(delivery.actualTotalAmount || 0), 0)
          const receivedAmount = (o.receipts || []).reduce((sum, receipt) => sum + Number(receipt.totalAmount || 0), 0)
          const displayAmount = receivedAmount > 0 ? receivedAmount : shippedAmount > 0 ? shippedAmount : orderedAmount
          const displayLabel = receivedAmount > 0
            ? SUPPLIER_MONEY_TERMS.payableAmount
            : shippedAmount > 0 ? SUPPLIER_MONEY_TERMS.shipmentAmount : SUPPLIER_MONEY_TERMS.orderedAmount
          return (
            <li key={o.id}
                onClick={() => location.href = `${orderBase}/${o.id}`}
                className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'} cursor-pointer hover:bg-bg-warm transition-colors`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={tone}>{status.label}</Chip>
                {isToShip && <Chip tone="red">需即办</Chip>}
                {/* 已完成 tab 内的报损标识 */}
                {(o.status === 'RECEIVED' || o.status === 'COMPLETED') && (o.lossClaims?.length ?? 0) > 0 && (
                  <Chip tone="orange">含报损 ¥{Math.round(o.lossClaims!.reduce((s, c) => s + Number(c.totalLossAmount || 0), 0)).toLocaleString()}</Chip>
                )}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(o.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-h2">{o.store.name} <span className="text-micro text-gray3 font-num">#{o.no}</span></span>
                <span className="font-num text-h2">¥{displayAmount.toLocaleString()}</span>
              </div>
              <p className="text-caption text-gray2 mt-0.5">
                {displayLabel} · {o.items.length} 项 · 期望 {dayjs(o.expectedDate).format('MM/DD')}
              </p>
              {!isToShip && (
                <div className="mt-3">
                  <ProgressDots
                    steps={[
                      { label: '已接' }, { label: '备货' }, { label: '在途' },
                      { label: '验收' }, { label: '完成' },
                    ]}
                    currentIndex={stepIdx}
                  />
                </div>
              )}
              {/* SUBMITTED 状态: 整卡已可点跳详情, 这里只放紧急快捷按钮 (接/拒) */}
              {o.status === 'SUBMITTED' && (
                <div className="grid grid-cols-2 gap-2 mt-3" onClick={e => e.stopPropagation()}>
                  <a href={`${orderBase}/${o.id}`} className="py-2 bg-white border border-red text-caption text-red-fg rounded-cta text-center">拒单</a>
                  <a href={`${orderBase}/${o.id}`} className="py-2 bg-ink text-white rounded-cta text-caption text-center">接单</a>
                </div>
              )}
              {o.status === 'CONFIRMED' && (
                <div className="mt-3" onClick={e => e.stopPropagation()}>
                  <a href={`${orderBase}/${o.id}`}
                    className="block w-full py-2 bg-ink text-white rounded-cta text-button text-center">
                    核对实发数量并发货
                  </a>
                </div>
              )}
              {(o.deliveries?.length ?? 0) > 0 && (
                <div className="mt-3" onClick={event => event.stopPropagation()}>
                  <a href={`${orderBase}/${o.id}/delivery-note`} className="inline-flex rounded-cta border border-ink px-3 py-1.5 text-button text-ink">打印送货单</a>
                </div>
              )}
            </li>
          )
        })}
        {hasMoreOrders && (
          <li>
            <button
              type="button"
              onClick={() => void loadMoreOrders()}
              disabled={loadingOrders}
              className="w-full py-3 bg-white rounded-card border border-border text-caption text-amber-fg disabled:opacity-50"
            >
              {loadingOrders ? '加载中…' : `加载更多订单 · 已显示 ${orders?.length || 0}/${ordersTotal}`}
            </button>
          </li>
        )}
      </ul>
      )}

      {documentView === 'deliveries' && (
        <ul className="px-4 mt-3 space-y-2">
          {deliveries?.length === 0 && !loadingDeliveries && (
            <li className="text-caption text-gray3 text-center py-12">暂无符合条件的配送单</li>
          )}
          {(deliveries || []).map(delivery => {
            const tone = delivery.status === 'RECEIVED' ? 'green' : delivery.status === 'CANCELLED' ? 'gray' : 'orange'
            return (
              <li key={delivery.id}
                onClick={() => { location.href = `${orderBase}/${delivery.purchaseOrder.id}` }}
                className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-amber cursor-pointer hover:bg-bg-warm transition-colors">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={tone}>{supplierDeliveryStatusMeta(delivery.status).label}</Chip>
                  <span className="font-num text-micro text-gray3">#{delivery.no}</span>
                  <span className="text-micro text-gray3 ml-auto">{dayjs(delivery.shippedAt || delivery.createdAt).format('YYYY/MM/DD HH:mm')}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-h2">{delivery.store.name}</span>
                  <span className="font-num text-h2">¥{Number(delivery.actualTotalAmount).toLocaleString()}</span>
                </div>
                <p className="text-caption text-gray2 mt-0.5">源订货单 #{delivery.purchaseOrder.no}</p>
                <p className="text-caption text-gray2 mt-1 line-clamp-2">
                  {delivery.items.map(item => `${item.product.name} ${item.shippedQty}${item.product.unit}`).join('、')}
                </p>
                {delivery.receipt && <p className="text-micro text-green-fg mt-2">已生成入库单 #{delivery.receipt.no}</p>}
                <div className="mt-3" onClick={event => event.stopPropagation()}>
                  <a href={`${orderBase}/${delivery.purchaseOrder.id}/delivery-note`} className="inline-flex rounded-cta border border-ink px-3 py-1.5 text-button text-ink">打印送货单</a>
                </div>
              </li>
            )
          })}
          {hasMoreDeliveries && (
            <li>
              <button type="button" onClick={() => void loadMoreDeliveries()} disabled={loadingDeliveries}
                className="w-full py-3 bg-white rounded-card border border-border text-caption text-amber-fg disabled:opacity-50">
                {loadingDeliveries ? '加载中…' : `加载更多配送单 · 已显示 ${deliveries?.length || 0}/${deliveriesTotal}`}
              </button>
            </li>
          )}
        </ul>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'orders', label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')      location.href = workspaceHome
          if (k === 'inventory') location.href = inventoryHome
          if (k === 'billing')   location.href = billingHome
          if (k === 'me')        location.href = '/v2/supplier/history'
        }}
      />
    </div>
  )
}

function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
