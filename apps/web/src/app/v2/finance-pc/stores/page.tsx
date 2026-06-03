/**
 * 财务 PC Web · 各店 Tab (单店业务下: 本店财务概况)
 * 2026-06-02 Phase 2 改造: 接真 API
 *
 * 数据源: /api/finance/reports/profit?month=YYYY-MM
 *   summary: revenue / netProfit / netMargin / foodCostRatio / cost{food/loss/payroll/rent/utility/marketing/...}
 *   byChannel: { cash/wechat/alipay/meituan/douyin/bank/unknown }
 *   stores: [{ storeId, storeName, revenue, foodCost, grossProfit, grossMargin }]
 *
 * 适配单店:
 *   Hero "集团本月净利" → "本月净利"
 *   异常/关注大卡 (1 个) → 单店 5 指标卡片
 *   6 家店表格 → "成本结构" 表格 (替代, 维度更有意义)
 */
'use client'
import { useEffect, useMemo, useState } from 'react'
import { Chip, StoreAvatar, BlackHero, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'
import FinanceTopNav from '../_topnav'

type Profit = {
  month: string
  summary: {
    revenue: number
    revenueYoy: number | null
    revenueMom: number | null
    cost: {
      food: number; loss: number; sellingExp: number; mgmtExp: number; financeExp: number
      payroll: number; rent: number; utility: number; marketing: number; other: number
    }
    netProfit: number
    netMargin: number
    foodCostRatio: number
  }
  byChannel: Record<string, number>
  stores: Array<{ storeId: string; storeName: string; revenue: number; foodCost: number; grossProfit: number; grossMargin: number }>
}

const fmtKMoney = (n: number) => Math.abs(n) >= 1000 ? `¥${(n / 1000).toFixed(1)}K` : `¥${Math.round(n)}`
const fmtMoney = (n: number) => `¥${Math.round(n).toLocaleString()}`
const fmtPct = (n: number, decimals = 1) => `${(n * 100).toFixed(decimals)}%`

export default function FinancePCStoresPage() {
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [profit, setProfit] = useState<Profit | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setProfit(null)
    apiFetch<Profit>(`/api/finance/reports/profit?month=${month}`)
      .then(setProfit)
      .catch(e => setError(String(e?.message || e)))
  }, [month])

  const store = profit?.stores?.[0]   // 单店业务: 取第一个
  const s = profit?.summary

  // 成本结构表 (按金额降序)
  const costRows = useMemo(() => {
    if (!s) return []
    const rows = [
      { label: '食材成本',   value: s.cost.food,       hint: '采购入库 - 报损' },
      { label: '人工成本',   value: s.cost.payroll,    hint: '工资 / 五险一金' },
      { label: '房租',       value: s.cost.rent,       hint: '门店租金' },
      { label: '水电',       value: s.cost.utility,    hint: '水电气网' },
      { label: '营销',       value: s.cost.marketing,  hint: '广告 / 推广 / 团购扣点' },
      { label: '管理费用',   value: s.cost.mgmtExp,    hint: '办公 / 物业 / 差旅' },
      { label: '财务费用',   value: s.cost.financeExp, hint: '利息 / 手续费' },
      { label: '损耗',       value: s.cost.loss,       hint: '报损扣账' },
    ].filter(r => r.value > 0).sort((a, b) => b.value - a.value)
    const totalCost = rows.reduce((sum, r) => sum + r.value, 0)
    return rows.map(r => ({ ...r, pct: totalCost > 0 ? r.value / totalCost : 0 }))
  }, [s])

  // 渠道分布
  const channelRows = useMemo(() => {
    if (!profit?.byChannel) return []
    const total = Object.values(profit.byChannel).reduce((s, v) => s + Number(v || 0), 0)
    if (total === 0) return []
    const labels: Record<string, string> = {
      cash: '现金', wechat: '微信', alipay: '支付宝', meituan: '美团',
      douyin: '抖音', bank: '银行', unknown: '未分类',
    }
    return Object.entries(profit.byChannel)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => ({ key: k, label: labels[k] || k, value: Number(v), pct: Number(v) / total }))
      .sort((a, b) => b.value - a.value)
  }, [profit])

  // 净利异常判定: 净利率 < 5% 关注, < 0% 异常
  const status: 'normal' | 'watch' | 'anomaly' =
    !s ? 'normal'
    : s.netMargin < 0 ? 'anomaly'
    : s.netMargin < 0.05 ? 'watch'
    : 'normal'
  const statusLabel = status === 'anomaly' ? '异常' : status === 'watch' ? '关注' : '正常'
  const statusTone: 'red' | 'orange' | 'green' = status === 'anomaly' ? 'red' : status === 'watch' ? 'orange' : 'green'

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">各店</h1>
            <p className="text-caption text-gray3">
              {profit ? `${profit.stores.length} 家店 · ${month}` : '加载中…'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <MonthPicker value={month} onChange={v => setMonth(v || dayjs().format('YYYY-MM'))} />
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出</button>
          </div>
        </div>

        {error && (
          <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>
        )}

        <BlackHero
          density="desktop"
          label="本月净利"
          value={s ? fmtMoney(s.netProfit) : '—'}
          delta={s ? {
            text: `净利率 ${fmtPct(s.netMargin)}` +
                  (s.revenueMom != null ? ` · 环比 ${s.revenueMom >= 0 ? '+' : ''}${fmtPct(s.revenueMom)}` : ''),
            trend: s.netMargin >= 0.05 ? 'up' : s.netMargin >= 0 ? 'flat' : 'down',
          } : undefined}
          meta={s ? `营收 ${fmtMoney(s.revenue)} · 食材占比 ${fmtPct(s.foodCostRatio)}` : ''}
          stats={s ? [
            { label: '食材成本', value: fmtKMoney(s.cost.food),    tone: s.foodCostRatio > 0.5 ? 'orange' : 'default' as any },
            { label: '人工',     value: fmtKMoney(s.cost.payroll), tone: 'default' as any },
            { label: '净利率',   value: fmtPct(s.netMargin),
              tone: s.netMargin >= 0.08 ? 'green' : s.netMargin >= 0 ? 'orange' : 'red' },
          ] : []}
        />

        {/* 本店大卡 (单店简化 — 不分异常/关注/正常三栏) */}
        {store && s && (
          <section className={`mt-4 rounded-card border p-4 ${status === 'anomaly' ? 'bg-red-bg border-red/30' : status === 'watch' ? 'bg-orange-bg border-orange/30' : 'bg-white border-border'}`}>
            <div className="flex items-center gap-3 mb-3">
              <StoreAvatar name={store.storeName} anomaly={status === 'anomaly'} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-h2">{store.storeName}</span>
                  <Chip tone={statusTone}>{statusLabel}</Chip>
                </div>
                <p className={`text-caption mt-0.5 ${status === 'anomaly' ? 'text-red-fg' : status === 'watch' ? 'text-orange-fg' : 'text-gray2'}`}>
                  {status === 'anomaly' ? '净利为负, 需立即排查成本结构' :
                   status === 'watch' ? '净利率偏低, 关注食材/人工占比' :
                   '财务健康, 各项指标在合理区间'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-5 gap-2 text-center">
              <Metric label="营收"        value={fmtMoney(s.revenue)} />
              <Metric label="食材成本"    value={fmtMoney(s.cost.food)} />
              <Metric label="食材占比"    value={fmtPct(s.foodCostRatio)} warn={s.foodCostRatio > 0.5} />
              <Metric label="净利"        value={fmtMoney(s.netProfit)} warn={s.netProfit < 0} />
              <Metric label="净利率"      value={fmtPct(s.netMargin)} warn={s.netMargin < 0.05} />
            </div>
          </section>
        )}

        {/* 成本结构 + 渠道分布 并排 */}
        <div className="grid grid-cols-2 gap-4 mt-4">
          {/* 成本结构 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">成本结构</h2>
              <span className="text-caption text-gray3">
                {s ? `合计 ${fmtKMoney(costRows.reduce((sum, r) => sum + r.value, 0))}` : ''}
              </span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">项目</th>
                  <th className="px-3 py-2 font-normal text-right">金额</th>
                  <th className="px-3 py-2 font-normal w-[120px]">占比</th>
                </tr>
              </thead>
              <tbody>
                {profit === null && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
                )}
                {profit !== null && costRows.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-caption text-gray3">本月暂无成本数据</td></tr>
                )}
                {costRows.map(r => (
                  <tr key={r.label} className="border-t border-border">
                    <td className="px-3 py-2.5">
                      <div className="text-body">{r.label}</div>
                      <div className="text-micro text-gray3">{r.hint}</div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(r.value)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 bg-bg rounded-full overflow-hidden flex-1">
                          <div className="h-full bg-gray2" style={{ width: `${r.pct * 100}%` }} />
                        </div>
                        <span className="text-micro font-num text-gray3 w-10 text-right">{fmtPct(r.pct, 0)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 营收渠道分布 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">营收渠道</h2>
              <span className="text-caption text-gray3">
                {s ? fmtMoney(s.revenue) : ''}
              </span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">渠道</th>
                  <th className="px-3 py-2 font-normal text-right">金额</th>
                  <th className="px-3 py-2 font-normal w-[120px]">占比</th>
                </tr>
              </thead>
              <tbody>
                {profit === null && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>
                )}
                {profit !== null && channelRows.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-caption text-gray3">本月暂无营收数据</td></tr>
                )}
                {channelRows.map(c => (
                  <tr key={c.key} className="border-t border-border">
                    <td className="px-3 py-2.5 text-body">{c.label}</td>
                    <td className="px-3 py-2.5 font-num text-right">{fmtMoney(c.value)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 bg-bg rounded-full overflow-hidden flex-1">
                          <div className="h-full bg-gray2" style={{ width: `${c.pct * 100}%` }} />
                        </div>
                        <span className="text-micro font-num text-gray3 w-10 text-right">{fmtPct(c.pct, 0)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </main>
    </div>
  )
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num text-button mt-0.5 ${warn ? 'text-red-fg' : ''}`}>{value}</div>
    </div>
  )
}
