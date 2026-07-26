'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type Stats = {
  purchase: { thisMonth: number; lastMonth: number; growth: string | null }
  pendingReceiptCount: number
  pendingLossCount: number
  lowStockProducts: Array<{ id: string; name: string; stock: number | string; minStock: number | string; unit: string }>
  storeBreakdown: Array<{ storeId: string; storeName: string; storeNo: string; totalAmount: number; orderCount: number }>
}
type Trend = { week: string; amount: number }

function money(value: number) {
  return `¥${Math.round(value || 0).toLocaleString('zh-CN')}`
}

export default function InternalSupplyChainAnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [trend, setTrend] = useState<Trend[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      apiFetch<Stats>('/api/dashboard/stats'),
      apiFetch<Trend[]>('/api/dashboard/purchase-trend?days=30'),
    ])
      .then(([statsData, trendData]) => {
        setStats(statsData)
        setTrend(trendData || [])
      })
      .catch(reason => setError(String(reason?.message || reason)))
  }, [])

  const maxTrend = useMemo(() => Math.max(1, ...trend.map(item => item.amount)), [trend])

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="border-b border-border pb-5">
        <div className="mb-2 flex items-center gap-2">
          <Chip tone="green">内部分析</Chip>
          <span className="text-caption text-gray3">采购与履约事实口径</span>
        </div>
        <h1 className="text-h1">经营分析</h1>
        <p className="mt-1 text-caption text-gray2">按确认收货与实际金额汇总，不包含门店营业额和成本率。</p>
      </header>
      {error && <div className="mt-4 rounded-card border border-red/30 bg-red-bg p-3 text-caption text-red-fg">{error}</div>}

      <section className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="本月采购" value={stats ? money(stats.purchase.thisMonth) : '—'} />
        <Metric label="上月采购" value={stats ? money(stats.purchase.lastMonth) : '—'} />
        <Metric label="采购环比" value={stats?.purchase.growth ? `${stats.purchase.growth}%` : '—'} />
        <Metric label="待收货" value={String(stats?.pendingReceiptCount ?? '—')} />
        <Metric label="待处理差异" value={String(stats?.pendingLossCount ?? '—')} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-card border border-border bg-white p-5">
          <h2 className="text-h2">近 30 天采购趋势</h2>
          <p className="mt-1 text-micro text-gray3">按周汇总确认收货金额</p>
          <div className="mt-6 flex h-52 items-end gap-3 border-b border-border px-2">
            {trend.map(item => (
              <div key={item.week} className="flex h-full min-w-0 flex-1 flex-col justify-end text-center">
                <span className="mb-1 truncate font-num text-micro text-gray2">{money(item.amount)}</span>
                <div className="mx-auto w-full max-w-16 rounded-t bg-amber" style={{ height: `${Math.max(4, item.amount / maxTrend * 160)}px` }} />
                <span className="mt-2 font-num text-micro text-gray3">{item.week}</span>
              </div>
            ))}
            {trend.length === 0 && <div className="m-auto text-caption text-gray3">近 30 天暂无采购</div>}
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-h2">门店采购分布</h2>
            <p className="mt-1 text-micro text-gray3">本月实际收货金额与单数</p>
          </div>
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">门店</th><th className="px-4 py-3 text-right">收货单</th><th className="px-4 py-3 text-right">金额</th></tr></thead>
            <tbody className="divide-y divide-border">
              {(stats?.storeBreakdown || []).map(row => (
                <tr key={row.storeId}>
                  <td className="px-4 py-3"><b>{row.storeName}</b><span className="ml-2 font-num text-micro text-gray3">{row.storeNo}</span></td>
                  <td className="px-4 py-3 text-right font-num">{row.orderCount}</td>
                  <td className="px-4 py-3 text-right font-num">{money(row.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stats && stats.storeBreakdown.length === 0 && <div className="py-12 text-center text-caption text-gray3">本月暂无收货</div>}
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-card border border-border bg-white">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-h2">低库存商品</h2>
          <p className="mt-1 text-micro text-gray3">当前物理库存低于安全线</p>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {(stats?.lowStockProducts || []).map(item => (
            <div key={item.id} className="rounded-cta border border-red/20 bg-red-bg/40 p-3">
              <b className="text-body">{item.name}</b>
              <div className="mt-1 font-num text-caption text-red-fg">{Number(item.stock)} / 安全线 {Number(item.minStock)} {item.unit}</div>
            </div>
          ))}
        </div>
        {stats && stats.lowStockProducts.length === 0 && <div className="py-12 text-center text-caption text-gray3">✓ 当前无低库存商品</div>}
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div>
}
