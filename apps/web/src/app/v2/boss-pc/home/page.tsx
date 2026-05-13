/**
 * 老板 PC Web · 首页 (Dashboard)  PDF: boss_web_home
 * Top nav 替代 Bottom Nav · Hero 横版三列布局 · Dashboard 双列(2.2:1) · 表格 hover + 排序
 */
'use client'
import { MetricTile, StoreAvatar, Chip, PeriodPills } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import BossTopNav from '../_topnav'
import { useState } from 'react'

const STORES = [
  { rank: 1, name: '国贸店',         rev: 320000, growth: '↑ 12% 较上月', netRate: 8.7, anomaly: false, anomalies: 0 },
  { rank: 2, name: '望京 SOHO 店',  rev: 298000, growth: '↑ 8% 较上月',  netRate: 8.1, anomaly: false, anomalies: 0 },
  { rank: 3, name: '朝阳大悦城店',   rev: 285000, growth: '成本 64% 偏高', netRate: 6.3, anomaly: true,  anomalies: 5 },
  { rank: 4, name: '三里屯店',       rev: 272000, growth: '↑ 5% 较上月',  netRate: 7.4, anomaly: false, anomalies: 0 },
  { rank: 5, name: '五道口店',       rev: 248000, growth: '净利率最高',     netRate: 8.9, anomaly: false, anomalies: 0 },
  { rank: 6, name: '双井店',         rev: 232000, growth: '↑ 3% 较上月',  netRate: 8.2, anomaly: false, anomalies: 0 },
  { rank: 7, name: '中关村店',       rev: 215000, growth: '↓ 0% 较上月',  netRate: 8.4, anomaly: false, anomalies: 0 },
  { rank: 8, name: '朝外店',         rev: 185000, growth: '新店 · 仍在爬坡', netRate: 7.6, anomaly: false, anomalies: 0 },
]
const PENDING_APPROVAL = [
  { tone: 'red' as const, chip: '合同 · 大额', tag: '3 小时前', title: 'Q3 装修工程款', sub: '朝阳店 · 张店长 · 财务初审 ✓', amount: 45000 },
  { tone: 'red' as const, chip: '采购 · 大额', tag: '8 分钟前', title: '厨房设备升级',   sub: '朝阳店 · 张店长 · 财务初审 ✓', amount: 18000 },
  { tone: 'orange' as const, chip: '报销 · 凭证待补', tag: '2 小时前', title: '王伟 · 餐饮娱乐', sub: '朝阳店 · 本月第 3 次报销', amount: 6200 },
]

export default function BossWebHomePage() {
  const [period, setPeriod] = useState('month')
  return (
    <div className="min-h-screen bg-bg">
      <BossTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-caption text-gray2">早上好，王总</p>
            <h1 className="text-h1">集团 · 8 家店 · 周三 04/28 · 14:23</h1>
          </div>
          <PeriodPills
            value={period} onChange={setPeriod}
            options={[
              { label: '今日', value: 'day' },
              { label: '本周', value: 'week' },
              { label: '本月', value: 'month' },
              { label: 'YTD',  value: 'ytd' },
            ]}
          />
        </div>

        {/* Glance — 替代 desktop 黑卡 Hero */}
        <div className="-mx-4">
          <GlanceStrip
            label="今日集团营业额 · 实时"
            value="¥168,500"
            delta={{ text: '↑ 8.2% 较昨日', trend: 'up' }}
            meta="预估全日 ¥220K · 完成 76%"
            stats={[
              { label: '待我审批', value: '7 项 · ¥86K',  tone: 'red' },
              { label: '异常店',  value: '1 家',          tone: 'orange' },
              { label: '月净利预估', value: '+¥158K',     tone: 'green' },
            ]}
          />
        </div>

        {/* 双列 dashboard - 2.2:1 */}
        <div className="grid grid-cols-[2.2fr_1fr] gap-4 mt-4">
          {/* 左主区 8 家店表格 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">门店概览</h2>
              <span className="text-caption text-gray3">8 家全展开 · 排序按营收</span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">排名 · 门店</th>
                  <th className="px-3 py-2 font-normal text-right">本月营收</th>
                  <th className="px-3 py-2 font-normal w-[140px]">占比</th>
                  <th className="px-3 py-2 font-normal text-right">净利率</th>
                  <th className="px-3 py-2 font-normal text-right">异常</th>
                  <th className="px-3 py-2 font-normal text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {STORES.map((s) => {
                  const max = STORES[0].rev
                  return (
                    <tr key={s.rank} className={`border-t border-border hover:bg-[#FAF8F2] ${s.anomaly ? 'bg-red-bg/40' : ''}`}>
                      <td className="px-3 py-2.5 flex items-center gap-2">
                        <span className="font-num text-gray3 text-caption w-4 text-right">{s.rank}</span>
                        <StoreAvatar name={s.name} anomaly={s.anomaly} size="sm" />
                        <div>
                          <div className="text-body">{s.name} {s.anomaly && <Chip tone="red">异常</Chip>}</div>
                          <div className={`text-micro ${s.anomaly ? 'text-red-fg' : 'text-gray3'}`}>{s.growth}</div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-num text-right">¥{(s.rev / 1000).toFixed(0)}K</td>
                      <td className="px-3 py-2.5">
                        <div className="h-1.5 bg-bg rounded-full overflow-hidden w-full">
                          <div className={`h-full ${s.anomaly ? 'bg-red' : 'bg-gray2'}`} style={{ width: `${(s.rev / max) * 100}%` }} />
                        </div>
                      </td>
                      <td className={`px-3 py-2.5 font-num text-right ${s.anomaly ? 'text-red-fg' : ''}`}>{s.netRate}%</td>
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
          </section>

          {/* 右副区 待审批 + 集团 KPI */}
          <div className="space-y-4">
            <section className="bg-white rounded-card border border-border">
              <header className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h2 className="text-h2">待我审批</h2>
                <span className="text-caption text-red-fg">7 项 · ¥86K</span>
              </header>
              <ul className="divide-y divide-border">
                {PENDING_APPROVAL.map((p, i) => (
                  <li key={i} className={`px-4 py-3 ${p.tone === 'red' ? 'bg-red-bg/30' : p.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <Chip tone={p.tone}>{p.chip}</Chip>
                      <span className="text-micro text-gray3">{p.tag}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-h2">{p.title}</span>
                      <span className="font-num text-h2">¥{p.amount.toLocaleString()}</span>
                    </div>
                    <p className="text-caption text-gray2 mt-0.5">{p.sub}</p>
                  </li>
                ))}
                <li className="px-4 py-3 text-center">
                  <a href="/v2/boss-pc/approvals" className="text-caption text-gray2">查看全部 7 项 ›</a>
                </li>
              </ul>
            </section>

            <section className="bg-white rounded-card border border-border p-4">
              <header className="flex items-center justify-between mb-3">
                <h2 className="text-h2">集团关键指标</h2>
                <span className="text-caption text-gray3">04 月</span>
              </header>
              <div className="grid grid-cols-2 gap-2">
                <MetricTile label="总营收"     value="¥2,055K" delta="↑ 7% 较上月" />
                <MetricTile label="净利率"     value="7.7%"    delta="↑ 0.3pp" tone="green" />
                <MetricTile label="集团损耗率" value="1.6%"    delta="行业 2.1%" tone="green" />
                <MetricTile label="库存周转"   value="7 天"    delta="健康" />
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
