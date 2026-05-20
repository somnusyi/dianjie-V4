/**
 * 总厨 · 门店订货 (跨店查看所有订单 + 物流签收状态)
 *
 * 客户反馈: 总厨要看到门店订货明细和物流签收状态.
 *
 * 数据: GET /api/orders 后端在 CHEF_DIRECTOR 角色下不收 store/supplier scope
 * 设计:
 *   - 默认显示全店全供应商所有进行中订单
 *   - 顶部门店 / 供应商 / 状态三个过滤器
 *   - 别人下的单 → 只读
 *   - 自己下的单 (createdById === me.id) + 状态 SUBMITTED → 可撤单 (详情页才显示按钮)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { Chip, ProgressDots } from '@/components/v2'
import { apiFetch, getUser } from '@/lib/v2-auth'
import dayjs from 'dayjs'

type Store    = { id: string; name: string; no?: string | null }
type Supplier = { id: string; name: string }
type Order    = {
  id: string; no: string; status: string
  storeId: string; supplierId: string
  expectedDate: string; createdAt: string
  totalAmount: string | number
  note?: string | null
  shippedAt?: string | null
  deliveredAt?: string | null
  receivedAt?: string | null
  store?: Store
  supplier?: Supplier
  createdBy?: { id: string; name: string; role: string }
  items?: Array<{ id: string; productId: string; quantity: string | number; unitPrice: string | number }>
}

const STATUS_TO_STEP: Record<string, number> = {
  DRAFT: 0, SUBMITTED: 1, CONFIRMED: 2, DELIVERING: 3,
  PENDING_CONFIRM: 4, RECEIVED: 5, COMPLETED: 5, CANCELLED: -1,
}
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', SUBMITTED: '待接单', CONFIRMED: '已接单',
  DELIVERING: '配送中', PENDING_CONFIRM: '待签收',
  RECEIVED: '已签收', COMPLETED: '已完成', CANCELLED: '已取消',
}
// 状态 chip 配色, 跟 supplier/orders/page.tsx 风格对齐
function toneFor(s: string): 'gray' | 'amber' | 'green' | 'red' {
  if (s === 'CANCELLED') return 'gray'
  if (s === 'PENDING_CONFIRM') return 'red'
  if (s === 'DELIVERING' || s === 'CONFIRMED') return 'amber'
  if (s === 'COMPLETED' || s === 'RECEIVED') return 'green'
  return 'gray'
}

// 状态筛选 chips
const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'ALL',             label: '全部' },
  { key: 'SUBMITTED',       label: '待接单' },
  { key: 'CONFIRMED',       label: '已接单' },
  { key: 'DELIVERING',      label: '配送中' },
  { key: 'PENDING_CONFIRM', label: '待签收' },
  { key: 'RECEIVED',        label: '已签收' },
  { key: 'COMPLETED',       label: '已完成' },
  { key: 'CANCELLED',       label: '已取消' },
]

export default function ChefDirectorOrdersPage() {
  const me = typeof window !== 'undefined' ? getUser() : null
  const [orders, setOrders]       = useState<Order[] | null>(null)
  const [stores, setStores]       = useState<Store[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [error, setError]         = useState<string | null>(null)
  const [storeId, setStoreId]     = useState<string>('')
  const [supplierId, setSupplierId] = useState<string>('')
  const [statusFilter, setStatus] = useState<string>('ALL')

  useEffect(() => {
    apiFetch<{ items: Order[] }>('/api/orders?pageSize=200')
      .then(d => setOrders((d as any).items || (d as any) || []))
      .catch(e => setError(String(e?.message || e)))
    apiFetch<any>('/api/stores').then(d => {
      setStores(Array.isArray(d) ? d : (d?.items || []))
    }).catch(() => {})
    apiFetch<Supplier[]>('/api/suppliers')
      .then(d => setSuppliers(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  const filtered = useMemo(() => {
    if (!orders) return null
    return orders.filter(o => {
      if (storeId && o.storeId !== storeId) return false
      if (supplierId && o.supplierId !== supplierId) return false
      if (statusFilter !== 'ALL' && o.status !== statusFilter) return false
      return true
    })
  }, [orders, storeId, supplierId, statusFilter])

  const stats = useMemo(() => {
    const list = filtered || []
    const pending  = list.filter(o => o.status === 'PENDING_CONFIRM').length
    const inflight = list.filter(o => ['SUBMITTED', 'CONFIRMED', 'DELIVERING'].includes(o.status)).length
    const total    = list.reduce((s, o) => s + Number(o.totalAmount || 0), 0)
    return { count: list.length, pending, inflight, total }
  }, [filtered])

  if (error) return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="bg-red-bg text-red-fg rounded-card p-4">{error}</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-bg pb-10">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => history.back()} className="text-gray2 text-h2">‹</button>
        <h1 className="text-h1">门店订货</h1>
      </header>

      {/* 概览条 */}
      <div className="mx-4 mt-2 bg-bg-warm rounded-card border border-border p-3 flex items-center gap-3 text-caption">
        <div className="flex-1">
          <span className="text-gray3">符合筛选 </span>
          <span className="font-num text-h2 text-ink">{stats.count}</span>
          <span className="text-gray3"> 单</span>
        </div>
        <div className="text-gray3">在途 <span className="font-num text-ink">{stats.inflight}</span></div>
        {stats.pending > 0 && (
          <Chip tone="red">{stats.pending} 待签收</Chip>
        )}
        <div className="text-gray3">合计 ¥{Math.round(stats.total).toLocaleString()}</div>
      </div>

      {/* 筛选区 */}
      <section className="px-4 mt-3 space-y-2">
        <div className="flex gap-2">
          <select
            value={storeId}
            onChange={e => setStoreId(e.target.value)}
            className="flex-1 bg-white rounded-card border border-border px-3 py-2 text-caption outline-none"
          >
            <option value="">全部门店</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            value={supplierId}
            onChange={e => setSupplierId(e.target.value)}
            className="flex-1 bg-white rounded-card border border-border px-3 py-2 text-caption outline-none"
          >
            <option value="">全部供应商</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        <div className="overflow-x-auto">
          <div className="flex gap-2 whitespace-nowrap pb-1">
            {STATUS_FILTERS.map(s => (
              <button
                key={s.key}
                type="button"
                onClick={() => setStatus(s.key)}
                className={`px-3 py-1 rounded-chip text-caption ${
                  statusFilter === s.key ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'
                }`}
              >{s.label}</button>
            ))}
          </div>
        </div>
      </section>

      {/* 订单列表 */}
      <section className="px-4 mt-3">
        {filtered === null && (
          <p className="text-caption text-gray3 text-center py-8">加载中…</p>
        )}
        {filtered && filtered.length === 0 && (
          <p className="text-caption text-gray3 text-center py-8">无匹配订单 · 调整筛选试试</p>
        )}
        <ul className="space-y-2">
          {(filtered || []).map(o => {
            const stepIdx = STATUS_TO_STEP[o.status] ?? 1
            const tone    = toneFor(o.status)
            const isMine  = !!(me && o.createdBy && o.createdBy.id === me.id)
            return (
              <li key={o.id}>
                <a
                  href={`/v2/chef-director/orders/${o.id}`}
                  className="block bg-white rounded-card border border-border p-3"
                >
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-h2 flex items-center gap-1 min-w-0 flex-wrap">
                      <span className="truncate">{o.supplier?.name || '未知供应商'}</span>
                      {o.createdBy?.role === 'CHEF_DIRECTOR' && (
                        <Chip tone={isMine ? 'amber' : 'gray'}>{isMine ? '我代下' : '总厨代下'}</Chip>
                      )}
                      <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span>
                    </span>
                    <span className="font-num text-h2 shrink-0">¥{Number(o.totalAmount).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2 mb-2 text-micro">
                    <Chip tone={tone}>{STATUS_LABEL[o.status] || o.status}</Chip>
                    <span className="text-gray3 truncate">{o.store?.name || '未知门店'}</span>
                    <span className="text-gray3 ml-auto whitespace-nowrap">
                      {o.items?.length ?? 0} 项 · 期望 {dayjs(o.expectedDate).format('MM/DD')}
                    </span>
                  </div>
                  {stepIdx >= 0 && (
                    <ProgressDots
                      steps={[
                        { label: '已发起' }, { label: '接单' }, { label: '在途' },
                        { label: '送达' }, { label: '签收' },
                      ]}
                      currentIndex={stepIdx}
                    />
                  )}
                </a>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
