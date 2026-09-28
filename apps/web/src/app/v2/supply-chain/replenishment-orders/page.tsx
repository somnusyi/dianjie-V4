'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { OrderCenterTabs } from '@/components/v2/order-center-tabs'
import { EmptyState, FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { apiFetch, getUser } from '@/lib/v2-auth'
import {
  REPLENISHMENT_STATUS_OPTIONS,
  replenishmentItemSummary,
  replenishmentNextStep,
  replenishmentStatusLabel,
  replenishmentStatusTone,
  type ReplenishmentOrder,
  type ReplenishmentStatus,
} from '@/lib/replenishment-orders'

type ListResult = { items: ReplenishmentOrder[]; total: number; page: number; pageSize: number }

function dateText(value?: string | null) {
  return value ? value.slice(0, 10) : '—'
}

export default function ReplenishmentOrdersPage() {
  const [rows, setRows] = useState<ReplenishmentOrder[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<ReplenishmentStatus | ''>('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const pageSize = 20
  const canWrite = ['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'].includes(getUser()?.role || '')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (status) query.set('status', status)
    apiFetch<ListResult>(`/api/replenishment-orders?${query}`)
      .then(result => {
        setRows(result.items || [])
        setTotal(result.total || 0)
      })
      .catch(reason => {
        setRows([])
        setError(String(reason?.message || reason))
      })
      .finally(() => setLoading(false))
  }, [page, status])

  useEffect(() => { load() }, [load])
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const range = useMemo(() => total === 0 ? '0 条' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} / ${total} 条`, [page, total])

  return (
    <div className="min-h-screen bg-bg px-4 py-5 pb-24 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-4 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2"><Chip tone="orange">独立单据</Chip><span className="text-caption text-gray3">不修改原订货单金额</span></div>
          <h1 className="text-h1">门店补货单</h1>
          <p className="mt-1 text-caption text-gray2">供应链代门店登记额外补货，接单后进入正式配送、收货与对账。</p>
        </div>
        {canWrite && <Link href="/v2/supply-chain/replenishment-orders/new" className="rounded-cta bg-ink px-5 py-3 text-center text-button text-white">新建补货单</Link>}
      </header>

      <main className="mx-auto max-w-[1440px]">
        <OrderCenterTabs />
        <div className="flex flex-wrap items-end justify-between gap-3 py-4">
          <label className="text-caption text-gray2">状态
            <select aria-label="补货单状态" value={status} onChange={event => { setStatus(event.target.value as ReplenishmentStatus | ''); setPage(1) }} className="mt-1 block min-w-44 rounded-xl border border-border bg-white px-3 py-2.5 text-body text-ink">
              {REPLENISHMENT_STATUS_OPTIONS.map(option => <option key={option.value || 'ALL'} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <span className="text-caption text-gray3">{range}</span>
        </div>

        {loading && rows === null && <div className="space-y-3">{[1, 2, 3].map(item => <SkeletonCard key={item} />)}</div>}
        {error && <FriendlyError message={error} onRetry={load} />}
        {!loading && !error && rows?.length === 0 && (
          <EmptyState title={status ? '这个状态下暂无补货单' : '还没有门店补货单'} hint="补货是独立需求，不会改动原订货单。" cta={canWrite ? { label: '新建补货单', href: '/v2/supply-chain/replenishment-orders/new' } : undefined} />
        )}

        {rows && rows.length > 0 && <>
          <div className="hidden overflow-x-auto rounded-card border border-border bg-white lg:block">
            <table className="min-w-[1320px] w-full text-left text-caption">
              <thead className="border-b border-border bg-bg text-gray3"><tr>
                {['补货单号', '门店', '供应商', '期望到货日', '商品摘要', '状态', '来源', '创建时间', '创建人', '备注', '下一步'].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map(order => {
                  const next = replenishmentNextStep(order)
                  return <tr key={order.id}>
                    <td className="px-3 py-3"><Link className="font-num font-semibold text-amber-fg" href={`/v2/supply-chain/replenishment-orders/${order.id}`}>{order.no}</Link></td>
                    <td className="px-3 py-3">{order.store.name}</td><td className="px-3 py-3">{order.supplier.name}</td>
                    <td className="px-3 py-3 font-num">{dateText(order.expectedDate)}</td><td className="max-w-56 px-3 py-3">{replenishmentItemSummary(order.items)}</td>
                    <td className="px-3 py-3"><Chip tone={replenishmentStatusTone(order.displayStatus)}>{replenishmentStatusLabel(order.displayStatus)}</Chip></td>
                    <td className="px-3 py-3">供应链代门店</td><td className="px-3 py-3 font-num">{new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td className="px-3 py-3">{order.createdBy.name}</td><td className="max-w-44 truncate px-3 py-3" title={order.note || ''}>{order.note || '—'}</td>
                    <td className="px-3 py-3"><Link href={next.href} className="whitespace-nowrap font-semibold text-amber-fg">{next.label} ›</Link></td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>

          <ul className="space-y-3 lg:hidden">
            {rows.map(order => {
              const next = replenishmentNextStep(order)
              return <li key={order.id} className="rounded-card border border-border bg-white p-4">
                <div className="flex items-start justify-between gap-3"><div><Link className="font-num font-semibold text-amber-fg" href={`/v2/supply-chain/replenishment-orders/${order.id}`}>{order.no}</Link><h2 className="mt-1 text-h2">{order.store.name}</h2></div><Chip tone={replenishmentStatusTone(order.displayStatus)}>{replenishmentStatusLabel(order.displayStatus)}</Chip></div>
                <p className="mt-2 text-caption text-gray2">{order.supplier.name} · 到货 {dateText(order.expectedDate)}</p>
                <p className="mt-2 text-caption">{replenishmentItemSummary(order.items)}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-micro text-gray3"><span>来源：供应链代门店</span><span>创建人：{order.createdBy.name}</span><span className="col-span-2">创建：{new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}</span><span className="col-span-2">备注：{order.note || '—'}</span></div>
                <Link href={next.href} className="mt-4 block rounded-cta bg-ink px-4 py-2.5 text-center text-button text-white">{next.label}</Link>
              </li>
            })}
          </ul>
          <div className="mt-4 flex items-center justify-between"><button disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-xl border border-border bg-white px-4 py-2 text-button disabled:opacity-40">上一页</button><span className="text-caption text-gray3">第 {page} / {pages} 页</span><button disabled={page >= pages} onClick={() => setPage(value => Math.min(pages, value + 1))} className="rounded-xl border border-border bg-white px-4 py-2 text-button disabled:opacity-40">下一页</button></div>
        </>}
      </main>
    </div>
  )
}
