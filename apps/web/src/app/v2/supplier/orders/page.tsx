/**
 * 供应商 App · 订单 Tab  PDF: supplier_order_list_and_detail
 * 接真实 GET /api/orders (后端按 supplierId 自动过滤)
 * 「发货」按钮 → PATCH /api/orders/:id/ship
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip, ProgressDots } from '@/components/v2'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Order = {
  id: string; no: string; status: string
  totalAmount: string
  expectedDate: string; createdAt: string
  shippedAt: string | null
  store: { id: string; name: string }
  items: { id: string; quantity: string; unitPrice: string; product?: { name: string; unit: string } }[]
  lossClaims?: { id: string; status: string; totalLossAmount: string }[]
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

const STATUS_TO_STEP: Record<string, number> = {
  SUBMITTED: 0, CONFIRMED: 1, DELIVERING: 2,
  PENDING_CONFIRM: 3, RECEIVED: 4, COMPLETED: 4,
}
const STATUS_TONE: Record<string, 'red' | 'orange' | 'gray' | 'green'> = {
  SUBMITTED: 'red', CONFIRMED: 'orange', DELIVERING: 'orange',
  PENDING_CONFIRM: 'orange', RECEIVED: 'green', COMPLETED: 'green',
}

type LossClaim = {
  id: string; no: string; status: string
  totalLossAmount: string; description: string; createdAt: string
  store: { name: string }
  purchaseOrder: { id: string; no: string; totalAmount?: string }
  purchaseOrderId?: string
  items: { product: { name: string; unit: string; spec?: string | null }; orderedQty: string; receivedQty: string; lossQty: string; lossAmount: string }[]
}

export default function SupplierOrdersPage() {
  const [tab, setTab] = useState('orders')
  const [documentView, setDocumentView] = useState<'orders' | 'deliveries'>('orders')
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null)
  const [claims, setClaims] = useState<LossClaim[] | null>(null)
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [deliveriesTotal, setDeliveriesTotal] = useState(0)
  const [claimsTotal, setClaimsTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [loadingOrders, setLoadingOrders] = useState(false)
  const [loadingDeliveries, setLoadingDeliveries] = useState(false)
  const [loadingClaims, setLoadingClaims] = useState(false)
  const [searchDraft, setSearchDraft] = useState<SearchCriteria>(EMPTY_SEARCH)
  const [appliedSearch, setAppliedSearch] = useState<SearchCriteria>(EMPTY_SEARCH)
  // 2026-06-02: 支持 URL ?filter=报损 等 (从 billing 页报损 banner 跳过来直接进对应 filter)
  const [filter, setFilter] = useState<'待接单' | '待发货' | '运送中' | '报损' | '已完成'>(() => {
    if (typeof window === 'undefined') return '待接单'
    const sp = new URLSearchParams(window.location.search)
    const f = sp.get('filter') as any
    return ['待接单', '待发货', '运送中', '报损', '已完成'].includes(f) ? f : '待接单'
  })
  const [confirmState, openConfirm] = useConfirmSheet()

  function buildListQuery(page: number, pageSize: number, criteria = appliedSearch) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (criteria.keyword.trim()) params.set('keyword', criteria.keyword.trim())
    if (criteria.dateFrom) params.set('dateFrom', criteria.dateFrom)
    if (criteria.dateTo) params.set('dateTo', criteria.dateTo)
    return params.toString()
  }

  async function load(criteria = appliedSearch) {
    try {
      const [o, c] = await Promise.all([
        apiFetch<{ items: Order[]; total: number }>(`/api/orders?${buildListQuery(1, 50, criteria)}`),
        apiFetch<{ items: LossClaim[]; total: number }>('/api/loss-claims?page=1&pageSize=20')
          .catch(() => ({ items: [] as LossClaim[], total: 0 })),
      ])
      setOrders((o as any).items || (o as any) || [])
      setClaims((c as any).items || (c as any) || [])
      setOrdersTotal(Number((o as any).total ?? (o as any).items?.length ?? 0))
      setClaimsTotal(Number((c as any).total ?? (c as any).items?.length ?? 0))
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

  useEffect(() => { void load(); void loadDeliveries() }, [])

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
      const d = await apiFetch<{ items: Order[]; total: number }>(`/api/orders?${buildListQuery(page, 50)}`)
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

  async function loadMoreClaims() {
    if (!claims || loadingClaims) return
    setLoadingClaims(true)
    try {
      const page = Math.floor(claims.length / 20) + 1
      const d = await apiFetch<{ items: LossClaim[]; total: number }>(`/api/loss-claims?page=${page}&pageSize=20`)
      setClaims(current => [...(current || []), ...(d.items || [])])
      setClaimsTotal(Number(d.total ?? claimsTotal))
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoadingClaims(false)
    }
  }

  function ship(o: Order) {
    if (submitting) return
    openConfirm({
      title: `确认 ${o.store.name} 已发货？`,
      body: `订单 #${o.no} · 金额 ¥${Number(o.totalAmount).toLocaleString()}\n发货后 24h 内餐厅未确认将自动收货。`,
      confirmLabel: '确认发货',
      tone: 'primary',
      onConfirm: async () => {
        setSubmitting(o.id)
        try {
          await apiFetch(`/api/orders/${o.id}/ship`, {
            method: 'PATCH',
            body: JSON.stringify({ note: '已按时发出' }),
          })
          await Promise.all([load(), loadDeliveries()])
        } catch (e: any) {
          alert(e.message || '发货失败')
          throw e
        } finally {
          setSubmitting(null)
        }
      },
    })
  }

  function handleClaim(c: LossClaim, action: 'approve' | 'reject') {
    if (submitting) return
    if (action === 'reject') {
      openConfirm({
        title: `拒绝报损 ${c.no}`,
        body: '请简述拒绝原因，将通知餐厅。',
        confirmLabel: '拒绝',
        tone: 'danger',
        withInput: true,
        inputRequired: true,
        inputPlaceholder: '例如：包装完好，疑非物流问题…',
        onConfirm: async (note) => {
          setSubmitting(c.id)
          try {
            await apiFetch(`/api/loss-claims/${c.id}/handle`, {
              method: 'PATCH',
              body: JSON.stringify({ action: 'reject', note }),
            })
            await load()
          } catch (e: any) {
            alert(e.message || '操作失败')
            throw e
          } finally {
            setSubmitting(null)
          }
        },
      })
    } else {
      openConfirm({
        title: `同意扣款 ¥${Number(c.totalLossAmount).toFixed(2)}`,
        body: '此金额将从下次账期中扣减。',
        confirmLabel: '同意扣款',
        tone: 'primary',
        onConfirm: async () => {
          setSubmitting(c.id)
          try {
            await apiFetch(`/api/loss-claims/${c.id}/handle`, {
              method: 'PATCH',
              body: JSON.stringify({ action: 'approve', note: '已确认报损属实' }),
            })
            await load()
          } catch (e: any) {
            alert(e.message || '操作失败')
            throw e
          } finally {
            setSubmitting(null)
          }
        },
      })
    }
  }

  const pendingClaims = (claims || []).filter(c => c.status === 'PENDING')

  function statusInTab(s: string, f: string) {
    if (f === '待接单') return s === 'SUBMITTED'
    if (f === '待发货') return s === 'CONFIRMED'
    if (f === '运送中') return s === 'PENDING_CONFIRM' || s === 'DELIVERING'   // DELIVERING 兼容老数据
    if (f === '已完成') return ['RECEIVED', 'COMPLETED', 'CANCELLED'].includes(s)
    return false
  }
  const visible = (orders || []).filter(o => statusInTab(o.status, filter))
  const hasMoreOrders = orders !== null && orders.length < ordersTotal
  const hasMoreDeliveries = deliveries !== null && deliveries.length < deliveriesTotal
  const hasMoreClaims = claims !== null && claims.length < claimsTotal

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

      {/* 报损待处理 banner（仅 PENDING 数量 > 0 时显示，强制提醒）*/}
      {documentView === 'orders' && pendingClaims.length > 0 && filter !== '报损' && (
        <button
          onClick={() => setFilter('报损')}
          className="mx-4 mt-2 w-[calc(100%-32px)] bg-red-bg border border-red/30 rounded-card p-3 flex items-center gap-3 text-left"
        >
          <span className="w-9 h-9 rounded-md bg-red text-white flex items-center justify-center text-h2">⚠</span>
          <div className="flex-1">
            <div className="text-h2 text-red-fg">{pendingClaims.length} 笔报损待处理</div>
            <p className="text-micro text-red-fg">总损失 ¥{pendingClaims.reduce((s, c) => s + Number(c.totalLossAmount || 0), 0).toFixed(2)} · 24h 未响应自动同意</p>
          </div>
          <span className="text-red-fg">›</span>
        </button>
      )}

      {documentView === 'orders' && <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {(['待接单', '待发货', '运送中', '报损', '已完成'] as const).map((f) => {
          const cnt = f === '报损'
            ? pendingClaims.length
            : (orders || []).filter(o => statusInTab(o.status, f)).length
          const isUrgent = (f === '待接单' || f === '报损') && cnt > 0
          return (
            <button key={f} onClick={() => setFilter(f)}
              className={`shrink-0 px-3 py-1.5 rounded-cta text-button relative ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              <span>{f}</span>
              {cnt > 0 && <span className={`font-num ml-1 ${filter === f ? '' : isUrgent ? 'text-red-fg' : 'text-gray3'}`}>{cnt}</span>}
              {isUrgent && filter !== f && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red rounded-full" />}
            </button>
          )
        })}
      </div>}

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}

      {/* 报损 tab 内容 — 显示全部历史报损,PENDING 在最上 */}
      {documentView === 'orders' && filter === '报损' && (() => {
        const claimStatusMeta: Record<string, { label: string; tone: 'red' | 'gray' | 'orange' | 'blue' | 'green'; barClass: string }> = {
          PENDING:     { label: '待处理',     tone: 'red',    barClass: 'before:bg-red' },
          APPROVED:    { label: '已同意',     tone: 'gray',   barClass: 'before:bg-gray4' },
          REJECTED:    { label: '已拒绝·待总厨', tone: 'orange', barClass: 'before:bg-orange' },
          NEGOTIATING: { label: '协商中',     tone: 'orange', barClass: 'before:bg-orange' },
          RESOLVED:    { label: '总厨已仲裁', tone: 'blue',   barClass: 'before:bg-gray4' },
        }
        const sorted = [...(claims || [])].sort((a, b) => {
          if (a.status === 'PENDING' && b.status !== 'PENDING') return -1
          if (a.status !== 'PENDING' && b.status === 'PENDING') return 1
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })
        return (
          <ul className="px-4 mt-3 space-y-2">
            {sorted.length === 0 && (
              <li className="text-caption text-gray3 text-center py-12">暂无报损记录</li>
            )}
            {sorted.map(c => {
              const meta = claimStatusMeta[c.status] || { label: c.status, tone: 'gray' as const, barClass: 'before:bg-gray4' }
              const isPending = c.status === 'PENDING'
              return (
                <li key={c.id} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${meta.barClass}`}>
                  <a href={`/v2/supplier/orders/${c.purchaseOrder.id || c.purchaseOrderId}`} className="block">
                    <div className="flex items-center gap-2 mb-1">
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                      <span className="text-micro text-gray3 ml-auto">{timeAgo(c.createdAt)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-h2">{c.store.name} <span className="text-micro text-gray3 font-num">#{c.purchaseOrder.no}</span></span>
                      <span className={`font-num text-h2 ${isPending ? 'text-red-fg' : 'text-gray2'}`}>−¥{Number(c.totalLossAmount).toFixed(2)}</span>
                    </div>
                    <p className="text-caption text-gray2 mt-0.5">{c.description}</p>
                    <ul className="mt-2 text-micro text-gray2 space-y-0.5">
                      {(c.items || []).map((it, idx) => (
                        <li key={idx}>· {it.product?.name}{it.product?.spec ? ` (${it.product.spec})` : ''}: 下 {it.orderedQty} 收 {it.receivedQty}{it.product?.unit || ''} · 损 ¥{Number(it.lossAmount).toFixed(2)}</li>
                      ))}
                    </ul>
                    {(c as any).handlerNote && (
                      <p className="text-micro text-gray3 mt-1.5">处理备注:{(c as any).handlerNote}</p>
                    )}
                    <p className="text-micro text-amber-fg mt-2">查看证据图 / 完整明细 ›</p>
                  </a>
                  {/* 操作按钮仅 PENDING 时显示 */}
                  {isPending && (
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <button
                        onClick={() => handleClaim(c, 'reject')}
                        disabled={submitting === c.id}
                        className="py-2 border border-red text-red rounded-cta text-button disabled:opacity-40"
                      >拒绝</button>
                      <button
                        onClick={() => handleClaim(c, 'approve')}
                        disabled={submitting === c.id}
                        className="py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40"
                      >{submitting === c.id ? '提交中…' : `同意扣款 · ¥${Number(c.totalLossAmount).toFixed(2)}`}</button>
                    </div>
                  )}
                </li>
              )
            })}
            {hasMoreClaims && (
              <li>
                <button
                  type="button"
                  onClick={() => void loadMoreClaims()}
                  disabled={loadingClaims}
                  className="w-full py-3 bg-white rounded-card border border-border text-caption text-amber-fg disabled:opacity-50"
                >
                  {loadingClaims ? '加载中…' : `加载更多报损 · 已显示 ${claims?.length || 0}/${claimsTotal}`}
                </button>
              </li>
            )}
          </ul>
        )
      })()}

      {/* 普通订单 tabs 内容 */}
      {documentView === 'orders' && filter !== '报损' && (
      <ul className="px-4 mt-3 space-y-2">
        {visible.length === 0 && orders !== null && (
          <li className="text-caption text-gray3 text-center py-12">暂无{filter}订单</li>
        )}
        {visible.map(o => {
          const tone = STATUS_TONE[o.status] || 'gray'
          const stepIdx = STATUS_TO_STEP[o.status] ?? 0
          const isToShip = o.status === 'SUBMITTED' || o.status === 'CONFIRMED'
          return (
            <li key={o.id}
                onClick={() => location.href = `/v2/supplier/orders/${o.id}`}
                className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${tone === 'red' ? 'before:bg-red' : tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'} cursor-pointer hover:bg-bg-warm transition-colors`}>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Chip tone={tone}>{statusLabel(o.status)}</Chip>
                {isToShip && <Chip tone="red">需即办</Chip>}
                {/* 已完成 tab 内的报损标识 */}
                {(o.status === 'RECEIVED' || o.status === 'COMPLETED') && (o.lossClaims?.length ?? 0) > 0 && (
                  <Chip tone="orange">含报损 ¥{Math.round(o.lossClaims!.reduce((s, c) => s + Number(c.totalLossAmount || 0), 0)).toLocaleString()}</Chip>
                )}
                <span className="text-micro text-gray3 ml-auto">{timeAgo(o.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-h2">{o.store.name} <span className="text-micro text-gray3 font-num">#{o.no}</span></span>
                <span className="font-num text-h2">¥{Number(o.totalAmount).toLocaleString()}</span>
              </div>
              <p className="text-caption text-gray2 mt-0.5">
                {o.items.length} 项 · 期望 {dayjs(o.expectedDate).format('MM/DD')}
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
                  <a href={`/v2/supplier/orders/${o.id}`} className="py-2 bg-white border border-red text-caption text-red-fg rounded-cta text-center">拒单</a>
                  <a href={`/v2/supplier/orders/${o.id}`} className="py-2 bg-ink text-white rounded-cta text-caption text-center">接单</a>
                </div>
              )}
              {o.status === 'CONFIRMED' && (
                <div className="mt-3" onClick={e => e.stopPropagation()}>
                  <button onClick={() => ship(o)} disabled={submitting === o.id}
                    className="w-full py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">
                    {submitting === o.id ? '提交中…' : '确认发货'}
                  </button>
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
                onClick={() => { location.href = `/v2/supplier/orders/${delivery.purchaseOrder.id}` }}
                className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-amber cursor-pointer hover:bg-bg-warm transition-colors">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Chip tone={tone}>{deliveryStatusLabel(delivery.status)}</Chip>
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
          if (k === 'home')      location.href = '/v2/supplier/home'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'billing')   location.href = '/v2/supplier/billing'
          if (k === 'me')        location.href = '/v2/supplier/history'
        }}
      />

      <ConfirmSheet {...confirmState} />
    </div>
  )
}

function statusLabel(s: string) {
  return ({
    SUBMITTED: '待接单', CONFIRMED: '已接单',
    DELIVERING: '配送中', PENDING_CONFIRM: '已送达',
    RECEIVED: '已收货', COMPLETED: '已完成', CANCELLED: '已取消',
  } as Record<string, string>)[s] || s
}
function deliveryStatusLabel(s: string) {
  return ({
    DRAFT: '草稿', SHIPPED: '已发货', DELIVERED: '已送达',
    RECEIVED: '已收货', CANCELLED: '已取消',
  } as Record<string, string>)[s] || s
}
function timeAgo(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
