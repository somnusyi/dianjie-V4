/**
 * 老板 PC Web · 单店详情(异常店)  PDF: boss_web_store_detail
 * 双列 2.2:1: 左 P&L 表格 + 异常事件; 右 vs 集团均值 + 历史
 */
'use client'
import { Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import BossTopNav from '../../_topnav'

const PNL = [
  { item: '营业收入', amount: 285000, pct: 100 },
  { item: '食材成本', amount: 85500,  pct: 30, controllable: true,  red: true },
  { item: '人工',     amount: 71250,  pct: 25, controllable: false },
  { item: '租金',     amount: 48450,  pct: 17, controllable: false },
  { item: '水电营销', amount: 25650,  pct: 9,  controllable: true },
  { item: '其他',     amount: 36150,  pct: 13, controllable: false },
  { item: '净利润',   amount: 17955,  pct: 6.3, isProfit: true },
]
const VS = [
  { label: '营收',       store: '¥285K', group: '¥257K', delta: '↑ 11%',   tone: 'green' as const },
  { label: '净利率',     store: '6.3%',  group: '7.7%',  delta: '↓ 1.4pp', tone: 'red' as const },
  { label: '食材成本占比', store: '30%',  group: '27%',   delta: '↑ 3pp 偏高', tone: 'red' as const },
  { label: '损耗率',     store: '2.3%',  group: '1.6%',  delta: '↑ 0.7pp', tone: 'red' as const },
  { label: '客单价',     store: '¥129',  group: '¥122',  delta: '↑ ¥7',    tone: 'green' as const },
]
const EVENTS = [
  { tone: 'red'    as const, chip: '成本异常', tag: '持续 3 周',   title: '成本占比 64% · 高于集团均 56%' },
  { tone: 'red'    as const, chip: '大额支出', tag: '04/15',        title: '冷链断链 · 报损 ¥320' },
  { tone: 'orange' as const, chip: '报损异常', tag: '月内 3 次',     title: '本月报损 +35% 偏多' },
  { tone: 'orange' as const, chip: '备用金告警', tag: '今日触发',    title: '现金备用金 ¥1,500 · 低值' },
  { tone: 'gray'   as const, chip: '高频报损 SKU', tag: '本周',     title: '鸭血损耗 8% · 超均值 5%' },
]

export default function BossWebStoreDetailPage({ params }: { params: { id: string } }) {
  const name = decodeURIComponent(params.id)
  return (
    <div className="min-h-screen bg-bg">
      <BossTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <a href="/v2/boss-pc/stores" className="text-gray2">‹ 返回门店列表</a>
            <span className="text-gray4">/</span>
            <h1 className="text-h1">{name}</h1>
            <Chip tone="red">异常</Chip>
          </div>
          <div className="flex gap-2">
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出报表</button>
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">查看历史</button>
          </div>
        </div>

        <GlanceStrip
          label={`${name} · 04 月营收 · 实时`}
          value="¥285K"
          delta={{ text: '↑ 8% 较上月 · 集团排名 第 3/8', trend: 'up' }}
          meta="净利 ¥18K · 客流 2,210 人 · 客单 ¥129"
          stats={[
            { label: 'vs 集团均值', value: '营收 ↑11%', tone: 'green' },
            { label: '净利率',     value: '6.3% (集团 7.7%)', tone: 'red' },
            { label: '本月异常',    value: '5 项',     tone: 'orange' },
          ]}
        />

        <div className="grid grid-cols-[2.2fr_1fr] gap-4 mt-4">
          {/* 左主区 异常事件 + P&L 拆解 */}
          <div className="space-y-4">
            <section className="bg-white rounded-card border border-border">
              <header className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h2 className="text-h2">本月异常事件</h2>
                <span className="text-caption text-red-fg">{EVENTS.length} 项需关注</span>
              </header>
              <ul className="divide-y divide-border">
                {EVENTS.map((e, i) => (
                  <li key={i} className={`px-4 py-3 ${e.tone === 'red' ? 'bg-red-bg/30' : e.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <Chip tone={e.tone}>{e.chip}</Chip>
                      <span className="text-micro text-gray3">{e.tag}</span>
                    </div>
                    <span className="text-h2">{e.title}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="bg-white rounded-card border border-border overflow-hidden">
              <header className="px-4 py-3 border-b border-border">
                <h2 className="text-h2">P&L 拆解</h2>
              </header>
              <table className="w-full">
                <thead className="bg-bg/40">
                  <tr className="text-micro text-gray3 text-left">
                    <th className="px-3 py-2 font-normal">项目</th>
                    <th className="px-3 py-2 font-normal text-right">金额</th>
                    <th className="px-3 py-2 font-normal text-right w-20">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {PNL.map(p => (
                    <tr key={p.item} className={`border-t border-border ${p.isProfit ? 'bg-green-bg' : ''}`}>
                      <td className="px-3 py-2.5 flex items-center gap-2">
                        <span className="text-body">{p.item}</span>
                        {p.controllable === true && <Chip tone="gray">可控</Chip>}
                        {p.controllable === false && <Chip tone="gray">不可控</Chip>}
                        {p.isProfit && <Chip tone="green">利润</Chip>}
                      </td>
                      <td className={`px-3 py-2.5 font-num text-right ${p.red ? 'text-red-fg' : p.isProfit ? 'text-green-fg' : ''}`}>¥{p.amount.toLocaleString()}</td>
                      <td className="px-3 py-2.5 font-num text-right text-gray3">{p.pct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {/* 右副区 vs 集团均值 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border">
              <h2 className="text-h2">vs 集团均值</h2>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">指标</th>
                  <th className="px-3 py-2 font-normal text-right">本店</th>
                  <th className="px-3 py-2 font-normal text-right">集团均</th>
                </tr>
              </thead>
              <tbody>
                {VS.map(v => (
                  <tr key={v.label} className="border-t border-border">
                    <td className="px-3 py-2.5">
                      <div className="text-body">{v.label}</div>
                      <div className={`text-micro font-num ${v.tone === 'red' ? 'text-red-fg' : 'text-green-fg'}`}>{v.delta}</div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">{v.store}</td>
                    <td className="px-3 py-2.5 font-num text-right text-gray3">{v.group}</td>
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
