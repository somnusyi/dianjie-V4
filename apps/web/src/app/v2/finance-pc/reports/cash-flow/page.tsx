/**
 * 财务 PC Web · 现金流报表
 *
 * Phase 3 P1
 * 接 /api/finance/reports/cash-flow?month=YYYY-MM
 *
 * PC UX:
 *   - Hero 4 卡: 净流 / 经营净 / 投资净 / 筹资净
 *   - 双栏: 左 三大活动明细 / 右 瀑布累加
 *   - 月份切换 + 上一月 / 下一月 / 本月
 */
'use client'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Chip, MonthPicker } from '@/components/v2'
import { apiFetch } from '@/lib/v2-auth'
import { exportXlsx } from '@/lib/exportXlsx'
import FinanceTopNav from '../../_topnav'

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

const fmtMoney = (n: number, d = 0) => `¥${n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`
const signed = (n: number, d = 0) => `${n >= 0 ? '+' : '−'}${fmtMoney(Math.abs(n), d)}`

async function exportCashFlowXlsx(data: CashFlow | null, month: string) {
  if (!data) return
  const sectionRows = (label: string, s: Section) => {
    const out: any[][] = [[label, '', '', '']]
    Object.entries(s.detail).forEach(([k, v]) => {
      const cnLabel = DETAIL_LABEL[k] || k
      out.push(['  ' + cnLabel, Number(Number(v).toFixed(2)), '', ''])
    })
    out.push([
      '  小计',
      `流入 ${Number(s.inflow.toFixed(2))}`,
      `流出 ${Number(s.outflow.toFixed(2))}`,
      Number(s.net.toFixed(2)),
    ])
    return out
  }
  const rows: any[][] = [
    [`现金流报表 · ${month}`, '', '', ''],
    [],
    ['活动 / 项目', '流入 / 金额', '流出', '净额'],
    ...sectionRows('一、经营活动', data.operating),
    [],
    ...sectionRows('二、投资活动', data.investment),
    [],
    ...sectionRows('三、筹资活动', data.financing),
    [],
    ['本月现金净增加', '', '', Number(data.totalNet.toFixed(2))],
  ]
  await exportXlsx(`现金流报表-${month}.xlsx`, [{
    name: `现金流 ${month}`,
    rows,
    cols: [{ wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 16 }],
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }],
    moneyCols: ['B', 'D'],
    headerRowIdx: 2,
  }])
}

export default function FinancePCCashFlowPage() {
  const [month, setMonth] = useState(() => {
    if (typeof window === 'undefined') return dayjs().format('YYYY-MM')
    const sp = new URLSearchParams(window.location.search)
    return sp.get('month') || dayjs().format('YYYY-MM')
  })
  const [data, setData] = useState<CashFlow | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null); setError(null)
    apiFetch<CashFlow>(`/api/finance/reports/cash-flow?month=${month}`)
      .then(setData).catch(e => setError(String(e?.message || e)))
  }, [month])

  const shift = (delta: number) => setMonth(dayjs(month + '-01').add(delta, 'month').format('YYYY-MM'))
  const isThisMonth = month === dayjs().format('YYYY-MM')

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">现金流报表</h1>
            <p className="text-caption text-gray3">经营 · 投资 · 筹资 三大活动</p>
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
            <button onClick={() => exportCashFlowXlsx(data, month)} disabled={!data}
                    className="px-3 py-2 bg-[#1F7A4B] text-white rounded-cta text-button disabled:opacity-40">📊 导出 Excel</button>
          </div>
        </div>

        {error && <div className="bg-red-bg text-red-fg rounded-card p-3 text-caption mb-4">{error}</div>}
        {data === null && !error && <div className="text-caption text-gray3 text-center py-12">加载中…</div>}

        {data && (
          <>
            {/* Hero 4 卡 */}
            <div className="grid grid-cols-4 gap-3 mb-4">
              <div className="bg-bg-warm rounded-card border border-border p-4">
                <div className="text-micro text-gray3">本月现金净流</div>
                <div className={`text-h1 font-num mt-1 ${data.totalNet >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{signed(data.totalNet)}</div>
                <div className="text-micro text-gray3 mt-2">{data.totalNet >= 0 ? '净流入 · 健康' : '净流出 · 注意'}</div>
              </div>
              <div className="bg-white rounded-card border border-border p-4">
                <div className="text-micro text-gray3">经营活动净额</div>
                <div className={`text-h1 font-num mt-1 ${data.operating.net >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{signed(data.operating.net)}</div>
                <div className="text-micro text-gray3 mt-2">营业额 − 供货付款 − 三费</div>
              </div>
              <div className="bg-white rounded-card border border-border p-4">
                <div className="text-micro text-gray3">投资活动净额</div>
                <div className={`text-h1 font-num mt-1 ${data.investment.net >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{signed(data.investment.net)}</div>
                <div className="text-micro text-gray3 mt-2">建店投入 / 设备购置</div>
              </div>
              <div className="bg-white rounded-card border border-border p-4">
                <div className="text-micro text-gray3">筹资活动净额</div>
                <div className={`text-h1 font-num mt-1 ${data.financing.net >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{signed(data.financing.net)}</div>
                <div className="text-micro text-gray3 mt-2">借款 / 还款 / 股东</div>
              </div>
            </div>

            <div className="grid grid-cols-[2fr_1fr] gap-4">
              {/* 左: 三大活动明细 */}
              <div className="space-y-4">
                <SectionCard title="经营活动" section={data.operating} tone="green" />
                <SectionCard title="投资活动" section={data.investment} tone="amber" />
                <SectionCard title="筹资活动" section={data.financing} tone="blue" />
              </div>

              {/* 右: 瀑布 */}
              <section className="bg-white rounded-card border border-border p-4 self-start sticky top-20">
                <h2 className="text-h2 mb-3">现金流瀑布</h2>
                <WaterfallBar data={data} />
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function SectionCard({ title, section, tone }: {
  title: string; section: Section; tone: 'green' | 'amber' | 'blue'
}) {
  const hasDetail = section.inflow > 0 || section.outflow > 0
  return (
    <section className="bg-white rounded-card border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-h2">{title}</h2>
        <Chip tone={tone as any}>净额 {signed(section.net)}</Chip>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3 text-caption">
        <div className="bg-bg/40 rounded-cta p-2">
          <div className="text-gray3 text-micro">流入</div>
          <div className="font-num text-green-fg">+{fmtMoney(section.inflow, 2)}</div>
        </div>
        <div className="bg-bg/40 rounded-cta p-2">
          <div className="text-gray3 text-micro">流出</div>
          <div className="font-num text-red-fg">−{fmtMoney(section.outflow, 2)}</div>
        </div>
      </div>
      {!hasDetail && <p className="text-micro text-gray3 py-2 text-center">本月无现金流</p>}
      {hasDetail && (
        <table className="w-full">
          <tbody>
            {Object.entries(section.detail).filter(([, v]) => v > 0).map(([k, v]) => {
              const isInflow = k === 'revenue'
              return (
                <tr key={k} className="border-t border-border">
                  <td className="py-2 text-caption text-gray2">{DETAIL_LABEL[k] || k}</td>
                  <td className={`py-2 text-right font-num text-caption ${isInflow ? 'text-green-fg' : 'text-red-fg'}`}>
                    {isInflow ? '+' : '−'}{fmtMoney(v, 2)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** 累加瀑布 0 → 经营 → 投资 → 筹资 → 期末 */
function WaterfallBar({ data }: { data: CashFlow }) {
  const stops = [
    { label: '经营', value: data.operating.net, cum: data.operating.net },
    { label: '投资', value: data.investment.net, cum: data.operating.net + data.investment.net },
    { label: '筹资', value: data.financing.net, cum: data.operating.net + data.investment.net + data.financing.net },
  ]
  const max = Math.max(1, ...stops.map(s => Math.abs(s.cum)), Math.abs(data.totalNet))
  return (
    <div className="space-y-3">
      {stops.map(s => (
        <div key={s.label}>
          <div className="flex justify-between text-caption">
            <span className="text-gray2">{s.label}</span>
            <span className={`font-num ${s.value >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{signed(s.value)}</span>
          </div>
          <div className="h-2 bg-bg rounded-full mt-1 overflow-hidden">
            <div className={`h-full ${s.cum >= 0 ? 'bg-green' : 'bg-red'} rounded-full`}
                 style={{ width: `${Math.abs(s.cum) / max * 100}%` }} />
          </div>
          <div className="text-micro text-gray3 mt-0.5">累计 {signed(s.cum)}</div>
        </div>
      ))}
      <div className="mt-3 pt-3 border-t border-border flex justify-between items-center">
        <span className="text-h2">期末</span>
        <span className={`font-num text-h1 ${data.totalNet >= 0 ? 'text-green-fg' : 'text-red-fg'}`}>{signed(data.totalNet)}</span>
      </div>
    </div>
  )
}
