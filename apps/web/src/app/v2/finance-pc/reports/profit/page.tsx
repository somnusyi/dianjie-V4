/**
 * 财务 PC Web · 利润中心 (月度 P&L)
 *
 * Phase 3 P1
 * 接 /api/finance/reports/profit?month=YYYY-MM
 *
 * PC UX:
 *   - Hero 4 卡: 营业额 / 净利 / 净利率 / 食材占比
 *   - 月份选择 + 上一月 / 下一月 / 跳今月
 *   - 双栏: 左 损益结构 (借助 bar 显占比) / 右 渠道分布 + 各店明细
 *   - 同环比 trend 直接展示在 Hero 右上
 *   - 单店时各店列表只 1 行 (兜底, 未来多店自动展开)
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { apiFetch } from '@/lib/v2-auth'
import { MonthPicker } from '@/components/v2'
import { exportXlsx } from '@/lib/exportXlsx'
import FinanceTopNav from '../../_topnav'

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
const CHANNEL_COLOR: Record<string, string> = {
  cash: 'bg-amber', wechat: 'bg-green-fg', alipay: 'bg-[#1677FF]',
  meituan: 'bg-[#FFB200]', douyin: 'bg-ink', bank: 'bg-gray2', unknown: 'bg-gray3',
}

const fmtMoney = (n: number, d = 0) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const fmtPct = (n: number | null) => n == null ? '—' : (n * 100).toFixed(1) + '%'

export default function FinancePCProfitPage() {
  const [month, setMonth] = useState(() => {
    if (typeof window === 'undefined') return dayjs().format('YYYY-MM')
    const sp = new URLSearchParams(window.location.search)
    return sp.get('month') || dayjs().format('YYYY-MM')
  })
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

  const shift = (delta: number) => setMonth(dayjs(month + '-01').add(delta, 'month').format('YYYY-MM'))
  const isThisMonth = month === dayjs().format('YYYY-MM')

  async function exportProfitXlsx() {
    if (!data?.summary) return
    const s = data.summary
    const c = s.cost
    const summaryRows = [
      [`利润中心 (管理口径) · ${month}`, '', '', ''],
      [],
      ['项目', '本月', '同比', '环比'],
      ['营业收入', Number(s.revenue.toFixed(2)), s.revenueYoy != null ? (s.revenueYoy * 100).toFixed(1) + '%' : '—', s.revenueMom != null ? (s.revenueMom * 100).toFixed(1) + '%' : '—'],
      ['食材成本', Number(c.food.toFixed(2)), '', ''],
      ['报损', Number(c.loss.toFixed(2)), '', ''],
      ['人工 (工资)', Number(c.payroll.toFixed(2)), '', ''],
      ['房租', Number(c.rent.toFixed(2)), '', ''],
      ['水电', Number(c.utility.toFixed(2)), '', ''],
      ['营销', Number(c.marketing.toFixed(2)), '', ''],
      ['销售费用', Number(c.sellingExp.toFixed(2)), '', ''],
      ['管理费用', Number(c.mgmtExp.toFixed(2)), '', ''],
      ['财务费用', Number(c.financeExp.toFixed(2)), '', ''],
      ['其他成本', Number(c.other.toFixed(2)), '', ''],
      ['净利润', Number(s.netProfit.toFixed(2)), '', ''],
      ['净利率', (s.netMargin * 100).toFixed(1) + '%', '', ''],
      ['食材占比', (s.foodCostRatio * 100).toFixed(1) + '%', '', ''],
    ]
    const channelRows = [
      ['渠道', '金额', '占比'],
      ...Object.entries(data.byChannel).map(([k, v]) => {
        const pct = s.revenue > 0 ? (Number(v) / s.revenue * 100).toFixed(1) + '%' : '—'
        const label = ({ cash: '现金', wechat: '微信', alipay: '支付宝', meituan: '美团', douyin: '抖音', bank: '银行', unknown: '未分类' } as Record<string, string>)[k] || k
        return [label, Number(Number(v).toFixed(2)), pct]
      }),
    ]
    const storeRows = [
      ['门店', '营业额', '食材成本', '毛利', '毛利率'],
      ...data.stores.map(st => [
        st.storeName,
        Number(st.revenue.toFixed(2)),
        Number(st.foodCost.toFixed(2)),
        Number(st.grossProfit.toFixed(2)),
        (st.grossMargin * 100).toFixed(1) + '%',
      ]),
    ]
    await exportXlsx(`利润中心-${month}.xlsx`, [
      { name: `汇总 ${month}`, rows: summaryRows, cols: [{ wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 10 }], merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }], moneyCols: ['B'], headerRowIdx: 2 },
      { name: '渠道分布', rows: channelRows, cols: [{ wch: 12 }, { wch: 14 }, { wch: 10 }], moneyCols: ['B'] },
      { name: '各店明细', rows: storeRows, cols: [{ wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }], moneyCols: ['B', 'C', 'D'] },
    ])
  }

  const s = data?.summary
  const channelTotal = Object.values(data?.byChannel || {}).reduce((a, b) => a + b, 0)

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">利润中心</h1>
            <p className="text-caption text-gray3">月度 P&amp;L · 损益结构 · 渠道分布</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => shift(-1)} className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2">← 上月</button>
            <MonthPicker value={month} onChange={setMonth} />
            <button onClick={() => shift(1)} disabled={isThisMonth}
                    className="px-3 py-2 bg-white border border-border rounded-cta text-button text-gray2 disabled:opacity-40">下月 →</button>
            {!isThisMonth && (
              <button onClick={() => setMonth(dayjs().format('YYYY-MM'))}
                      className="px-3 py-2 bg-ink text-white rounded-cta text-button">本月</button>
            )}
            <button onClick={exportProfitXlsx} disabled={!data?.summary}
                    className="px-3 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40">📊 导出 Excel</button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}
        {data === null && !error && <div className="text-caption text-gray3 text-center py-12">加载中…</div>}

        {data && s && (
          <>
            {/* Hero 4 卡 */}
            <div className="grid grid-cols-4 gap-3 mb-4">
              <div className="bg-bg-warm rounded-card border border-border p-4">
                <div className="text-micro text-gray3">本月营业额 (GMV)</div>
                <div className="text-h1 font-num mt-1">{fmtMoney(s.revenue)}</div>
                <div className="flex items-center gap-3 mt-2 text-micro">
                  <span className="text-gray3">同比 <b className={(s.revenueYoy ?? 0) > 0 ? 'text-green-fg' : 'text-red-fg'}>{fmtPct(s.revenueYoy)}</b></span>
                  <span className="text-gray3">环比 <b className={(s.revenueMom ?? 0) > 0 ? 'text-green-fg' : 'text-red-fg'}>{fmtPct(s.revenueMom)}</b></span>
                </div>
              </div>
              <div className="bg-white rounded-card border border-border p-4">
                <div className="text-micro text-gray3">净利</div>
                <div className={`text-h1 font-num mt-1 ${s.netProfit >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{fmtMoney(s.netProfit)}</div>
                <div className="text-micro text-gray3 mt-2">营收 − 全部成本</div>
              </div>
              <div className="bg-white rounded-card border border-border p-4">
                <div className="text-micro text-gray3">净利率</div>
                <div className={`text-h1 font-num mt-1 ${s.netMargin >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{(s.netMargin * 100).toFixed(1)}%</div>
                <div className="text-micro text-gray3 mt-2">行业基准 ~5%</div>
              </div>
              <div className="bg-white rounded-card border border-border p-4">
                <div className="text-micro text-gray3">食材成本占比</div>
                <div className={`text-h1 font-num mt-1 ${s.foodCostRatio > 0.4 ? 'text-red-fg' : s.foodCostRatio > 0.35 ? 'text-amber-fg' : 'text-ink'}`}>{(s.foodCostRatio * 100).toFixed(1)}%</div>
                <div className="text-micro text-gray3 mt-2">餐饮标杆 ≤35%</div>
              </div>
            </div>

            <div className="grid grid-cols-[2fr_1fr] gap-4">
              {/* 左: 损益结构 */}
              <section className="bg-white rounded-card border border-border p-4">
                <h2 className="text-h2 mb-3">损益结构</h2>
                <CostRow label="食材成本" amount={s.cost.food} revenue={s.revenue} tone="amber" />
                <CostRow label="损耗 (已同意报损)" amount={s.cost.loss} revenue={s.revenue} tone="red" />
                <CostRow label="销售费用" amount={s.cost.sellingExp} revenue={s.revenue} sub={{
                  '工资': s.cost.payroll,
                  '门店租金': s.cost.rent,
                  '水电费': s.cost.utility,
                  '营销': s.cost.marketing,
                  '其他': s.cost.other,
                }} />
                <CostRow label="管理费用" amount={s.cost.mgmtExp} revenue={s.revenue} />
                <CostRow label="财务费用" amount={s.cost.financeExp} revenue={s.revenue} />
                <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                  <span className="text-h2">净利</span>
                  <span className={`font-num text-h1 ${s.netProfit >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>
                    {fmtMoney(s.netProfit, 2)} <span className="text-caption">({(s.netMargin * 100).toFixed(1)}%)</span>
                  </span>
                </div>
              </section>

              {/* 右: 渠道分布 + 各店明细 */}
              <div className="space-y-4">
                <section className="bg-white rounded-card border border-border p-4">
                  <h2 className="text-h2 mb-3">收款渠道分布</h2>
                  {channelTotal === 0 && <p className="text-caption text-gray3 py-4 text-center">本月暂无营业额录入</p>}
                  {channelTotal > 0 && Object.entries(data.byChannel)
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([ch, v]) => (
                      <div key={ch} className="mb-2">
                        <div className="flex justify-between text-caption">
                          <span>{CHANNEL_LABEL[ch] || ch}</span>
                          <span className="font-num">{fmtMoney(v)} <span className="text-gray3 text-micro">({(v / channelTotal * 100).toFixed(1)}%)</span></span>
                        </div>
                        <div className="h-1.5 bg-bg rounded-full mt-1 overflow-hidden">
                          <div className={`h-full ${CHANNEL_COLOR[ch] || 'bg-gray3'} rounded-full`} style={{ width: `${v / channelTotal * 100}%` }} />
                        </div>
                      </div>
                    ))}
                </section>

                <section className="bg-white rounded-card border border-border p-4">
                  <h2 className="text-h2 mb-3">各店明细 ({data.stores.length})</h2>
                  {data.stores.length === 0 && <p className="text-caption text-gray3 py-4 text-center">无门店数据</p>}
                  {data.stores.map(st => (
                    <div key={st.storeId} className="py-2 border-b border-border last:border-b-0">
                      <div className="flex justify-between text-body">
                        <span className="truncate">{st.storeName}</span>
                        <span className="font-num">{fmtMoney(st.revenue)}</span>
                      </div>
                      <div className="flex justify-between text-micro text-gray3 mt-1">
                        <span>食材 {fmtMoney(st.foodCost)} ({st.revenue > 0 ? (st.foodCost / st.revenue * 100).toFixed(1) : '—'}%)</span>
                        <span>毛利 {fmtMoney(st.grossProfit)} ({(st.grossMargin * 100).toFixed(1)}%)</span>
                      </div>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function CostRow({ label, amount, revenue, sub, tone }: {
  label: string; amount: number; revenue: number
  sub?: Record<string, number>; tone?: 'amber' | 'red'
}) {
  const pct = revenue > 0 ? (amount / revenue * 100) : 0
  const barCls = tone === 'red' ? 'bg-red' : tone === 'amber' ? 'bg-amber' : 'bg-gray2'
  return (
    <div className="py-2 border-b border-border last:border-b-0">
      <div className="flex justify-between text-caption mb-1">
        <span className={tone === 'red' ? 'text-red-fg font-medium' : tone === 'amber' ? 'text-amber-fg font-medium' : 'text-gray2'}>{label}</span>
        <span className="font-num">{fmtMoney(amount, 2)} <span className="text-gray3 text-micro">({pct.toFixed(1)}%)</span></span>
      </div>
      <div className="h-1.5 bg-bg rounded-full overflow-hidden">
        <div className={`h-full ${barCls} rounded-full`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {sub && (
        <div className="ml-3 mt-2 text-micro text-gray3 grid grid-cols-2 gap-x-4 gap-y-0.5">
          {Object.entries(sub).filter(([, v]) => v > 0).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span>· {k}</span>
              <span className="font-num">{fmtMoney(v, 2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
