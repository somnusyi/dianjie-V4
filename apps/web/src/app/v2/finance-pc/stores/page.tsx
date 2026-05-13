/**
 * 财务 PC Web · 各店  PDF: finance_web_stores
 * Hero 集团本月净利 + 异常 1 关注 1 大卡 + 6 家正常店表格
 */
'use client'
import { Chip, StoreAvatar, BlackHero } from '@/components/v2'
import FinanceTopNav from '../_topnav'

const ANOMALY = {
  name: '朝阳大悦城店', label: '异常',
  sub: '成本偏高 + 备用金告警 + 报销异常',
  metrics: [
    { label: '营收',     value: '¥285K' },
    { label: '食材成本', value: '¥85.5K' },
    { label: '成本占比', value: '64%', red: true },
    { label: '异常笔数', value: '5 笔', red: true },
    { label: '备用金',   value: '⚠ ¥1.5K', red: true },
  ]
}
const WATCH = {
  name: '国贸店', label: '关注',
  sub: '本月报销 +35% 偏多 · 待复盘',
  metrics: [
    { label: '营收',     value: '¥320K' },
    { label: '食材成本', value: '¥176K' },
    { label: '成本占比', value: '55%' },
    { label: '异常笔数', value: '3 笔' },
    { label: '备用金',   value: '✓ ¥3.2K' },
  ]
}
const NORMAL = [
  { name: '望京 SOHO 店', rev: 298, cost: 57, net: 24, netRate: 8.1, anomaly: 1 },
  { name: '三里屯店',      rev: 272, cost: 56, net: 20, netRate: 7.4, anomaly: 1 },
  { name: '五道口店',      rev: 248, cost: 52, net: 22, netRate: 8.9, anomaly: 0 },
  { name: '双井店',        rev: 232, cost: 54, net: 19, netRate: 8.2, anomaly: 1 },
  { name: '中关村店',      rev: 215, cost: 53, net: 18, netRate: 8.4, anomaly: 0 },
  { name: '朝外店',        rev: 185, cost: 50, net: 14, netRate: 7.6, anomaly: 0 },
]

export default function FinancePCStoresPage() {
  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">各店</h1>
            <p className="text-caption text-gray3">8 家店 · 04 月 · 财务视角</p>
          </div>
          <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出</button>
        </div>

        <BlackHero
          density="desktop"
          label="集团本月净利"
          value="¥158K"
          delta={{ text: '↑ 0.3% 净利率', trend: 'up' }}
          meta="总营收 ¥2,055K · 集团净利率 7.7%"
          stats={[
            { label: '最佳·国贸',   value: '¥28K · 8.7%', tone: 'green' },
            { label: '最差·朝外',   value: '¥14K · 7.6%', tone: 'default' as any },
            { label: '异常店',      value: '1 家 · 朝阳', tone: 'red' },
          ]}
        />

        {/* 异常 + 关注 大卡并排 */}
        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="bg-red-bg rounded-card border border-red/30 p-4">
            <div className="flex items-center gap-3 mb-3">
              <StoreAvatar name={ANOMALY.name} anomaly />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-h2">{ANOMALY.name}</span>
                  <Chip tone="red">{ANOMALY.label}</Chip>
                </div>
                <p className="text-caption text-red-fg mt-0.5">{ANOMALY.sub}</p>
              </div>
              <button className="px-3 py-1.5 bg-ink text-white rounded-cta text-button">查看详情</button>
            </div>
            <div className="grid grid-cols-5 gap-2 text-center">
              {ANOMALY.metrics.map(m => (
                <div key={m.label}>
                  <div className="text-micro text-gray3">{m.label}</div>
                  <div className={`font-num text-button mt-0.5 ${m.red ? 'text-red-fg' : ''}`}>{m.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-orange-bg rounded-card border border-orange/30 p-4">
            <div className="flex items-center gap-3 mb-3">
              <StoreAvatar name={WATCH.name} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-h2">{WATCH.name}</span>
                  <Chip tone="orange">{WATCH.label}</Chip>
                </div>
                <p className="text-caption text-orange-fg mt-0.5">{WATCH.sub}</p>
              </div>
              <button className="px-3 py-1.5 bg-white border border-border rounded-cta text-button text-gray2">查看详情</button>
            </div>
            <div className="grid grid-cols-5 gap-2 text-center">
              {WATCH.metrics.map(m => (
                <div key={m.label}>
                  <div className="text-micro text-gray3">{m.label}</div>
                  <div className="font-num text-button mt-0.5">{m.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 6 家正常表格 */}
        <section className="mt-4 bg-white rounded-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border">
            <span className="text-h2">财务正常 · {NORMAL.length} 家店</span>
          </header>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal">门店</th>
                <th className="px-3 py-2 font-normal text-right">营收</th>
                <th className="px-3 py-2 font-normal text-right">成本%</th>
                <th className="px-3 py-2 font-normal text-right">净利</th>
                <th className="px-3 py-2 font-normal text-right">净利率</th>
                <th className="px-3 py-2 font-normal text-right">异常</th>
                <th className="px-3 py-2 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {NORMAL.map(s => (
                <tr key={s.name} className="border-t border-border hover:bg-[#FAF8F2]">
                  <td className="px-3 py-2.5 flex items-center gap-2">
                    <StoreAvatar name={s.name} size="sm" />
                    <span className="text-body">{s.name}</span>
                  </td>
                  <td className="px-3 py-2.5 font-num text-right">¥{s.rev}K</td>
                  <td className="px-3 py-2.5 font-num text-right text-gray3">{s.cost}%</td>
                  <td className="px-3 py-2.5 font-num text-right">¥{s.net}K</td>
                  <td className="px-3 py-2.5 font-num text-right">{s.netRate}%</td>
                  <td className={`px-3 py-2.5 text-right ${s.anomaly > 0 ? 'text-orange-fg' : 'text-gray3'}`}>{s.anomaly > 0 ? `${s.anomaly} 项` : '—'}</td>
                  <td className="px-3 py-2.5 text-right"><a href="#" className="text-caption text-gray2 hover:text-ink">详情 ›</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  )
}
