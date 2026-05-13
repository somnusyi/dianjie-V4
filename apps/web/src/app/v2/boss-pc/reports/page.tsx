/**
 * 老板 PC Web · 报表  PDF: boss_web_reports
 * PDF 导出 + bar chart + stacked bar + 类目 list with bar
 */
'use client'
import { useState } from 'react'
import { StackedBar, PeriodPills } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import BossTopNav from '../_topnav'

const MONTHS = [
  { m: '11月', rev: 1650 }, { m: '12月', rev: 1820 },
  { m: '01月', rev: 1920 }, { m: '02月', rev: 1750 },
  { m: '03月', rev: 1920 }, { m: '04月', rev: 2055, current: true },
]
const CATEGORIES = [
  { name: '锅底',  rev: 575, pct: 28 },
  { name: '肉类',  rev: 494, pct: 24 },
  { name: '海鲜',  rev: 369, pct: 18 },
  { name: '蔬菜',  rev: 287, pct: 14 },
  { name: '饮品',  rev: 226, pct: 11 },
  { name: '小吃',  rev: 104, pct:  5 },
]
const MAX = Math.max(...MONTHS.map(m => m.rev))

export default function BossWebReportsPage() {
  const [period, setPeriod] = useState('month')
  return (
    <div className="min-h-screen bg-bg">
      <BossTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">报表</h1>
            <p className="text-caption text-gray3">集团 · 04 月经营报告</p>
          </div>
          <div className="flex items-center gap-3">
            <PeriodPills value={period} onChange={setPeriod}
              options={[
                { label: '日报', value: 'day' },
                { label: '周报', value: 'week' },
                { label: '月报', value: 'month' },
                { label: '季报', value: 'quarter' },
              ]}
            />
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">⚙ 自定义</button>
            <button className="px-4 py-2 bg-ink text-white rounded-cta text-button">📄 导出 PDF</button>
          </div>
        </div>

        <GlanceStrip
          label="04 月集团营收"
          value="¥2,055K"
          delta={{ text: '↑ 7% 较 03 月', trend: 'up' }}
          meta="日均 ¥68.5K · 客流 15.8K 人 · 客单价 ¥130 · 8 家店"
          stats={[
            { label: '最佳门店', value: '国贸 ¥320K', tone: 'green' },
            { label: '最差门店', value: '朝外 ¥185K', tone: 'default' },
            { label: '异常门店', value: '朝阳 1 家',   tone: 'red' },
          ]}
        />

        <div className="grid grid-cols-[2.2fr_1fr] gap-4 mt-4">
          <section className="bg-white rounded-card border border-border p-4">
            <header className="flex items-center justify-between mb-3">
              <h2 className="text-h2">月度营收(近 6 月)</h2>
              <span className="text-caption text-gray3">单位 K</span>
            </header>
            <div className="flex items-end justify-between gap-3 h-48">
              {MONTHS.map(m => (
                <div key={m.m} className="flex-1 flex flex-col items-center gap-2">
                  <span className="text-caption font-num">{m.rev}</span>
                  <div className={`w-full rounded-t ${m.current ? 'bg-ink' : 'bg-gray4'}`} style={{ height: `${(m.rev / MAX) * 100}%` }} />
                  <span className="text-micro text-gray3">{m.m}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border">
              <h2 className="text-h2">营收类目分布</h2>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">类目</th>
                  <th className="px-3 py-2 font-normal text-right">营收</th>
                  <th className="px-3 py-2 font-normal w-[100px]">占比 bar</th>
                  <th className="px-3 py-2 font-normal text-right w-12">百分比</th>
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.map(c => (
                  <tr key={c.name} className="border-t border-border">
                    <td className="px-3 py-2.5 text-body">{c.name}</td>
                    <td className="px-3 py-2.5 font-num text-right">¥{c.rev}K</td>
                    <td className="px-3 py-2.5">
                      <div className="h-1.5 bg-bg rounded-full overflow-hidden">
                        <div className="h-full bg-gray2" style={{ width: `${c.pct}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right text-gray3">{c.pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <section className="mt-4 bg-white rounded-card border border-border p-4">
          <header className="flex items-center justify-between mb-3">
            <h2 className="text-h2">集团成本结构(本月)</h2>
            <span className="text-caption text-gray3">vs 03 月</span>
          </header>
          <StackedBar
            segments={[
              { label: '食材', pct: 28, deltaPp: -1 },
              { label: '人工', pct: 24, deltaPp: 1 },
              { label: '租金', pct: 18, deltaPp: 0 },
              { label: '其他', pct: 14, deltaPp: 1 },
              { label: '水电营销', pct: 8, deltaPp: 0 },
            ]}
            showProfit={{ label: '净利', pct: 7.7, deltaPp: 0.3 }}
          />
        </section>
      </main>
    </div>
  )
}
