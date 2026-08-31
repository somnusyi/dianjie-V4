'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { OrderCenterTabs } from '@/components/v2/order-center-tabs'
import { apiFetch } from '@/lib/v2-auth'
import { clientRequestId } from '@/lib/client-id'
import { buildFulfillmentGroups, type FulfillmentGroup, type OperationGroup } from '@/lib/fulfillment-groups'
import { formatOrderStatusLabel, orderStatusTone } from '@/lib/supply-order-delivery-pc'

type Order = {
  id: string
  no: string
  status: string
  expectedDate?: string | null
  totalAmount?: number | string
  createdAt: string
  store?: { id: string; name: string }
  supplier?: { id: string; name: string }
  operationGroup?: OperationGroup | null
  operationGroupPosition?: number | null
  items?: Array<{
    productNameSnapshot?: string | null
    productCodeSnapshot?: string | null
    product?: { name?: string; code?: string }
  }>
}

type Bucket = 'ALL' | 'SUBMITTED' | 'CONFIRMED' | 'DELIVERING'

const BUCKETS: Array<{ value: Bucket; label: string }> = [
  { value: 'ALL', label: '全部待办' },
  { value: 'SUBMITTED', label: '待接单' },
  { value: 'CONFIRMED', label: '待发货' },
  { value: 'DELIVERING', label: '待送达' },
]

function actionLabel(status: string) {
  if (status === 'SUBMITTED') return '去接单'
  if (status === 'CONFIRMED') return '去发货'
  if (status === 'DELIVERING') return '确认送达'
  return '查看'
}

function itemSummary(order: Order) {
  const names = (order.items || [])
    .map(item => item.productNameSnapshot || item.product?.name)
    .filter(Boolean) as string[]
  if (names.length === 0) return '暂无商品摘要'
  const first = names.slice(0, 3).join('、')
  return names.length > 3 ? `${first} 等 ${names.length} 项` : first
}


type ProductionFulfillmentGroup = Omit<FulfillmentGroup, 'orders'> & { orders: Order[] }

function operationGroupWindow(group: ProductionFulfillmentGroup) {
  const times = group.orders.map(order => Date.parse(order.createdAt)).filter(value => Number.isFinite(value))
  if (times.length === 0) return null
  const format = (value: number) => new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const first = Math.min(...times)
  const last = Math.max(...times)
  return first === last ? format(first) : `${format(first)}—${format(last)}`
}

function InternalOperationGroupCard({
  group,
  submitting,
  onBatchConfirm,
}: {
  group: ProductionFulfillmentGroup
  submitting: string | null
  onBatchConfirm: (group: ProductionFulfillmentGroup) => void
}) {
  const first = group.orders[0]
  const metadata = group.metadata
  if (!first || !metadata) return null
  const memberCount = Math.max(metadata.memberCount || 0, group.orders.length)
  const memberNos = metadata.memberOrderNos || group.orders.map(order => order.no)
  const missingCount = Math.max(0, memberCount - group.orders.length)
  const window = operationGroupWindow(group)
  const isSubmitting = submitting === metadata.id

  return (
    <li
      onClick={() => { location.href = `/v2/supply-chain/fulfillment/${first.id}` }}
      className="rounded-card border border-amber/40 bg-white p-4 cursor-pointer hover:bg-bg-warm transition-colors"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Chip tone="orange">同店两小时集合</Chip>
        <span className="text-caption text-gray2">{memberCount} 张待接单订单</span>
        {window && <span className="ml-auto text-micro text-gray3">下单时间 {window}</span>}
      </div>
      <div className="mt-3 divide-y divide-border/70">
        {memberNos.map((no, index) => {
          const order = group.orders.find(row => row.no === no) || group.orders[index]
          if (!order) {
            return <div key={`${metadata.id}:${no}:${index}`} className="py-2 text-caption text-gray3">订单号：{no} · 下单日期：—</div>
          }
          return (
            <div key={`${metadata.id}:${order.id}`} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={orderStatusTone(order.status)}>{formatOrderStatusLabel(order.status)}</Chip>
                <b className="font-num text-body">#{order.no}</b>
                <span className="text-micro text-gray3 ml-auto">{new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <span className="text-h2">{order.store?.name || '未知门店'}</span>
                <span className="font-num text-h2">¥{Number(order.totalAmount || 0).toLocaleString('zh-CN')}</span>
              </div>
              <p className="mt-1 text-caption text-gray2">{itemSummary(order)}</p>
            </div>
          )
        })}
        {missingCount > 0 && <div className="pt-2 text-micro text-gray3">还有 {missingCount} 张订单将在批量操作时一并处理</div>}
      </div>
      <button
        type="button"
        disabled={isSubmitting || !group.canBatchConfirm}
        onClick={event => {
          event.stopPropagation()
          onBatchConfirm(group)
        }}
        className="mt-4 w-full rounded-cta bg-ink px-4 py-2.5 text-center text-button text-white disabled:opacity-50"
      >
        {isSubmitting ? '批量接单中…' : `批量接单（${memberCount}）`}
      </button>
      <a
        href={`/v2/supply-chain/fulfillment/${encodeURIComponent(metadata.id)}/delivery-note`}
        onClick={event => event.stopPropagation()}
        className="mt-2 block w-full rounded-cta border border-border bg-white px-4 py-2.5 text-center text-button text-gray2 hover:bg-bg-warm"
      >
        🖨 打印集合送货单
      </a>
    </li>
  )
}

export default function InternalSupplyChainFulfillmentPage() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('ALL')
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState<string | null>(null)

  function load() {
    setError('')
    apiFetch<{ items: Order[] }>('/api/orders?page=1&pageSize=100')
      .then(data => setOrders(data.items || []))
      .catch(reason => {
        setOrders([])
        setError(String(reason?.message || reason))
      })
  }

  async function confirmOperationGroup(group: ProductionFulfillmentGroup) {
    const metadata = group.metadata
    if (!metadata || !group.canBatchConfirm || submitting) return
    const orderIds = metadata.memberOrderIds?.length
      ? metadata.memberOrderIds
      : group.orders.map(order => order.id)
    setSubmitting(metadata.id)
    setError('')
    try {
      await apiFetch(`/api/orders/operation-groups/${encodeURIComponent(metadata.id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ orderIds, idempotencyKey: clientRequestId() }),
      })
      load()
    } catch (reason: any) {
      setError(String(reason?.message || reason || '批量接单失败'))
    } finally {
      setSubmitting(null)
    }
  }

  useEffect(() => { load() }, [])

  const actionable = useMemo(
    () => (orders || []).filter(order => ['SUBMITTED', 'CONFIRMED', 'DELIVERING'].includes(order.status)),
    [orders],
  )
  const counts = useMemo(() => ({
    ALL: actionable.length,
    SUBMITTED: actionable.filter(order => order.status === 'SUBMITTED').length,
    CONFIRMED: actionable.filter(order => order.status === 'CONFIRMED').length,
    DELIVERING: actionable.filter(order => order.status === 'DELIVERING').length,
  }), [actionable])
  const visible = useMemo(() => {
    const term = keyword.trim().toLowerCase()
    return actionable.filter(order => {
      if (bucket !== 'ALL' && order.status !== bucket) return false
      if (!term) return true
      return [
        order.no,
        order.store?.name,
        order.supplier?.name,
        ...(order.items || []).flatMap(item => [
          item.productNameSnapshot,
          item.productCodeSnapshot,
          item.product?.name,
          item.product?.code,
        ]),
      ].some(value => String(value || '').toLowerCase().includes(term))
    })
  }, [actionable, bucket, keyword])

  // Only server metadata can change the list. Flatten local fallback groups so
  // older API responses keep the established one-order card workflow.
  const operationGroups = buildFulfillmentGroups<Order>(visible) as ProductionFulfillmentGroup[]
  const displayGroups: Array<{ group: ProductionFulfillmentGroup | null; order: Order | null }> = []
  for (const group of operationGroups) {
    const hasServerGroup = Boolean(group.metadata?.id && (group.metadata.memberCount || group.orders.length) > 1)
    if (hasServerGroup) displayGroups.push({ group, order: null })
    else group.orders.forEach(order => displayGroups.push({ group: null, order }))
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="border-b border-border pb-5">
        <div className="mb-2 flex items-center gap-2">
          <Chip tone="green">内部可操作</Chip>
          <span className="text-caption text-gray3">单据独立 · 一个订单中心完成履约</span>
        </div>
        <h1 className="text-h1">订单中心</h1>
        <p className="mt-1 text-caption text-gray2">先处理需要动作的订单，再按订货单或配送单查询完整历史。</p>
      </header>

      <OrderCenterTabs />

      <section className="grid gap-3 py-4 sm:grid-cols-2 xl:grid-cols-4">
        {BUCKETS.map(item => (
          <button
            key={item.value}
            type="button"
            onClick={() => setBucket(item.value)}
            className={`rounded-card border p-4 text-left ${
              bucket === item.value ? 'border-amber bg-amber/10' : 'border-border bg-white'
            }`}
          >
            <div className="text-caption text-gray3">{item.label}</div>
            <div className="mt-1 font-num text-h1">{counts[item.value]}</div>
          </button>
        ))}
      </section>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={keyword}
          onChange={event => setKeyword(event.target.value)}
          placeholder="订单号 / 门店 / 供应商 / 商品名称或编码"
          className="h-10 min-w-80 flex-1 rounded-cta border border-border bg-white px-3 text-body"
        />
        <button type="button" onClick={load} className="h-10 rounded-cta border border-border bg-white px-4 text-button">刷新</button>
      </div>

      {error && <div className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}
      {orders === null && <div className="rounded-card border border-border bg-white py-16 text-center text-caption text-gray3">加载中…</div>}
      {orders !== null && visible.length === 0 && (
        <div className="rounded-card border border-border bg-white py-16 text-center">
          <div className="text-h2">✓ 当前没有匹配的待处理订单</div>
          <p className="mt-1 text-caption text-gray3">历史订货单和配送单仍可从上方标签查询。</p>
        </div>
      )}

      <ul className="space-y-3">
        {displayGroups.map(entry => {
          if (entry.group) {
            return (
              <InternalOperationGroupCard
                key={`group:${entry.group.id}`}
                group={entry.group}
                submitting={submitting}
                onBatchConfirm={confirmOperationGroup}
              />
            )
          }
          const order = entry.order!
          return (
          <li key={order.id} className="rounded-card border border-border bg-white p-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={orderStatusTone(order.status)}>{formatOrderStatusLabel(order.status)}</Chip>
                  <b className="font-num text-body">#{order.no}</b>
                  <span className="text-micro text-gray3">{new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
                <h2 className="mt-2 text-h2">{order.store?.name || '未知门店'}</h2>
                <p className="mt-1 text-caption text-gray2">{itemSummary(order)}</p>
              </div>
              <div className="text-caption text-gray2">
                <div>供应商：{order.supplier?.name || '未分配'}</div>
                <div className="mt-1">期望到货：{order.expectedDate?.slice(0, 10) || '—'}</div>
                <div className="mt-1 font-num text-h2 text-ink">¥{Number(order.totalAmount || 0).toLocaleString('zh-CN')}</div>
              </div>
              <Link
                href={`/v2/supply-chain/fulfillment/${order.id}`}
                className="rounded-cta bg-ink px-4 py-2.5 text-center text-button text-white"
              >{actionLabel(order.status)} ›</Link>
            </div>
          </li>
          )
        })}
      </ul>
    </div>
  )
}
