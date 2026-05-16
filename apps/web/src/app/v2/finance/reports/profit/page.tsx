/**
 * 财务 · 利润中心
 * 一屏看完: 店利润月报 + 损益结构占比 + 渠道分布
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Cost = {
  food: number; loss: number; sellingExp: number; mgmtExp: number; financeExp: number
  payroll: number; rent: number; utility: number; marketing: number; other: number
}
type Profit = {
  month: string
  summary: {
    revenue: number; revenueYoy: number | null; revenueMom: number | null
    cost: Cost
    netProfit: number; netMargin: number; foodCostRatio: number
  } | null
  byChannel: Record<string, number>
  stores: Array<{
    storeId: string; storeName: string
    revenue: number; foodCost: number; grossProfit: number; grossMargin: number
  }>
}

const CHANNEL_LABEL: Record<string, string> = {
  cash: '现金', wechat: '微信', alipay: '支付宝',
  meituan: '美团', douyin: '抖音', bank: '银行', unknown: '未分类',
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
function pct(n: number | null): string {
  if (n == null) return '—'
  return (n * 100).toFixed(1) + '%'
}

export default function FinanceProfitPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [data, setData] = useState<Profit | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setError(null); setData(null)
    try {
      const d = await apiFetch<Profit>(`/api/finance/reports/profit?month=${month}`)
      setData(d)
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }
  useEffect(() => { reload() }, [month])

  if (error) return <ErrorScreen message={error} />

  const s = data?.summary
  const channelTotal = Object.values(data?.byChannel || {}).reduce((a, b) => a + b, 0)

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">利润中心</h1>
        <p className="text-caption text-gray3">店利润 / 损益占比 / 渠道分布</p>
      </header>

      <div className="px-4 mt-3">
        <input
          type="month"
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="bg-white border border-border rounded-cta px-3 py-1.5 text-body"
        />
      </div>

      {data === null && <p className="text-caption text-gray3 text-center mt-12">加载中…</p>}

      {data && s && (
        <>
          {/* Hero · 营收 + 净利 */}
          <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-4">
            <div className="text-caption text-gray3">本月营业额 (GMV)</div>
            <div className="text-[28px] font-num leading-tight">¥{fmt(s.revenue, 0)}</div>
            <div className="flex items-center gap-3 mt-1 text-micro">
              <span className="text-gray3">同比 <b className={s.revenueYoy && s.revenueYoy > 0 ? 'text-green-fg' : 'text-red-fg'}>{pct(s.revenueYoy)}</b></span>
              <span className="text-gray3">环比 <b className={s.revenueMom && s.revenueMom > 0 ? 'text-green-fg' : 'text-red-fg'}>{pct(s.revenueMom)}</b></span>
            </div>
            <div className="mt-3 pt-3 border-t border-border grid grid-cols-2">
              <div>
                <div className="text-caption text-gray3">净利</div>
                <div className={`text-h1 font-num ${s.netProfit >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>¥{fmt(s.netProfit, 0)}</div>
              </div>
              <div className="text-right">
                <div className="text-caption text-gray3">净利率</div>
                <div className={`text-h1 font-num ${s.netMargin >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{(s.netMargin * 100).toFixed(1)}%</div>
              </div>
            </div>
          </div>

          {/* 损益结构占比 */}
          <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
            <div className="text-h2 mb-2">损益结构</div>
            <CostRow label="食材成本" amount={s.cost.food} revenue={s.revenue} tone="amber" />
            <CostRow label="损耗(已同意报损)" amount={s.cost.loss} revenue={s.revenue} tone="red" />
            <CostRow label="销售费用" amount={s.cost.sellingExp} revenue={s.revenue} sub={{
              '工资': s.cost.payroll,
              '门店租金': s.cost.rent,
              '水电费': s.cost.utility,
              '营销': s.cost.marketing,
              '其他': s.cost.other,
            }} />
            <CostRow label="管理费用" amount={s.cost.mgmtExp} revenue={s.revenue} />
            <CostRow label="财务费用" amount={s.cost.financeExp} revenue={s.revenue} />
            <div className="mt-2 pt-2 border-t border-border flex justify-between text-h2">
              <span>净利</span>
              <span className={`font-num ${s.netProfit >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                ¥{fmt(s.netProfit, 2)} ({(s.netMargin * 100).toFixed(1)}%)
              </span>
            </div>
          </div>

          {/* 渠道分布 */}
          <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
            <div className="text-h2 mb-2">收款渠道分布</div>
            {channelTotal === 0 && <p className="text-caption text-gray3 py-4 text-center">本月暂无营业额录入</p>}
            {channelTotal > 0 && Object.entries(data.byChannel)
              .filter(([, v]) => v > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([ch, v]) => (
                <div key={ch} className="mb-2">
                  <div className="flex justify-between text-caption">
                    <span>{CHANNEL_LABEL[ch] || ch}</span>
                    <span className="font-num">¥{fmt(v, 0)} <span className="text-gray3">({(v / channelTotal * 100).toFixed(1)}%)</span></span>
                  </div>
                  <div className="h-1.5 bg-gray5 rounded-full mt-1 overflow-hidden">
                    <div className="h-full bg-amber rounded-full" style={{ width: `${v / channelTotal * 100}%` }} />
                  </div>
                </div>
              ))}
          </div>

          {/* 各店明细 */}
          {data.stores.length > 1 && (
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <div className="text-h2 mb-2">各店明细</div>
              {data.stores.map(s => (
                <div key={s.storeId} className="py-2 border-b border-border last:border-b-0">
                  <div className="flex justify-between text-body">
                    <span>{s.storeName}</span>
                    <span className="font-num">¥{fmt(s.revenue, 0)}</span>
                  </div>
                  <div className="flex justify-between text-micro text-gray3 mt-1">
                    <span>食材 ¥{fmt(s.foodCost, 0)} ({s.revenue > 0 ? (s.foodCost / s.revenue * 100).toFixed(1) : '—'}%)</span>
                    <span>毛利 ¥{fmt(s.grossProfit, 0)} ({(s.grossMargin * 100).toFixed(1)}%)</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function CostRow({ label, amount, revenue, sub, tone }: {
  label: string; amount: number; revenue: number
  sub?: Record<string, number>; tone?: 'amber' | 'red'
}) {
  const pct = revenue > 0 ? (amount / revenue * 100) : 0
  return (
    <div className="py-1.5 border-b border-border last:border-b-0">
      <div className="flex justify-between text-caption">
        <span className={tone === 'red' ? 'text-red-fg' : tone === 'amber' ? 'text-amber-fg' : 'text-gray2'}>{label}</span>
        <span className="font-num">¥{fmt(amount, 2)} <span className="text-gray3 text-micro">({pct.toFixed(1)}%)</span></span>
      </div>
      {sub && (
        <div className="ml-3 mt-1 text-micro text-gray3 space-y-0.5">
          {Object.entries(sub).filter(([, v]) => v > 0).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span>· {k}</span>
              <span className="font-num">¥{fmt(v, 2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
