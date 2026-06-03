/**
 * 财务 PC · 食材成本专项
 * 接 /api/finance/reports/food-cost?month=YYYY-MM
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { exportXlsx } from '@/lib/exportXlsx'
import FinanceTopNav from '../../_topnav'

type FoodCost = {
  month: string
  total: { revenue: number; foodCost: number; loss: number; foodCostRatio: number; lossRatio: number }
  stores: Array<{ storeId: string; storeName: string; revenue: number; foodCost: number; loss: number; foodCostRatio: number; lossRatio: number }>
  trend: Array<{ month: string; revenue: number; foodCost: number; ratio: number; loss: number }>
  turnoverDays: number
}

const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })

export default function FoodCostPCPage() {
  const [month, setMonth] = useState(() => dayjs().format('YYYY-MM'))
  const [data, setData] = useState<FoodCost | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<FoodCost>(`/api/finance/reports/food-cost?month=${month}`)
      .then(setData).catch(e => setError(String(e?.message || e)))
  }, [month])

  async function doExport() {
    if (!data) return
    await exportXlsx(`食材成本-${month}.xlsx`, [{
      name: `食材成本 ${month}`,
      rows: [
        [`食材成本 · ${month}`, '', '', '', ''],
        [],
        ['项', '本月', '占比'],
        ['营业额',  Number(data.total.revenue.toFixed(2)), '—'],
        ['食材采购', Number(data.total.foodCost.toFixed(2)), `${(data.total.foodCostRatio * 100).toFixed(1)}%`],
        ['损耗',    Number(data.total.loss.toFixed(2)), `${(data.total.lossRatio * 100).toFixed(1)}%`],
        [],
        ['近 6 月趋势', '', ''],
        ['月份', '采购额', '占营业额'],
        ...data.trend.map(t => [t.month, Number(t.foodCost.toFixed(2)), `${(t.ratio * 100).toFixed(0)}%`]),
      ],
      cols: [{ wch: 16 }, { wch: 16 }, { wch: 12 }],
      merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }],
      moneyCols: ['B'],
      headerRowIdx: 2,
    }])
  }

  const maxFood = Math.max(1, ...(data?.trend || []).map(t => t.foodCost))
  const t = data?.total

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1400px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-h1">食材成本</h1>
            <p className="text-caption text-gray3">采购 / 占比 / 损耗 / 趋势</p>
          </div>
          <div className="flex items-center gap-2">
            <MonthPicker value={month} onChange={setMonth} />
            <button onClick={doExport} disabled={!data}
                    className="px-3 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40">📊 导出 Excel</button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}
        {!data && !error && <div className="text-center text-caption text-gray3 py-12">加载中…</div>}

        {data && t && (
          <>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <Stat label="本月食材采购" value={`¥${fmt(t.foodCost)}`} />
              <Stat label="食材占比" value={`${(t.foodCostRatio * 100).toFixed(1)}%`}
                    tone={t.foodCostRatio > 0.4 ? 'red' : t.foodCostRatio > 0.35 ? 'amber' : 'green'} />
              <Stat label="本月损耗" value={`¥${fmt(t.loss)}`} tone="red" />
              <Stat label="损耗率" value={`${(t.lossRatio * 100).toFixed(1)}%`}
                    tone={t.lossRatio > 0.03 ? 'red' : 'gray'} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* 6 月趋势 */}
              <section className="bg-white rounded-card border border-border p-4">
                <h2 className="text-h2 mb-3">近 6 月采购趋势</h2>
                <div className="space-y-3">
                  {data.trend.map(t => (
                    <div key={t.month}>
                      <div className="flex justify-between text-caption mb-1">
                        <span className="text-gray2 font-num">{t.month}</span>
                        <span className="font-num">¥{fmt(t.foodCost)} <span className="text-gray3">({(t.ratio * 100).toFixed(0)}%)</span></span>
                      </div>
                      <div className="h-2 bg-bg rounded-full overflow-hidden">
                        <div className="h-full bg-amber rounded-full" style={{ width: `${t.foodCost / maxFood * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* 各店明细 */}
              <section className="bg-white rounded-card border border-border overflow-hidden">
                <header className="px-4 py-3 border-b border-border">
                  <h2 className="text-h2">各店食材成本</h2>
                </header>
                <table className="w-full">
                  <thead className="bg-bg/40">
                    <tr className="text-micro text-gray3 text-left">
                      <th className="px-3 py-2 font-normal">门店</th>
                      <th className="px-3 py-2 font-normal text-right">采购</th>
                      <th className="px-3 py-2 font-normal text-right">损耗</th>
                      <th className="px-3 py-2 font-normal text-right">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stores.map(s => (
                      <tr key={s.storeId} className="border-t border-border">
                        <td className="px-3 py-2.5">
                          <div className="text-body">{s.storeName}</div>
                          <div className="flex gap-1 mt-1">
                            {s.foodCostRatio > 0.4 && <Chip tone="red">占比高</Chip>}
                            {s.lossRatio > 0.05 && <Chip tone="orange">损耗高</Chip>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-num text-right">¥{fmt(s.foodCost)}</td>
                        <td className="px-3 py-2.5 font-num text-right text-red-fg">¥{fmt(s.loss)}</td>
                        <td className="px-3 py-2.5 font-num text-right">{(s.foodCostRatio * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'amber' | 'green' | 'gray' }) {
  const cls = tone === 'red' ? 'text-red-fg' : tone === 'amber' ? 'text-amber-fg' : tone === 'green' ? 'text-green-fg' : tone === 'gray' ? 'text-gray3' : ''
  return (
    <div className="bg-white rounded-card border border-border p-3">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`text-h1 font-num mt-0.5 ${cls}`}>{value}</div>
    </div>
  )
}
