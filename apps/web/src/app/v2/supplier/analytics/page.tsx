/**
 * 供应商 · 销售分析
 *
 * SKU 热销 / 滞销 + 月度趋势
 * 接 GET /api/supplier/insights/sku-rank, /sales-trend
 */
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Chip } from '@/components/v2'
import { Sparkline } from '@/components/v2/sparkline'
import { apiFetch } from '@/lib/v2-auth'

type SkuRank = {
  productId: string; name: string; unit: string
  qty: number; amount: number; orders: number
  price?: number
}
type Trend = { month: string; revenue: number; orders: number }

export default function SupplierAnalyticsPage() {
  const router = useRouter()
  const [rank, setRank] = useState<{ top: SkuRank[]; bottom: SkuRank[]; periodDays: number } | null>(null)
  const [trend, setTrend] = useState<Trend[] | null>(null)
  const [days, setDays] = useState(30)
  const [error, setError] = useState<string | null>(null)

  function load() {
    apiFetch<any>(`/api/supplier/insights/sku-rank?days=${days}&limit=10`)
      .then(setRank).catch(e => setError(e.message || '加载失败'))
    apiFetch<Trend[]>(`/api/supplier/insights/sales-trend?months=6`)
      .then(setTrend).catch(() => setTrend([]))
  }
  useEffect(() => { load() }, [days])

  // 趋势 sparkline 数据 + 当月环比
  const trendValues = (trend || []).map(t => t.revenue)
  const currentMonth = trend?.[trend.length - 1]?.revenue || 0
  const lastMonth = trend?.[trend.length - 2]?.revenue || 0
  const mom = lastMonth > 0 ? ((currentMonth - lastMonth) / lastMonth) * 100 : 0

  // top 总额
  const topAmount = (rank?.top || []).reduce((s, t) => s + t.amount, 0)

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="px-4 pt-4 pb-2 flex items-center gap-2">
        <button onClick={() => router.back()} className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">‹</button>
        <h1 className="text-h1 flex-1">销售分析</h1>
      </header>
      <p className="px-4 mt-1 text-micro text-gray3">看清你卖了啥, 决定下个月备啥货</p>

      {/* 月度趋势 */}
      <Section title="月度销售趋势" right="近 6 月">
        <div className="bg-white rounded-card border border-border p-4">
          {trend === null && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
          {trend && trend.length > 0 && (
            <>
              <div className="flex items-baseline justify-between mb-2">
                <div>
                  <div className="text-micro text-gray3">本月成交</div>
                  <div className="font-num text-h1 mt-0.5">¥{Math.round(currentMonth).toLocaleString()}</div>
                </div>
                {trend.length > 1 && lastMonth > 0 && (
                  <span className={`text-caption ${mom >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                    {mom >= 0 ? '↑' : '↓'} {Math.abs(mom).toFixed(1)}% 环比
                  </span>
                )}
              </div>
              {trendValues.length > 1 && (
                <div className="my-3"><Sparkline data={trendValues} /></div>
              )}
              <div className="grid grid-cols-6 gap-1 mt-2 text-center">
                {trend.map(t => (
                  <div key={t.month}>
                    <div className="font-num text-caption">¥{Math.round(t.revenue / 1000)}k</div>
                    <div className="text-micro text-gray3 mt-0.5">{t.month.slice(5)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Section>

      {/* 时间范围 chips for SKU rank */}
      <div className="px-4 mt-5 flex items-baseline justify-between">
        <h2 className="text-h2">SKU 排行</h2>
        <div className="flex gap-1">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
                    className={`px-2.5 py-1 rounded-chip text-caption ${days === d ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {d}天
            </button>
          ))}
        </div>
      </div>

      {/* 热销 TOP 10 */}
      <Section title="🔥 热销 TOP 10" right={`累计 ¥${Math.round(topAmount).toLocaleString()}`}>
        {!rank && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {rank && rank.top.length === 0 && (
          <p className="text-caption text-gray3 text-center py-4">该时段暂无成交</p>
        )}
        <ol className="bg-white rounded-card border border-border divide-y divide-border">
          {rank?.top.map((s, i) => (
            <li key={s.productId} className="flex items-center px-3 py-2.5 gap-3">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-caption font-num ${i === 0 ? 'bg-amber text-white' : i === 1 ? 'bg-gray3 text-white' : i === 2 ? 'bg-orange text-white' : 'bg-bg text-gray2'}`}>
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-body truncate">{s.name}</div>
                <div className="text-micro text-gray3 font-num">{s.qty.toFixed(1)} {s.unit} · {s.orders} 单</div>
              </div>
              <div className="font-num text-h2 text-amber-fg">¥{Math.round(s.amount).toLocaleString()}</div>
            </li>
          ))}
        </ol>
      </Section>

      {/* 滞销 / 上架但 0 销量 */}
      <Section title="❄ 滞销 SKU" right={`${days}天内 0 单`}>
        {!rank && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {rank && rank.bottom.length === 0 && (
          <p className="text-caption text-gray3 text-center py-4">✓ 所有 SKU 都有销售</p>
        )}
        {rank && rank.bottom.length > 0 && (
          <>
            <p className="text-micro text-gray3 mb-2">这些 SKU 上架但 {days} 天内没卖出 — 考虑下架或推广</p>
            <ul className="bg-white rounded-card border border-border divide-y divide-border">
              {rank.bottom.map(s => (
                <li key={s.productId} className="flex items-center px-3 py-2.5 gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{s.name}</div>
                    <div className="text-micro text-gray3 font-num">¥{Number(s.price || 0).toFixed(2)} / {s.unit}</div>
                  </div>
                  <Chip tone="gray">0 单</Chip>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {error && <div className="mx-4 mt-3 bg-red-bg text-red-fg rounded-card p-3 text-caption">{error}</div>}
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-caption text-gray3">{right}</span>}
      </div>
      {children}
    </section>
  )
}
