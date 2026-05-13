/**
 * 老板 App · 单店详情
 * 接 GET /api/profit/store/:storeId?month=YYYY-MM 真 P&L 拆解
 */
'use client'
import { useEffect, useState } from 'react'
import { Chip, BottomNav } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { FriendlyError, SkeletonCard } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

type Profit = {
  store: { id: string; name: string; no: string }
  month: string
  revenue: { total: number; net: number; platformFee: number; recordCount: number }
  cost: {
    food: number; loss: number
    labor: { total: number }
    sales: { total: number; platformFee: number }
    mgmt: { total: number }
    finance: { total: number }
    totalExpense: number; totalCost: number
  }
  grossProfit: number; grossMargin: number
  netProfit: number;   netMargin: number
}

const MONTH = new Date().toISOString().slice(0, 7)

export default function BossStoreDetailPage({ params }: { params: { id: string } }) {
  const [tab, setTab] = useState('stores')
  const [profit, setProfit] = useState<Profit | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = decodeURIComponent(params.id)

  useEffect(() => {
    apiFetch<Profit>(`/api/profit/store/${id}?month=${MONTH}`)
      .then(setProfit)
      .catch(e => setError(String(e?.message || e)))
  }, [id])

  if (error) {
    return (
      <div className="min-h-screen bg-bg p-4">
        <FriendlyError message={error} hint="后端 P&L 接口未返回数据" />
      </div>
    )
  }
  if (!profit) {
    return (
      <div className="min-h-screen bg-bg p-4 space-y-3">
        <SkeletonCard /><SkeletonCard /><SkeletonCard />
      </div>
    )
  }

  const { revenue, cost, grossProfit, netProfit, netMargin } = profit
  const pnl = [
    { item: '营业收入 (GMV)', amount: revenue.total, pct: 100, kind: 'rev' as const },
    { item: '平台抽成', amount: -revenue.platformFee, pct: revenue.total > 0 ? -(revenue.platformFee / revenue.total * 100) : 0, controllable: false, neg: true },
    { item: '食材成本', amount: -cost.food, pct: revenue.total > 0 ? -(cost.food / revenue.total * 100) : 0, controllable: true, neg: true },
    { item: '人工成本', amount: -cost.labor.total, pct: revenue.total > 0 ? -(cost.labor.total / revenue.total * 100) : 0, controllable: false, neg: true },
    { item: '销售费用', amount: -(cost.sales.total - cost.sales.platformFee), pct: revenue.total > 0 ? -((cost.sales.total - cost.sales.platformFee) / revenue.total * 100) : 0, controllable: true, neg: true },
    { item: '管理费用', amount: -cost.mgmt.total, pct: revenue.total > 0 ? -(cost.mgmt.total / revenue.total * 100) : 0, controllable: false, neg: true },
    { item: '财务费用', amount: -cost.finance.total, pct: revenue.total > 0 ? -(cost.finance.total / revenue.total * 100) : 0, controllable: false, neg: true },
    { item: '净利润', amount: netProfit, pct: netMargin, kind: 'profit' as const },
  ]

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <a href="/v2/boss/stores" className="flex items-center gap-1">
          <span className="text-gray2">‹</span>
          <div>
            <h1 className="text-h1">{profit.store.name}</h1>
            <p className="text-caption text-gray3">{profit.month} · 单店财务画像 · #{profit.store.no}</p>
          </div>
        </a>
        <a href={`/v2/profit/${profit.store.id}`} className="text-button text-amber-fg">月/季/年/累计 ›</a>
      </header>

      <div className="mt-3">
        <GlanceStrip
          label={`${profit.month} GMV`}
          value={`¥${Math.round(revenue.total).toLocaleString()}`}
          delta={revenue.platformFee > 0 ? { text: `平台抽成 −¥${Math.round(revenue.platformFee).toLocaleString()}`, trend: 'down' } : undefined}
          meta={`净到账 ¥${Math.round(revenue.net).toLocaleString()} · 录入 ${revenue.recordCount} 天`}
          stats={[
            { label: '净利润', value: `¥${Math.round(netProfit).toLocaleString()}`, tone: netProfit >= 0 ? 'green' : 'red' },
            { label: '净利率', value: `${netMargin.toFixed(1)}%`, tone: netMargin >= 5 ? 'green' : netMargin >= 0 ? 'orange' : 'red' },
            { label: '食材占比', value: revenue.total > 0 ? `${(cost.food / revenue.total * 100).toFixed(1)}%` : '—', tone: 'default' },
          ]}
        />
      </div>

      <Section title="P&L 拆解" right={profit.month}>
        <div className="bg-bg-card rounded-card border border-border overflow-hidden">
          {pnl.map((p, i) => (
            <div key={p.item} className={`flex items-center px-3 py-2.5 ${i < pnl.length - 1 ? 'border-b border-border' : ''} ${p.kind === 'profit' ? 'bg-green-bg' : ''} ${p.kind === 'rev' ? 'bg-bg-warm' : ''}`}>
              <div className="flex-1 flex items-center gap-2">
                <span className="text-h2">{p.item}</span>
                {p.controllable === true && <Chip tone="gray">可控</Chip>}
                {p.controllable === false && <Chip tone="gray">不可控</Chip>}
                {p.kind === 'profit' && <Chip tone={netProfit >= 0 ? 'green' : 'red'}>利润</Chip>}
              </div>
              <div className="text-right">
                <div className={`font-num text-h2 ${p.neg ? 'text-red-fg' : p.kind === 'profit' ? (netProfit >= 0 ? 'text-green-fg' : 'text-red-fg') : ''}`}>
                  {p.neg && p.amount !== 0 ? '−' : ''}¥{Math.abs(Math.round(p.amount)).toLocaleString()}
                </div>
                <div className="text-micro text-gray3 font-num">{p.pct.toFixed(1)}%</div>
              </div>
            </div>
          ))}
        </div>
        {revenue.total === 0 && (
          <p className="text-micro text-gray3 mt-2 text-center">本月未录营业额 · 数据为零属正常</p>
        )}
      </Section>

      {cost.loss > 0 && (
        <Section title="本月报损" right={`¥${Math.round(cost.loss).toLocaleString()}`} rightTone="orange">
          <div className="bg-amber/10 border border-amber/30 rounded-card p-3">
            <p className="text-caption text-amber-fg">已自动计入食材成本科目 · 详情进 /v2/chef-director/loss 看</p>
          </div>
        </Section>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '首页', icon: '⌂' },
          { key: 'stores', label: '门店', icon: '☷' },
          { key: 'reports', label: '报表', icon: '⛁' },
          { key: 'approval', label: '审批', icon: '✓' },
          { key: 'me', label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          setTab(k)
          if (k === 'home') location.href = '/v2/boss/home'
          if (k === 'stores') location.href = '/v2/boss/stores'
          if (k === 'approval') location.href = '/v2/boss/approvals'
          if (k === 'reports') location.href = '/v2/boss/reports'
          if (k === 'me') location.href = '/v2/me'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'orange'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : rightTone === 'orange' ? 'text-orange-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
