'use client'

import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { ErrorScreen, LoadingScreen, useDashboard } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type DocumentRow = {
  status: string
}

export default function InternalSupplyChainHomePage() {
  const { data, error } = useDashboard()
  const [orders, setOrders] = useState<DocumentRow[]>([])
  const [loadingRows, setLoadingRows] = useState(true)
  const [rowError, setRowError] = useState('')

  useEffect(() => {
    let alive = true
    setLoadingRows(true)
    setRowError('')
    apiFetch<{ items: DocumentRow[] }>('/api/orders?page=1&pageSize=100')
      .then(orderData => {
        if (!alive) return
        setOrders((orderData.items || []).filter(row => ['SUBMITTED', 'CONFIRMED', 'DELIVERING'].includes(row.status)))
      })
      .catch(reason => {
        if (alive) setRowError(String(reason?.message || reason))
      })
      .finally(() => {
        if (alive) setLoadingRows(false)
      })
    return () => { alive = false }
  }, [])

  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />

  const stores = data.supplyChain?.stores || []
  const actionCounts = {
    submitted: orders.filter(row => row.status === 'SUBMITTED').length,
    confirmed: orders.filter(row => row.status === 'CONFIRMED').length,
    delivering: orders.filter(row => row.status === 'DELIVERING').length,
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="mx-auto flex max-w-[1440px] flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部供应链</Chip>
            <span className="text-caption text-gray3">统一采购 · 仓库 · 跨店履约</span>
          </div>
          <h1 className="text-h1">内部供应链工作台</h1>
          <p className="mt-1 text-caption text-gray2">只保留当前需要行动的任务；门店订货、收货、库存和消耗已归入门店运营。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href="/v2/supply-chain/fulfillment" className="rounded-cta bg-accent px-4 py-2.5 text-button text-white">去订单中心</a>
          <a href="/v2/supply-chain/stores" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button">门店运营</a>
          <a href="/v2/supply-chain/inventory" className="rounded-cta border border-border bg-white px-4 py-2.5 text-button">仓库库存</a>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px]">
        <section className="grid gap-3 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="服务门店" value={`${stores.length} 家`} />
          <Metric label="未结订货单" value={String(data.supplyChain?.counts.orders || 0)} />
          <Metric label="在途配送" value={String(data.supplyChain?.counts.deliveries || 0)} />
          <Metric label="有效收货" value={String(data.supplyChain?.counts.receipts || 0)} />
        </section>

        {rowError && <div className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{rowError}</div>}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
          <div className="overflow-hidden rounded-card border border-border bg-white">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-h2">订单动作概览</h2>
                <p className="text-micro text-gray3">工作台只提示数量，单据与操作统一进入订单中心</p>
              </div>
              <a href="/v2/supply-chain/fulfillment" className="text-caption text-accent">进入订单中心 ›</a>
            </div>
            <div className="grid gap-3 p-4 sm:grid-cols-3">
              <ActionCount label="待接单" value={actionCounts.submitted} tone="orange" loading={loadingRows} />
              <ActionCount label="待发货" value={actionCounts.confirmed} tone="gray" loading={loadingRows} />
              <ActionCount label="配送中" value={actionCounts.delivering} tone="green" loading={loadingRows} />
            </div>
            <div className="border-t border-border bg-bg px-4 py-4">
              <p className="text-caption text-gray2">
                {loadingRows ? '正在汇总订单动作…' : orders.length > 0 ? `当前共有 ${orders.length} 单需要跟进。` : '当前没有待处理订单。'}
              </p>
              <a href="/v2/supply-chain/fulfillment" className="mt-3 inline-flex rounded-cta bg-accent px-4 py-2.5 text-button text-white">
                打开订单中心处理
              </a>
            </div>
          </div>

          <div className="space-y-4">
            <section className="rounded-card border border-border bg-white p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-caption text-gray3">门店运营</div>
                  <div className="mt-1 font-num text-h1">{stores.length} 家</div>
                </div>
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber/10 text-xl font-bold text-amber-fg">店</span>
              </div>
              <p className="mt-3 text-caption leading-6 text-gray2">按门店查看订货、收货、当前库存和近30天消耗，数据保持只读。</p>
              <a href="/v2/supply-chain/stores" className="mt-4 block rounded-cta bg-ink px-4 py-2.5 text-center text-button text-white">进入门店运营</a>
            </section>

            <section className="rounded-card border border-border bg-white p-5">
              <h2 className="text-h2">快捷入口</h2>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center text-button">
                <a href="/v2/supply-chain/differences" className="rounded-cta border border-border bg-bg px-3 py-3">到货差异</a>
                <a href="/v2/supply-chain/products" className="rounded-cta border border-border bg-bg px-3 py-3">商品管理</a>
                <a href="/v2/supply-chain/inventory" className="rounded-cta border border-border bg-bg px-3 py-3">仓库库存</a>
                <a href="/v2/supply-chain/analytics" className="rounded-cta border border-border bg-bg px-3 py-3">经营分析</a>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div>
}

function ActionCount({ label, value, tone, loading }: { label: string; value: number; tone: 'orange' | 'gray' | 'green'; loading: boolean }) {
  return (
    <div className="rounded-card border border-border bg-bg p-4">
      <Chip tone={tone}>{label}</Chip>
      <div className="mt-3 font-num text-h1">{loading ? '—' : value}</div>
      <div className="mt-1 text-micro text-gray3">仅提示，不在工作台展开单据</div>
    </div>
  )
}
