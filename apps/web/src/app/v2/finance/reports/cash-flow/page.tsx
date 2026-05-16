/**
 * 财务 · 现金流瀑布
 * 经营 / 投资 / 筹资 三大活动
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Section = {
  inflow: number; outflow: number; net: number
  detail: Record<string, number>
}
type CashFlow = {
  month: string
  operating: Section
  investment: Section
  financing: Section
  totalNet: number
}

const DETAIL_LABEL: Record<string, string> = {
  revenue: '营业额',
  supplierPayment: '付款给供应商',
  sellingExp: '销售费用 (工资/租金/水电/营销)',
  mgmtExp: '管理费用',
  capitalExpense: '建店投入',
}

function fmt(n: number, d = 0) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export default function CashFlowPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [data, setData] = useState<CashFlow | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<CashFlow>(`/api/finance/reports/cash-flow?month=${month}`)
      .then(setData).catch(e => setError(String(e?.message || e)))
  }, [month])

  if (error) return <ErrorScreen message={error} />

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">现金流</h1>
        <p className="text-caption text-gray3">经营 · 投资 · 筹资 三大活动</p>
      </header>

      <div className="px-4 mt-3">
        <input
          type="month" value={month} onChange={e => setMonth(e.target.value)}
          className="bg-white border border-border rounded-cta px-3 py-1.5 text-body"
        />
      </div>

      {!data && <p className="text-caption text-gray3 text-center mt-12">加载中…</p>}

      {data && (
        <>
          {/* Hero · 净流 */}
          <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-4 text-center">
            <div className="text-caption text-gray3">本月现金净流</div>
            <div className={`text-[36px] font-num leading-tight ${data.totalNet >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
              {data.totalNet >= 0 ? '+' : '−'}¥{fmt(Math.abs(data.totalNet), 0)}
            </div>
            <p className="text-micro text-gray3 mt-1">
              {data.totalNet >= 0 ? '现金净流入 · 健康' : '现金净流出 · 注意'}
            </p>
          </div>

          {/* 经营活动 */}
          <SectionCard title="经营活动" section={data.operating} tone="green" />
          {/* 投资活动 */}
          <SectionCard title="投资活动" section={data.investment} tone="amber" />
          {/* 筹资活动 */}
          <SectionCard title="筹资活动" section={data.financing} tone="blue" />

          {/* 瀑布累加图 */}
          <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
            <div className="text-h2 mb-2">瀑布</div>
            <WaterfallBar data={data} />
          </div>
        </>
      )}
    </div>
  )
}

function SectionCard({ title, section, tone }: {
  title: string; section: Section; tone: 'green' | 'amber' | 'blue'
}) {
  const hasDetail = section.inflow > 0 || section.outflow > 0
  return (
    <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
      <div className="flex justify-between items-center mb-2">
        <div className="text-h2">{title}</div>
        <Chip tone={tone}>
          净额 {section.net >= 0 ? '+' : '−'}¥{fmt(Math.abs(section.net), 0)}
        </Chip>
      </div>
      {!hasDetail && <p className="text-micro text-gray3 py-2">本月无现金流</p>}
      {hasDetail && (
        <>
          {Object.entries(section.detail).filter(([, v]) => v > 0).map(([k, v]) => {
            const isInflow = k === 'revenue'
            return (
              <div key={k} className="flex justify-between py-1.5 border-b border-border last:border-b-0 text-caption">
                <span className="text-gray2">{DETAIL_LABEL[k] || k}</span>
                <span className={`font-num ${isInflow ? 'text-green-fg' : 'text-red-fg'}`}>
                  {isInflow ? '+' : '−'}¥{fmt(v, 2)}
                </span>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

/** 简化瀑布:起点 0 → 经营 → 投资 → 筹资 → 终点 */
function WaterfallBar({ data }: { data: CashFlow }) {
  const stops = [
    { label: '起', value: 0, cum: 0 },
    { label: '经营', value: data.operating.net, cum: data.operating.net },
    { label: '投资', value: data.investment.net, cum: data.operating.net + data.investment.net },
    { label: '筹资', value: data.financing.net, cum: data.operating.net + data.investment.net + data.financing.net },
  ]
  const allValues = stops.map(s => Math.abs(s.cum))
  const max = Math.max(1, ...allValues, Math.abs(data.totalNet))
  return (
    <div className="space-y-1.5">
      {stops.slice(1).map(s => (
        <div key={s.label}>
          <div className="flex justify-between text-caption">
            <span className="text-gray2">{s.label}</span>
            <span className={`font-num ${s.value >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
              {s.value >= 0 ? '+' : '−'}¥{fmt(Math.abs(s.value), 0)}
            </span>
          </div>
          <div className="h-2 bg-gray5 rounded-full mt-1 overflow-hidden">
            <div
              className={`h-full ${s.cum >= 0 ? 'bg-green' : 'bg-red'} rounded-full`}
              style={{ width: `${Math.abs(s.cum) / max * 100}%` }}
            />
          </div>
        </div>
      ))}
      <div className="mt-3 pt-3 border-t border-border flex justify-between">
        <span className="text-h2">期末</span>
        <span className={`font-num text-h2 ${data.totalNet >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
          {data.totalNet >= 0 ? '+' : '−'}¥{fmt(Math.abs(data.totalNet), 0)}
        </span>
      </div>
    </div>
  )
}
