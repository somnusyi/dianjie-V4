/**
 * 供应商 App · 已完成历史
 * 接 /api/orders?status=RECEIVED + 同时拉所有状态做计数
 *
 * 报损统计来自每单 lossClaims[].totalLossAmount
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

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
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '待接单', CONFIRMED: '已接单', SHIPPED: '已发货',
  PENDING_CONFIRM: '已送达', RECEIVED: '已结清 ✓', CANCELED: '已取消',
}

export default function SupplierHistoryPage() {
  const [tab, setTab] = useState('me')
  const [filter, setFilter] = useState<'all' | 'with-loss'>('all')
  const [orders, setOrders] = useState<OrderRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<any>('/api/orders?pageSize=100')
      .then(d => setOrders((d.items as OrderRow[]) || []))
      .catch(e => setError(String(e?.message || e)))
  }, [])

  const completed = (orders || []).filter(o => ['RECEIVED', 'PENDING_CONFIRM'].includes(o.status))
  const withLoss = completed.filter(o => (o.lossClaims?.length || 0) > 0)
  const shown = filter === 'with-loss' ? withLoss : completed

  const totalLossAmount = withLoss.reduce(
    (s, o) => s + (o.lossClaims || []).reduce((ss, l) => ss + Number(l.totalLossAmount || 0), 0),
    0,
  )
  const lossRate = completed.length > 0 ? (withLoss.length / completed.length) * 100 : 0

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">订单</h1>
          <p className="text-caption text-gray3">
            {orders ? `累计 ${completed.length} 单已完成 · ${withLoss.length} 单含报损` : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌕</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌥</button>
        </div>
      </header>

      <div className="px-4 mt-2 flex gap-2 overflow-x-auto">
        {([
          { key: 'all',       label: `全部 ${completed.length}` },
          { key: 'with-loss', label: `含报损 ${withLoss.length}` },
        ] as const).map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`shrink-0 px-3 py-1.5 rounded-chip text-micro ${filter === f.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}
          >{f.label}</button>
        ))}
      </div>

      {/* 报损洞察 banner */}
      {orders && completed.length > 0 && (
        <div className="px-4 mt-3">
          <div className={`rounded-card p-3 text-caption ${withLoss.length === 0 ? 'bg-green-bg text-green-fg' : 'bg-amber/10 text-amber-fg'}`}>
            报损概况 · <span className="font-num">{withLoss.length} 单</span>
            {totalLossAmount > 0 && <> · <span className="font-num text-red-fg">¥{Math.round(totalLossAmount).toLocaleString()} 损失</span></>}
            · 报损率 <span className="font-num">{lossRate.toFixed(1)}%</span>
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
            title={filter === 'with-loss' ? '没有含报损的订单' : '还没有已完成订单'}
            hint={filter === 'with-loss' ? '保持就好 ✓' : '订单完成入库后会出现在这里'}
          />
        </div>
      ) : (
        <ul className="px-4 mt-3 space-y-2">
          {shown.map(o => {
            const loss = (o.lossClaims || []).reduce((s, l) => s + Number(l.totalLossAmount || 0), 0)
            const date = new Date(o.receivedAt || o.createdAt)
            const dateLabel = `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, '0')}`
            return (
              <li key={o.id} className={`bg-white rounded-card border ${loss > 0 ? 'border-red/30' : 'border-border'} p-3`}>
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  {loss > 0 && <Chip tone="red">含报损</Chip>}
                  <span className="text-micro text-gray3">{dateLabel} · {STATUS_LABEL[o.status] || o.status}</span>
                  <span className="ml-auto font-num text-h2">
                    ¥{Math.round(Number(o.totalAmount || 0)).toLocaleString()}
                    {loss > 0 && <span className="text-micro text-red-fg ml-1">−¥{Math.round(loss).toLocaleString()}</span>}
                  </span>
                </div>
                <div className="text-h2">{o.store?.name || '门店'} <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span></div>
                <p className="text-caption text-gray2 mt-0.5">
                  {(o.items?.length ?? 0)} 项商品
                  {loss > 0 && ` · ${o.lossClaims?.length} 笔报损`}
                </p>
              </li>
            )
          })}
        </ul>
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
