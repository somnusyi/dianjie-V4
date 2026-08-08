'use client'

import { useEffect, useMemo, useState } from 'react'
import { Chip } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'

type Supplier = { id: string; no: string; name: string }
type Stats = {
  purchase: { thisMonth: number; lastMonth: number; growth: string | null }
  pendingReceiptCount: number
  pendingLossCount: number
  lowStockProducts: Array<{ id: string; name: string; stock: number | string; minStock: number | string; unit: string }>
  storeBreakdown: Array<{ storeId: string; storeName: string; storeNo: string; totalAmount: number; orderCount: number }>
}
type WeeklyTrend = { week: string; amount: number }
type Audit = {
  checkedAt: string
  inventoryMode: string
  summary: { errors: number; warnings: number; products: number; deliveries: number; receipts: number }
  issues: Array<{ code: string; severity: 'ERROR' | 'WARNING'; label: string; detail: string }>
}
type Customer = {
  storeId: string; name: string; no: string; totalOrders: number; totalAmount: number
  monthOrders: number; monthAmount: number; lastOrderAt: string; daysSinceLastOrder: number
}
type SkuRank = {
  top: Array<{ productId: string; name: string; unit: string; qty: number; amount: number; orders: number }>
  bottom: Array<{ productId: string; name: string; unit: string; qty: number; amount: number; orders: number }>
}
type MonthlyTrend = { month: string; receivedAmount: number; orders: number }

function money(value: number) {
  return `¥${Math.round(value || 0).toLocaleString('zh-CN')}`
}

export default function InternalSupplyChainAnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [weeklyTrend, setWeeklyTrend] = useState<WeeklyTrend[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [audit, setAudit] = useState<Audit | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [skuRank, setSkuRank] = useState<SkuRank>({ top: [], bottom: [] })
  const [monthlyTrend, setMonthlyTrend] = useState<MonthlyTrend[]>([])
  const [error, setError] = useState('')
  const [insightLoading, setInsightLoading] = useState(false)

  useEffect(() => {
    Promise.all([
      apiFetch<Stats>('/api/dashboard/stats'),
      apiFetch<WeeklyTrend[]>('/api/dashboard/purchase-trend?days=30'),
      // 本页分析的是门店订货、配送和收货履约，不是总仓向上游的采购关系。
      apiFetch<Supplier[]>('/api/suppliers?status=ENABLED&businessScope=STORE_FULFILLER'),
    ])
      .then(([statsData, trendData, supplierRows]) => {
        setStats(statsData)
        setWeeklyTrend(trendData || [])
        const list = Array.isArray(supplierRows) ? supplierRows : []
        setSuppliers(list)
        if (list[0]) setSupplierId(list[0].id)
      })
      .catch(reason => setError(String(reason?.message || reason)))
  }, [])

  useEffect(() => {
    if (!supplierId) return
    let alive = true
    setInsightLoading(true)
    setError('')
    const scope = `supplierId=${encodeURIComponent(supplierId)}`
    Promise.all([
      apiFetch<Audit>(`/api/supplier/insights/audit?days=90&${scope}`),
      apiFetch<Customer[]>(`/api/supplier/insights/customers?days=90&${scope}`),
      apiFetch<SkuRank>(`/api/supplier/insights/sku-rank?days=30&limit=10&${scope}`),
      apiFetch<MonthlyTrend[]>(`/api/supplier/insights/sales-trend?months=6&${scope}`),
    ]).then(([auditData, customerRows, skuData, monthRows]) => {
      if (!alive) return
      setAudit(auditData)
      setCustomers(customerRows || [])
      setSkuRank(skuData || { top: [], bottom: [] })
      setMonthlyTrend(monthRows || [])
    }).catch(reason => {
      if (alive) setError(String(reason?.message || reason))
    }).finally(() => {
      if (alive) setInsightLoading(false)
    })
    return () => { alive = false }
  }, [supplierId])

  const maxWeekly = useMemo(() => Math.max(1, ...weeklyTrend.map(item => item.amount)), [weeklyTrend])
  const maxMonthly = useMemo(() => Math.max(1, ...monthlyTrend.map(item => item.receivedAmount)), [monthlyTrend])

  return (
    <div className="min-h-screen bg-bg px-4 py-5 lg:px-8 lg:py-7">
      <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Chip tone="green">内部分析</Chip>
            <span className="text-caption text-gray3">确认收货与应付事实口径</span>
          </div>
          <h1 className="text-h1">经营分析</h1>
          <p className="mt-1 text-caption text-gray2">集团采购概览与单一供应商的履约、商品和台账健康统一查看。</p>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-micro text-gray3">门店供货主体范围</span>
          <select value={supplierId} onChange={event => setSupplierId(event.target.value)} className="h-10 min-w-72 rounded-cta border border-border bg-white px-3 text-body">
            {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.no} · {supplier.name}</option>)}
          </select>
        </label>
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
        <TrendCard title="集团近 30 天采购趋势" subtitle="按周汇总确认收货金额" rows={weeklyTrend.map(row => ({ label: row.week, amount: row.amount }))} max={maxWeekly} />
        <TrendCard title="供应商近 6 个月实收趋势" subtitle="按确认入库的应付金额汇总" rows={monthlyTrend.map(row => ({ label: row.month, amount: row.receivedAmount }))} max={maxMonthly} />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="rounded-card border border-border bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div><h2 className="text-h2">数据健康</h2><p className="mt-1 text-micro text-gray3">库存、预占、配送、入库与应付自动核查</p></div>
            {insightLoading ? <Chip tone="gray">检查中</Chip> : <Chip tone={(audit?.summary.errors || 0) > 0 ? 'red' : 'green'}>{audit?.summary.errors || 0} 错误</Chip>}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <SmallMetric label="错误" value={audit?.summary.errors ?? 0} tone="red" />
            <SmallMetric label="警告" value={audit?.summary.warnings ?? 0} tone="orange" />
            <SmallMetric label="商品" value={audit?.summary.products ?? 0} />
          </div>
          <ul className="mt-4 max-h-80 divide-y divide-border overflow-auto">
            {(audit?.issues || []).slice(0, 20).map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="py-3">
                <div className="flex gap-2"><Chip tone={issue.severity === 'ERROR' ? 'red' : 'orange'}>{issue.severity === 'ERROR' ? '错误' : '警告'}</Chip><b className="text-caption">{issue.label}</b></div>
                <p className="mt-1 text-micro text-gray2">{issue.detail}</p>
              </li>
            ))}
          </ul>
          {!insightLoading && audit?.issues.length === 0 && <div className="py-10 text-center text-caption text-green-fg">✓ 未发现台账异常</div>}
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-white">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-h2">门店履约分布</h2>
            <p className="mt-1 text-micro text-gray3">所选供应商近 90 天确认收货金额与单数</p>
          </div>
          <table className="w-full text-left text-caption">
            <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">门店</th><th className="px-4 py-3 text-right">本月</th><th className="px-4 py-3 text-right">90 天单数</th><th className="px-4 py-3 text-right">90 天金额</th><th className="px-4 py-3 text-right">最近收货</th></tr></thead>
            <tbody className="divide-y divide-border">
              {customers.map(row => (
                <tr key={row.storeId}>
                  <td className="px-4 py-3"><b>{row.name}</b><span className="ml-2 font-num text-micro text-gray3">{row.no}</span></td>
                  <td className="px-4 py-3 text-right font-num">{money(row.monthAmount)} / {row.monthOrders} 单</td>
                  <td className="px-4 py-3 text-right font-num">{row.totalOrders}</td>
                  <td className="px-4 py-3 text-right font-num">{money(row.totalAmount)}</td>
                  <td className="px-4 py-3 text-right font-num text-gray2">{row.daysSinceLastOrder} 天前</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!insightLoading && customers.length === 0 && <div className="py-12 text-center text-caption text-gray3">近 90 天暂无确认收货</div>}
        </div>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <SkuTable title="近 30 天采购商品 Top 10" rows={skuRank.top} empty="暂无确认收货商品" />
        <SkuTable title="近 30 天无实收商品" rows={skuRank.bottom} empty="所有启用商品均有实收记录" />
      </section>

      <section className="mt-4 overflow-hidden rounded-card border border-border bg-white">
        <div className="border-b border-border px-5 py-4"><h2 className="text-h2">集团门店采购分布</h2><p className="mt-1 text-micro text-gray3">本月实际收货金额与单数</p></div>
        <table className="w-full text-left text-caption">
          <thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">门店</th><th className="px-4 py-3 text-right">收货单</th><th className="px-4 py-3 text-right">金额</th></tr></thead>
          <tbody className="divide-y divide-border">
            {(stats?.storeBreakdown || []).map(row => <tr key={row.storeId}><td className="px-4 py-3"><b>{row.storeName}</b><span className="ml-2 text-micro text-gray3">{row.storeNo}</span></td><td className="px-4 py-3 text-right font-num">{row.orderCount}</td><td className="px-4 py-3 text-right font-num">{money(row.totalAmount)}</td></tr>)}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-card border border-border bg-white p-4"><div className="text-caption text-gray3">{label}</div><div className="mt-1 font-num text-h1">{value}</div></div>
}

function SmallMetric({ label, value, tone = 'ink' }: { label: string; value: number; tone?: 'ink' | 'red' | 'orange' }) {
  return <div className="rounded-cta bg-bg p-3 text-center"><div className={`font-num text-h1 ${tone === 'red' ? 'text-red-fg' : tone === 'orange' ? 'text-orange-fg' : ''}`}>{value}</div><div className="text-micro text-gray3">{label}</div></div>
}

function TrendCard({ title, subtitle, rows, max }: { title: string; subtitle: string; rows: Array<{ label: string; amount: number }>; max: number }) {
  return <div className="rounded-card border border-border bg-white p-5"><h2 className="text-h2">{title}</h2><p className="mt-1 text-micro text-gray3">{subtitle}</p><div className="mt-6 flex h-52 items-end gap-3 border-b border-border px-2">{rows.map(row => <div key={row.label} className="flex h-full min-w-0 flex-1 flex-col justify-end text-center"><span className="mb-1 truncate font-num text-micro text-gray2">{money(row.amount)}</span><div className="mx-auto w-full max-w-16 rounded-t bg-amber" style={{ height: `${Math.max(4, row.amount / max * 160)}px` }} /><span className="mt-2 font-num text-micro text-gray3">{row.label}</span></div>)}{rows.length === 0 && <div className="m-auto text-caption text-gray3">暂无数据</div>}</div></div>
}

function SkuTable({ title, rows, empty }: { title: string; rows: SkuRank['top']; empty: string }) {
  return <div className="overflow-hidden rounded-card border border-border bg-white"><div className="border-b border-border px-5 py-4"><h2 className="text-h2">{title}</h2></div><table className="w-full text-left text-caption"><thead className="bg-bg text-gray3"><tr><th className="px-4 py-3">商品</th><th className="px-4 py-3 text-right">数量</th><th className="px-4 py-3 text-right">应付金额</th></tr></thead><tbody className="divide-y divide-border">{rows.map(row => <tr key={row.productId}><td className="px-4 py-3"><b>{row.name}</b></td><td className="px-4 py-3 text-right font-num">{row.qty} {row.unit}</td><td className="px-4 py-3 text-right font-num">{money(row.amount)}</td></tr>)}</tbody></table>{rows.length === 0 && <div className="py-12 text-center text-caption text-gray3">{empty}</div>}</div>
}
