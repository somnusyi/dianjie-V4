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
import { Chip, BlackHero, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { exportXlsx } from '@/lib/exportXlsx'
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
  stores: Array<{
    storeId: string
    storeNo: string
    storeName: string
    lifecyclePhase: string
    revenue: number
    foodCost: number
    grossProfit: number
    grossMargin: number
  }>
}

const lifecycleLabels: Record<string, string> = {
  PLANNING: '选址筹备', NEGOTIATING: '合同谈判', CONSTRUCTION: '装修施工',
  EQUIPMENT: '设备物料', LICENSING: '证照办理', TRIAL: '试营业',
  OPERATING: '正常营业', CLOSED: '已关店',
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
            <a
              href="/v2/finance-pc/stores/new"
              className="px-4 py-2 bg-ink text-white rounded-cta text-button">
              + 新建店铺
            </a>
            <button
              onClick={async () => {
                if (!profit || !s) return
                const sheets: any[] = []
                // Sheet 1: 各店核心指标
                sheets.push({
                  name: `各店指标 ${month}`,
                  rows: [
                    [`各店财务 · ${month}`, '', '', '', '', ''],
                    [],
                    ['门店', '营业额', '食材成本', '毛利', '毛利率', '净利率'],
                    ...profit.stores.map(st => [
                      st.storeName,
                      Number(st.revenue.toFixed(2)),
                      Number(st.foodCost.toFixed(2)),
                      Number(st.grossProfit.toFixed(2)),
                      `${(st.grossMargin * 100).toFixed(1)}%`,
                      // 净利率是 group-level, 各店没有, 用 grossMargin 代显
                      `${(st.grossMargin * 100).toFixed(1)}%`,
                    ]),
                    [],
                    ['汇总', Number(s.revenue.toFixed(2)), Number(s.cost.food.toFixed(2)), Number(s.netProfit.toFixed(2)),
                      `${(s.foodCostRatio * 100).toFixed(1)}% (食材占比)`,
                      `${(s.netMargin * 100).toFixed(1)}%`],
                  ],
                  cols: [{ wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }],
                  merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }],
                  moneyCols: ['B', 'C', 'D'],
                  headerRowIdx: 2,
                })
                // Sheet 2: 成本结构
                sheets.push({
                  name: `成本结构 ${month}`,
                  rows: [
                    [`成本结构 · ${month}`, '', ''],
                    [],
                    ['项目', '金额', '占比'],
                    ...costRows.map(r => [r.label, Number(r.value.toFixed(2)), `${(r.pct * 100).toFixed(1)}%`]),
                    [],
                    ['合计', Number(costRows.reduce((sum, r) => sum + r.value, 0).toFixed(2)), '100%'],
                  ],
                  cols: [{ wch: 18 }, { wch: 14 }, { wch: 10 }],
                  merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
                  moneyCols: ['B'],
                  headerRowIdx: 2,
                })
                // Sheet 3: 渠道分布
                if (channelRows.length > 0) {
                  sheets.push({
                    name: `营收渠道 ${month}`,
                    rows: [
                      [`营收渠道分布 · ${month}`, '', ''],
                      [],
                      ['渠道', '金额', '占比'],
                      ...channelRows.map(c => [c.label, Number(c.value.toFixed(2)), `${(c.pct * 100).toFixed(1)}%`]),
                    ],
                    cols: [{ wch: 14 }, { wch: 14 }, { wch: 10 }],
                    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
                    moneyCols: ['B'],
                    headerRowIdx: 2,
                  })
                }
                await exportXlsx(`各店财务-${month}.xlsx`, sheets)
              }}
              disabled={!profit || !s}
              className="px-4 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40">
              📊 导出
            </button>
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

        <section className="mt-4 bg-white rounded-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-h2">门店清单</h2>
              <p className="text-micro text-gray3 mt-0.5">新建店铺会立即出现在此处，未产生业务数据时金额为 0</p>
            </div>
            <span className="text-caption text-gray3">{profit ? `${profit.stores.length} 家` : '—'}</span>
          </header>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal">门店</th>
                <th className="px-3 py-2 font-normal">阶段</th>
                <th className="px-3 py-2 font-normal text-right">营收</th>
                <th className="px-3 py-2 font-normal text-right">食材成本</th>
                <th className="px-3 py-2 font-normal text-right">毛利</th>
                <th className="px-3 py-2 font-normal text-right">毛利率</th>
              </tr>
            </thead>
            <tbody>
              {profit === null && <tr><td colSpan={6} className="px-4 py-6 text-center text-caption text-gray3">加载中…</td></tr>}
              {profit?.stores.map(st => {
                const tone: 'green' | 'red' | 'orange' = st.lifecyclePhase === 'OPERATING' ? 'green' : st.lifecyclePhase === 'CLOSED' ? 'red' : 'orange'
                return (
                  <tr key={st.storeId} className="border-t border-border">
                    <td className="px-3 py-3">
                      <div className="text-body">{st.storeName}</div>
                      <div className="text-micro text-gray3 font-num">{st.storeNo}</div>
                    </td>
                    <td className="px-3 py-3"><Chip tone={tone}>{lifecycleLabels[st.lifecyclePhase] || st.lifecyclePhase}</Chip></td>
                    <td className="px-3 py-3 text-right font-num">{fmtMoney(st.revenue)}</td>
                    <td className="px-3 py-3 text-right font-num">{fmtMoney(st.foodCost)}</td>
                    <td className={`px-3 py-3 text-right font-num ${st.grossProfit < 0 ? 'text-red-fg' : ''}`}>{fmtMoney(st.grossProfit)}</td>
                    <td className={`px-3 py-3 text-right font-num ${st.grossMargin < 0 ? 'text-red-fg' : ''}`}>{fmtPct(st.grossMargin)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

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
