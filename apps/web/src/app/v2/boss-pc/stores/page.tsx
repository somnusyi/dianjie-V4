/**
 * 老板 PC Web · 门店列表 PDF: boss_web_stores
 * Hero 三对比 (最佳/最差/异常) + 详细表格 7 列 + 排序 chip + 异常店整行红
 */
'use client'
import { useState } from 'react'
import { Chip, StoreAvatar, PeriodPills } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import BossTopNav from '../_topnav'

const STORES = [
  { rank: 1, name: '国贸店',         rev: 320000, growth: '↑ 12% 较上月', netRate: 8.7, net: 28000, anomaly: false, anomalies: 0 },
  { rank: 2, name: '望京 SOHO 店',  rev: 298000, growth: '↑ 8% 较上月',  netRate: 8.1, net: 24000, anomaly: false, anomalies: 0 },
  { rank: 3, name: '朝阳大悦城店',   rev: 285000, growth: '成本 64% · 报损偏高', netRate: 6.3, net: 18000, anomaly: true,  anomalies: 5 },
  { rank: 4, name: '三里屯店',       rev: 272000, growth: '↑ 5% 较上月',  netRate: 7.4, net: 20000, anomaly: false, anomalies: 0 },
  { rank: 5, name: '五道口店',       rev: 248000, growth: '净利率最高 ★', netRate: 8.9, net: 22000, anomaly: false, anomalies: 0 },
  { rank: 6, name: '双井店',         rev: 232000, growth: '↑ 3% 较上月',  netRate: 8.2, net: 19000, anomaly: false, anomalies: 0 },
  { rank: 7, name: '中关村店',       rev: 215000, growth: '↓ 0% 较上月',  netRate: 8.4, net: 18000, anomaly: false, anomalies: 0 },
  { rank: 8, name: '朝外店',         rev: 185000, growth: '新店 · 仍在爬坡', netRate: 7.6, net: 14000, anomaly: false, anomalies: 0 },
]

export default function BossWebStoresPage() {
  const [period, setPeriod] = useState('month')
  const [sortBy, setSortBy] = useState<'营收' | '净利率' | '异常' | '门店'>('营收')

  return (
    <div className="min-h-screen bg-bg">
      <BossTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">门店</h1>
            <p className="text-caption text-gray3">8 家店 · 04 月 · 集团均净利率 7.7%</p>
          </div>
          <div className="flex items-center gap-3">
            <PeriodPills
              value={period} onChange={setPeriod}
              options={[
                { label: '本周', value: 'week' },
                { label: '本月', value: 'month' },
                { label: 'YTD',  value: 'ytd' },
              ]}
            />
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出报表</button>
            <button className="px-4 py-2 bg-ink text-white rounded-cta text-button">+ 新增门店</button>
          </div>
        </div>

        <GlanceStrip
          label="集团 04 月营收 · 实时"
          value="¥2,055K"
          delta={{ text: '↑ 7% 较 03 月', trend: 'up' }}
          meta="净利 ¥158K · 净利率 7.7% · 客流 15.8K 人"
          stats={[
            { label: '最佳·国贸', value: '¥320K · 8.7%', tone: 'green' },
            { label: '最差·朝外', value: '¥185K · 7.6%', tone: 'default' },
            { label: '异常店·朝阳', value: '成本 64% / 净利 6.3%', tone: 'red' },
          ]}
        />

        <div className="mt-4 bg-white rounded-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-h2">按营收排序</h2>
            <div className="flex gap-1">
              {(['营收', '净利率', '异常', '门店'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className={`px-2.5 py-1 rounded-chip text-micro ${sortBy === s ? 'bg-ink text-white' : 'bg-bg text-gray2'}`}
                >{s} {sortBy === s ? '↓' : ''}</button>
              ))}
            </div>
          </header>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal">排名</th>
                <th className="px-3 py-2 font-normal">门店</th>
                <th className="px-3 py-2 font-normal text-right">本月营收</th>
                <th className="px-3 py-2 font-normal w-[140px]">占比</th>
                <th className="px-3 py-2 font-normal text-right">净利率</th>
                <th className="px-3 py-2 font-normal text-right">净利</th>
                <th className="px-3 py-2 font-normal text-right">异常</th>
                <th className="px-3 py-2 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {STORES.map(s => {
                const max = STORES[0].rev
                return (
                  <tr key={s.rank} className={`border-t border-border hover:bg-[#FAF8F2] ${s.anomaly ? 'bg-red-bg/40' : ''}`}>
                    <td className="px-3 py-2.5 font-num text-gray3 text-caption">{s.rank}</td>
                    <td className="px-3 py-2.5 flex items-center gap-2">
                      <StoreAvatar name={s.name} anomaly={s.anomaly} size="sm" />
                      <div>
                        <div className="text-body">{s.name} {s.anomaly && <Chip tone="red">异常</Chip>}</div>
                        <div className={`text-micro ${s.anomaly ? 'text-red-fg' : 'text-gray3'}`}>{s.growth}</div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-num text-right">¥{(s.rev / 1000).toFixed(0)}K</td>
                    <td className="px-3 py-2.5">
                      <div className="h-1.5 bg-bg rounded-full overflow-hidden">
                        <div className={`h-full ${s.anomaly ? 'bg-red' : 'bg-gray2'}`} style={{ width: `${(s.rev / max) * 100}%` }} />
                      </div>
                    </td>
                    <td className={`px-3 py-2.5 font-num text-right ${s.anomaly ? 'text-red-fg' : ''}`}>{s.netRate}%</td>
                    <td className="px-3 py-2.5 font-num text-right">¥{(s.net / 1000).toFixed(0)}K</td>
                    <td className={`px-3 py-2.5 text-right ${s.anomaly ? 'text-red-fg' : 'text-gray3'}`}>{s.anomalies > 0 ? `${s.anomalies} 项` : '—'}</td>
                    <td className="px-3 py-2.5 text-right">
                      <a href={`/v2/boss-pc/stores/${encodeURIComponent(s.name)}`} className={`text-caption ${s.anomaly ? 'text-red-fg' : 'text-gray2 hover:text-ink'}`}>
                        {s.anomaly ? '详情 ›' : '查看 ›'}
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
