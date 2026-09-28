'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'
import { replenishmentItemSummary, replenishmentStatusLabel, replenishmentStatusTone, type ReplenishmentOrder } from '@/lib/replenishment-orders'

export default function StoreReplenishmentOrdersPage() {
  const [rows, setRows] = useState<ReplenishmentOrder[] | null>(null)
  const [expanded, setExpanded] = useState('')
  const [error, setError] = useState('')
  function load() {
    setError('')
    apiFetch<{ items: ReplenishmentOrder[] }>('/api/replenishment-orders?page=1&pageSize=100')
      .then(result => setRows(result.items || []))
      .catch(reason => { setRows([]); setError(String(reason?.message || reason)) })
  }
  useEffect(load, [])
  return <div className="min-h-screen bg-bg px-4 py-5 pb-16">
    <header className="border-b border-border pb-4"><Link href="/v2/manager/home" className="text-caption text-gray2">‹ 返回工作台</Link><h1 className="mt-2 text-h1">本店补货进度</h1><p className="mt-1 text-caption text-gray2">查看供应链代本店登记的额外补货；原订货单不会被修改。</p></header>
    <main className="mt-4 space-y-3">
      {!rows && !error && [1, 2, 3].map(item => <SkeletonCard key={item} />)}
      {error && <FriendlyError message={error} onRetry={load} />}
      {rows?.length === 0 && !error && <EmptyState title="本店暂无补货单" hint="供应链创建并提交后会在这里显示。" />}
      {rows?.map(order => <article key={order.id} className="rounded-card border border-border bg-white p-4">
        <button type="button" onClick={() => setExpanded(value => value === order.id ? '' : order.id)} className="w-full text-left">
          <div className="flex items-start justify-between gap-3"><div><b className="font-num text-body">{order.no}</b><p className="mt-1 text-h2">{order.supplier.name}</p></div><Chip tone={replenishmentStatusTone(order.displayStatus)}>{replenishmentStatusLabel(order.displayStatus)}</Chip></div>
          <p className="mt-2 text-caption text-gray2">期望到货：{order.expectedDate.slice(0, 10)} · {replenishmentItemSummary(order.items)}</p>
          <p className="mt-2 text-micro text-gray3">创建：{new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })} · {expanded === order.id ? '收起详情' : '查看详情'}</p>
        </button>
        {expanded === order.id && <div className="mt-4 border-t border-border pt-4">
          <div className="space-y-2">{order.items.map(item => <div key={item.productId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl bg-bg px-3 py-2"><div><b className="text-body">{item.productNameSnapshot}</b><p className="text-micro text-gray3">{item.productCodeSnapshot || '无编码'} · {item.productSpecSnapshot || '无规格'}</p></div><div className="text-right font-num text-caption"><div>{item.quantity} {item.orderUnitSnapshot}</div><div className="text-gray3">¥{Number(item.unitPrice).toFixed(2)} / {item.orderUnitSnapshot}</div></div></div>)}</div>
          <p className="mt-3 text-caption text-gray2">备注：{order.note || '—'}</p>
          {order.fulfillment?.purchaseOrderId && <div className="mt-3 flex flex-wrap gap-2"><Link href={`/v2/manager/purchase/${order.fulfillment.purchaseOrderId}/receive`} className="rounded-cta bg-ink px-4 py-2 text-button text-white">查看收货进度</Link></div>}
        </div>}
      </article>)}
    </main>
  </div>
}
