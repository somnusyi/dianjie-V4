/**
 * 财务 · 食材成本专项
 * 总览 + 各店 + 6 月趋势 + 损耗率
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip } from '@/components/v2'
import { ErrorScreen } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type FoodCost = {
  month: string
  total: { revenue: number; foodCost: number; loss: number; foodCostRatio: number; lossRatio: number }
  stores: Array<{ storeId: string; storeName: string; revenue: number; foodCost: number; loss: number; foodCostRatio: number; lossRatio: number }>
  trend: Array<{ month: string; revenue: number; foodCost: number; ratio: number; loss: number }>
  turnoverDays: number
}

function fmt(n: number, d = 0) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
}

export default function FoodCostPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [data, setData] = useState<FoodCost | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<FoodCost>(`/api/finance/reports/food-cost?month=${month}`)
      .then(setData).catch(e => setError(String(e?.message || e)))
  }, [month])

  if (error) return <ErrorScreen message={error} />

  const maxFood = Math.max(1, ...(data?.trend || []).map(t => t.foodCost))

  return (
    <div className="min-h-screen bg-bg pb-32">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-h1">食材成本</h1>
        <p className="text-caption text-gray3">采购 / 占比 / 损耗 / 趋势</p>
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
          {/* Hero */}
          <div className="mx-4 mt-3 bg-bg-warm rounded-card border border-border p-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-caption text-gray3">本月食材采购</div>
                <div className="text-h1 font-num">¥{fmt(data.total.foodCost, 0)}</div>
              </div>
              <div className="text-right">
                <div className="text-caption text-gray3">食材占比</div>
                <div className={`text-h1 font-num ${data.total.foodCostRatio > 0.4 ? 'text-red-fg' : data.total.foodCostRatio > 0.35 ? 'text-amber-fg' : 'text-green-fg'}`}>
                  {(data.total.foodCostRatio * 100).toFixed(1)}%
                </div>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-3">
              <div>
                <div className="text-caption text-gray3">本月损耗</div>
                <div className="text-h2 font-num text-red-fg">¥{fmt(data.total.loss, 0)}</div>
              </div>
              <div className="text-right">
                <div className="text-caption text-gray3">损耗率(占采购)</div>
                <div className={`text-h2 font-num ${data.total.lossRatio > 0.03 ? 'text-red-fg' : ''}`}>
                  {(data.total.lossRatio * 100).toFixed(1)}%
                </div>
              </div>
            </div>
          </div>

          {/* 6 月趋势 */}
          <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
            <div className="text-h2 mb-2">近 6 月采购趋势</div>
            <div className="space-y-2">
              {data.trend.map(t => (
                <div key={t.month}>
                  <div className="flex justify-between text-caption">
                    <span className="text-gray2">{t.month.slice(-2)} 月</span>
                    <span className="font-num">¥{fmt(t.foodCost, 0)} <span className="text-gray3">({(t.ratio * 100).toFixed(0)}%)</span></span>
                  </div>
                  <div className="h-1.5 bg-gray5 rounded-full mt-1 overflow-hidden">
                    <div className="h-full bg-amber rounded-full" style={{ width: `${t.foodCost / maxFood * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 各店明细 */}
          {data.stores.length > 1 && (
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <div className="text-h2 mb-2">各店食材成本</div>
              {data.stores.map(s => (
                <div key={s.storeId} className="py-2 border-b border-border last:border-b-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-body">{s.storeName}</span>
                    {s.foodCostRatio > 0.4 && <Chip tone="red">食材占比偏高</Chip>}
                    {s.lossRatio > 0.05 && <Chip tone="orange">损耗高</Chip>}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-micro text-gray3">
                    <div>采购 <b className="font-num text-gray2">¥{fmt(s.foodCost, 0)}</b></div>
                    <div>损耗 <b className="font-num text-red-fg">¥{fmt(s.loss, 0)}</b></div>
                    <div>占比 <b className="font-num text-gray2">{(s.foodCostRatio * 100).toFixed(1)}%</b></div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 单店 (没有横向对比时, 展示总数) */}
          {data.stores.length === 1 && (
            <div className="mx-4 mt-3 bg-white rounded-card border border-border p-3">
              <div className="text-h2 mb-2">{data.stores[0].storeName}</div>
              <div className="grid grid-cols-2 gap-3 text-caption">
                <div><span className="text-gray3">营业额</span> <span className="font-num">¥{fmt(data.stores[0].revenue, 0)}</span></div>
                <div><span className="text-gray3">采购额</span> <span className="font-num">¥{fmt(data.stores[0].foodCost, 0)}</span></div>
                <div><span className="text-gray3">损耗</span> <span className="font-num text-red-fg">¥{fmt(data.stores[0].loss, 0)}</span></div>
                <div><span className="text-gray3">食材占比</span> <span className="font-num">{(data.stores[0].foodCostRatio * 100).toFixed(1)}%</span></div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
