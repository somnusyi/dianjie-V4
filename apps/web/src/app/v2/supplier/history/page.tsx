/**
 * 供应商 App · 已完成历史
 * 接 /api/orders?status=RECEIVED + 同时拉所有状态做计数
 *
 * 到货差异统计来自每单 lossClaims[].totalLossAmount；应付金额来自确认入库单。
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import { SUPPLIER_MONEY_TERMS, supplierOrderStatusMeta } from '@/lib/supplier-domain'

type OrderRow = {
  id: string
  no: string
  status: string
  totalAmount: number | string
  createdAt: string
  receivedAt?: string | null
  store: { id: string; name: string }
  items?: any[]
  lossClaims?: { id: string; status: string; totalLossAmount: number | string }[]
  receipts?: { id: string; status: string; totalAmount: number | string }[]
  deliveries?: { id: string; status: string; actualTotalAmount: number | string }[]
}

export default function SupplierHistoryPage() {
  const [tab, setTab] = useState('me')
  // 2026-06-02: 支持 URL ?filter=with-loss (从 billing 页报损 banner 跳过来直接显示报损单)
  const [filter, setFilter] = useState<'all' | 'with-loss'>(() => {
    if (typeof window === 'undefined') return 'all'
    const sp = new URLSearchParams(window.location.search)
    return sp.get('filter') === 'with-loss' ? 'with-loss' : 'all'
  })
  const [orders, setOrders] = useState<OrderRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadPage(page = 1) {
    if (page > 1) setLoadingMore(true)
    try {
      const d = await apiFetch<{ items: OrderRow[]; total: number }>(`/api/orders?page=${page}&pageSize=50`)
      const next = d.items || []
      setOrders(current => page === 1 ? next : [...(current || []), ...next])
      setTotal(Number(d.total ?? next.length))
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => { void loadPage() }, [])

  const completed = (orders || []).filter(o => ['RECEIVED', 'COMPLETED'].includes(o.status))
  const withLoss = completed.filter(o => (o.lossClaims?.length || 0) > 0)
  const shown = filter === 'with-loss' ? withLoss : completed
  const hasMore = orders !== null && orders.length < total

  const totalDifferenceAmount = withLoss.reduce(
    (s, o) => s + (o.lossClaims || []).reduce((ss, l) => ss + Number(l.totalLossAmount || 0), 0),
    0,
  )
  const differenceRate = completed.length > 0 ? (withLoss.length / completed.length) * 100 : 0

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">订单</h1>
          <p className="text-caption text-gray3">
            {orders ? `累计 ${completed.length} 单已完成 · ${withLoss.length} 单有到货差异` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌕</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌥</button>
        </div>
      </header>

      {/* 账户 — 修改密码入口 (2026-06 客户要求, 供应商"我的"页落在本页) */}
      <div className="px-4 mt-3">
        <a href="/v2/me/password"
           className="bg-white rounded-card border border-border flex items-center px-3 py-3">
          <span className="w-8 h-8 rounded-md bg-bg flex items-center justify-center mr-3">密</span>
          <span className="flex-1 text-body">修改密码</span>
          <span className="text-gray3">›</span>
        </a>
      </div>

      <div className="px-4 mt-3 flex gap-2 overflow-x-auto">
        {([
          { key: 'all',       label: `全部 ${completed.length}` },
          { key: 'with-loss', label: `有到货差异 ${withLoss.length}` },
        ] as const).map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`shrink-0 px-3 py-1.5 rounded-chip text-micro ${filter === f.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}
          >{f.label}</button>
        ))}
      </div>

      {/* 到货差异概况 */}
      {orders && completed.length > 0 && (
        <div className="px-4 mt-3">
          <div className={`rounded-card p-3 text-caption ${withLoss.length === 0 ? 'bg-green-bg text-green-fg' : 'bg-amber/10 text-amber-fg'}`}>
            到货差异 · <span className="font-num">{withLoss.length} 单</span>
            {totalDifferenceAmount > 0 && <> · <span className="font-num text-red-fg">涉及 ¥{Math.round(totalDifferenceAmount).toLocaleString()}</span></>}
            · 差异单率 <span className="font-num">{differenceRate.toFixed(1)}%</span>
          </div>
        </div>
      )}

      {error ? (
        <div className="px-4 mt-3"><FriendlyError message={error} /></div>
      ) : !orders ? (
        <div className="px-4 mt-3 space-y-2">{[1,2,3].map(i => <SkeletonCard key={i} />)}</div>
      ) : shown.length === 0 ? (
        <div className="px-4 mt-4">
          <EmptyState
            icon="📦"
            title={filter === 'with-loss' ? '没有到货差异订单' : '还没有已完成订单'}
            hint={filter === 'with-loss' ? '保持就好 ✓' : '订单完成入库后会出现在这里'}
          />
          {hasMore && (
            <button
              type="button"
              onClick={() => void loadPage(Math.floor((orders?.length || 0) / 50) + 1)}
              disabled={loadingMore}
              className="w-full py-3 mt-3 bg-white rounded-card border border-border text-caption text-amber-fg disabled:opacity-50"
            >
              {loadingMore ? '加载中…' : `加载更多历史 · 已显示 ${orders?.length || 0}/${total}`}
            </button>
          )}
        </div>
      ) : (
        <div className="px-4 mt-3">
          <ul className="space-y-2">
            {shown.map(o => {
            const difference = (o.lossClaims || []).reduce((s, l) => s + Number(l.totalLossAmount || 0), 0)
            const payable = (o.receipts || []).reduce((s, receipt) => s + Number(receipt.totalAmount || 0), 0)
            const shipped = (o.deliveries || []).reduce((s, delivery) => s + Number(delivery.actualTotalAmount || 0), 0)
            const displayAmount = payable > 0 ? payable : shipped > 0 ? shipped : Number(o.totalAmount || 0)
            const amountLabel = payable > 0
              ? SUPPLIER_MONEY_TERMS.payableAmount
              : shipped > 0 ? SUPPLIER_MONEY_TERMS.shipmentAmount : SUPPLIER_MONEY_TERMS.orderedAmount
            const date = new Date(o.receivedAt || o.createdAt)
            const dateLabel = `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, '0')}`
            return (
              <li key={o.id} className={`bg-white rounded-card border ${difference > 0 ? 'border-red/30' : 'border-border'} p-3`}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  {difference > 0 && <Chip tone="red">有到货差异</Chip>}
                  <span className="text-micro text-gray3">{dateLabel} · {supplierOrderStatusMeta(o.status).label}</span>
                  <span className="ml-auto font-num text-h2">
                    ¥{Math.round(displayAmount).toLocaleString()}
                  </span>
                </div>
                <div className="text-h2">{o.store?.name || '门店'} <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span></div>
                <p className="text-caption text-gray2 mt-0.5">
                  {amountLabel} · {(o.items?.length ?? 0)} 项商品
                  {difference > 0 && ` · ${o.lossClaims?.length} 笔差异涉及 ¥${Math.round(difference).toLocaleString()}`}
                </p>
              </li>
            )
            })}
          </ul>
          {hasMore && (
            <button
              type="button"
              onClick={() => void loadPage(Math.floor((orders?.length || 0) / 50) + 1)}
              disabled={loadingMore}
              className="w-full py-3 mt-3 bg-white rounded-card border border-border text-caption text-amber-fg disabled:opacity-50"
            >
              {loadingMore ? '加载中…' : `加载更多历史 · 已显示 ${orders?.length || 0}/${total}`}
            </button>
          )}
        </div>
      )}

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')    location.href = '/v2/supplier/home'
          if (k === 'orders')  location.href = '/v2/supplier/orders'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'billing') location.href = '/v2/supplier/billing'
        }}
      />
    </div>
  )
}
