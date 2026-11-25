'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Chip } from '@/components/v2'
import { OrderCenterTabs } from '@/components/v2/order-center-tabs'
import { apiFetch } from '@/lib/v2-auth'
import { fulfillmentFiltersFromSearch, type FulfillmentBucket, type FulfillmentOrderDayFilter } from '@/lib/fulfillment-filters'
import { buildFulfillmentGroups, fulfillmentOrderDay, loadAllActionableFulfillmentOrders, type FulfillmentGroup, type OperationGroup } from '@/lib/fulfillment-groups'
import { formatOrderStatusLabel, orderStatusTone } from '@/lib/supply-order-delivery-pc'

type Order = {
  id: string
  no: string
  status: string
  expectedDate?: string | null
  totalAmount?: number | string
  createdAt: string
  submittedAt?: string | null
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

type Bucket = FulfillmentBucket

const BUCKETS: Array<{ value: Bucket; label: string }> = [
  { value: 'ALL', label: '全部待办' },
  { value: 'SUBMITTED', label: '待接单' },
  { value: 'CONFIRMED', label: '待发货' },
  { value: 'DELIVERING', label: '待送达' },
]
type OrderDay = FulfillmentOrderDayFilter
const ORDER_DAYS: Array<{ value: OrderDay; label: string; hint: string }> = [
  { value: 'ALL', label: '全部订货日', hint: '所有待办' },
  { value: 'TODAY', label: '今日下单', hint: '今日待发货、待送达' },
  { value: 'YESTERDAY', label: '昨日下单', hint: '昨日待发货、待送达' },
]

function isShipmentWork(order: Order) {
  return order.status === 'CONFIRMED' || order.status === 'DELIVERING'
}

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

function InternalOperationGroupCard({
  group,
}: {
  group: ProductionFulfillmentGroup
}) {
  const first = group.orders[0]
  const metadata = group.metadata
  if (!first || !metadata) return null
  const memberCount = Math.max(metadata.memberCount || 0, group.orders.length)
  const memberNos = metadata.memberOrderNos || group.orders.map(order => order.no)
  const missingCount = Math.max(0, memberCount - group.orders.length)
  const isPendingGroup = metadata.isEligible === true && group.orders.every(order => order.status === 'SUBMITTED')
  const hasConfirmedMember = group.orders.some(order => order.status === 'CONFIRMED')

  return (
    <li className="rounded-card border border-border bg-white px-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0 divide-y divide-border/70">
          {memberNos.map((no, index) => {
            const order = group.orders.find(row => row.no === no)
            if (!order) {
              return <div key={`${metadata.id}:${no}:${index}`} className="py-3 text-caption text-gray3">订单号：{no} · 下单日期：—</div>
            }
            return (
              <div key={`${metadata.id}:${order.id}`} className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={orderStatusTone(order.status)}>{formatOrderStatusLabel(order.status)}</Chip>
                    <b className="font-num text-body">#{order.no}</b>
                    <span className="text-micro text-gray3">下单 {new Date(order.submittedAt || order.createdAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</span>
                  </div>
                  <h2 className="mt-2 text-h2">{order.store?.name || '未知门店'}</h2>
                  <p className="mt-1 text-caption text-gray2">{itemSummary(order)}</p>
                </div>
                <div className="text-caption text-gray2">
                  <div>供应商：{order.supplier?.name || '未分配'}</div>
                  <div className="mt-1">期望到货：{order.expectedDate?.slice(0, 10) || '—'}</div>
                  <div className="mt-1 font-num text-h2 text-ink">¥{Number(order.totalAmount || 0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
              </div>
            )
          })}
          {missingCount > 0 && <div className="py-2 text-micro text-gray3">还有 {missingCount} 张订单将在批量操作时一并处理</div>}
        </div>
        <Link
          href={`/v2/supply-chain/fulfillment/group/${encodeURIComponent(metadata.id)}`}
          className="mb-4 min-w-28 rounded-cta bg-ink px-4 py-2.5 text-center text-button text-white lg:mb-0"
        >
          {isPendingGroup ? '批量接单 ›' : hasConfirmedMember ? '批量发货 ›' : '查看集合 ›'}
        </Link>
      </div>
    </li>
  )
}

export default function InternalSupplyChainFulfillmentPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialFilters = fulfillmentFiltersFromSearch(searchParams)
  const searchKey = searchParams.toString()
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>(initialFilters.bucket)
  const [orderDay, setOrderDay] = useState<OrderDay>(initialFilters.orderDay)
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState('')

  function load() {
    setError('')
    loadAllActionableFulfillmentOrders<Order>((status, page, pageSize) =>
      apiFetch<{ items: Order[]; total: number; page: number; pageSize: number }>(
        `/api/orders?status=${status}&page=${page}&pageSize=${pageSize}`,
      ))
      .then(setOrders)
      .catch(reason => {
        setOrders([])
        setError(String(reason?.message || reason))
      })
  }

  useEffect(() => { load() }, [])
  useEffect(() => {
    const filters = fulfillmentFiltersFromSearch(searchParams)
    setBucket(filters.bucket)
    setOrderDay(filters.orderDay)
  }, [searchKey, searchParams])

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
  const dayCounts = useMemo(() => ({
    ALL: actionable.length,
    TODAY: actionable.filter(order => isShipmentWork(order) && fulfillmentOrderDay(order) === 'TODAY').length,
    YESTERDAY: actionable.filter(order => isShipmentWork(order) && fulfillmentOrderDay(order) === 'YESTERDAY').length,
  }), [actionable])
  function replaceFilters(nextBucket: Bucket, nextOrderDay: OrderDay) {
    const params = new URLSearchParams()
    if (nextBucket !== 'ALL') params.set('bucket', nextBucket)
    if (nextOrderDay !== 'ALL') params.set('orderDay', nextOrderDay)
    router.replace(`/v2/supply-chain/fulfillment${params.size ? `?${params}` : ''}`)
  }
  const visible = useMemo(() => {
    const term = keyword.trim().toLowerCase()
    return actionable.filter(order => {
      if (bucket !== 'ALL' && order.status !== bucket) return false
      if (orderDay !== 'ALL' && (!isShipmentWork(order) || fulfillmentOrderDay(order) !== orderDay)) return false
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
  }, [actionable, bucket, orderDay, keyword])

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

        </div>
        <h1 className="text-h1">订单中心</h1>

      </header>

      <OrderCenterTabs />

      <section aria-label="按订货日查看" className="grid gap-3 pt-4 sm:grid-cols-3">
        {ORDER_DAYS.map(item => <button
          key={item.value}
          type="button"
          onClick={() => { setOrderDay(item.value); replaceFilters(bucket, item.value) }}
          className={`rounded-card border p-4 text-left ${orderDay === item.value ? 'border-ink bg-ink text-white' : 'border-border bg-white'}`}
        >
          <div className="flex items-center justify-between"><b>{item.label}</b><span className="font-num text-h2">{dayCounts[item.value]}</span></div>
          <div className={`mt-1 text-micro ${orderDay === item.value ? 'text-white/65' : 'text-gray3'}`}>{item.hint}</div>
        </button>)}
      </section>

      <section aria-label="订单状态筛选" className="flex flex-wrap gap-2 py-4">
        {BUCKETS.map(item => (
          <button
            key={item.value}
            type="button"
            onClick={() => { setBucket(item.value); replaceFilters(item.value, orderDay) }}
            className={`rounded-cta border px-3 py-1.5 text-button ${
              bucket === item.value ? 'border-ink bg-ink text-white' : 'border-border bg-white text-gray2'
            }`}
          >
            {item.label} <span className="font-num">{counts[item.value]}</span>
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
                  <span className="text-micro text-gray3">下单 {new Date(order.submittedAt || order.createdAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</span>
                </div>
                <h2 className="mt-2 text-h2">{order.store?.name || '未知门店'}</h2>
                <p className="mt-1 text-caption text-gray2">{itemSummary(order)}</p>
              </div>
              <div className="text-caption text-gray2">
                <div>供应商：{order.supplier?.name || '未分配'}</div>
                <div className="mt-1">期望到货：{order.expectedDate?.slice(0, 10) || '—'}</div>
                <div className="mt-1 font-num text-h2 text-ink">¥{Number(order.totalAmount || 0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
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
