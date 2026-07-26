'use client'

import { useEffect, useState } from 'react'
import { Chip } from '@/components/v2'
import { ErrorScreen, LoadingScreen, useDashboard } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type DocumentRow = {
  id: string
  no: string
  status: string
  totalAmount?: number | string
  store?: { id: string; name: string }
  supplier?: { id: string; name: string }
  createdAt?: string
}

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: '待接单',
  CONFIRMED: '待发货',
  DELIVERING: '配送中',
}

function money(value: unknown) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) ? `¥${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : '—'
}

function dateText(value?: string) {
  return value ? value.slice(0, 10) : '—'
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
          <Metric label="进行中订单" value={String(data.supplyChain?.counts.orders || 0)} />
          <Metric label="在途配送" value={String(data.supplyChain?.counts.deliveries || 0)} />
          <Metric label="有效收货" value={String(data.supplyChain?.counts.receipts || 0)} />
        </section>

        {rowError && <div className="mb-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{rowError}</div>}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
          <div className="overflow-hidden rounded-card border border-border bg-white">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-h2">今日待处理</h2>
                <p className="text-micro text-gray3">跨门店汇总待接单、待发货和配送中订单</p>
              </div>
              <a href="/v2/supply-chain/fulfillment" className="text-caption text-accent">进入订单中心 ›</a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-caption">
                <thead className="bg-bg text-gray3"><tr><th className="px-4 py-2">订单 / 门店</th><th className="px-4 py-2">供应商</th><th className="px-4 py-2">状态</th><th className="px-4 py-2 text-right">金额</th><th className="px-4 py-2"></th></tr></thead>
                <tbody className="divide-y divide-border">
                  {orders.slice(0, 12).map(row => (
                    <tr key={row.id}>
                      <td className="px-4 py-3"><b className="font-num">{row.no}</b><div className="text-micro text-gray3">{row.store?.name || '—'} · {dateText(row.createdAt)}</div></td>
                      <td className="px-4 py-3">{row.supplier?.name || '—'}</td>
                      <td className="px-4 py-3"><Chip tone={row.status === 'SUBMITTED' ? 'orange' : 'gray'}>{STATUS_LABELS[row.status] || row.status}</Chip></td>
                      <td className="px-4 py-3 text-right font-num">{money(row.totalAmount)}</td>
                      <td className="px-4 py-3 text-right"><a className="text-accent" href={`/v2/supply-chain/fulfillment/${row.id}`}>处理 ›</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loadingRows && orders.length === 0 && <Empty text="当前没有待处理订单" />}
            {loadingRows && <Empty text="加载中…" />}
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

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-10 text-center text-caption text-gray3">{text}</div>
}
