/**
 * 财务 PC Web · 工作台  PDF: finance_web_workbench
 * Hero "待我初审 12" + 双列(财务待办表格 + 资金概览/告警)
 */
'use client'
import { BlackHero, Chip, MetricTile, StoreAvatar } from '@/components/v2'
import FinanceTopNav from '../_topnav'

const QUEUE = [
  { tone: 'red'    as const, type: '采购初审', tag: '大额', title: '朝阳大悦城店 · 设备采购', sub: '超 ¥10K 阈值 · 凭证齐 · 财务初审 → 老板',  amount: 18000, action: '去审' },
  { tone: 'red'    as const, type: '应付到期', tag: '距到期 2 天', title: '京西生鲜 · 第 16 周',     sub: '周结 · 周一 04/29 到期 · 发票已收',           amount: 11200, action: '安排付款' },
  { tone: 'orange' as const, type: '报销初审', tag: '凭证待补', title: '王伟 · 餐饮娱乐',         sub: '3 项发票 · 1 项凭证待补 · 累计 ¥12K',         amount: 3200,  action: '审核' },
  { tone: 'gray'   as const, type: '应付到期', tag: '距到期 4 天', title: '大唐调味 · 4 月月结',     sub: '周三 05/01 到期 · 发票已收',                  amount: 3800,  action: '查看' },
]
const HEALTH = [
  { name: '朝阳大悦城店', tone: 'red'    as const, label: '异常', meta: '应收账期 35 天 · 集团均值 14 天' },
  { name: '国贸店',       tone: 'orange' as const, label: '关注', meta: '本月报销异常 +35% 偏多 · 待复盘' },
  { name: '6 家店',       tone: 'green'  as const, label: '正常', meta: '账期 ≤ 14 天 · 报销规范' },
]

export default function FinancePCHomePage() {
  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-caption text-gray2">早上好，刘财务</p>
            <h1 className="text-h1">集团 · 8 家店 · 周三 04/28 · 14:23</h1>
          </div>
          <button className="px-4 py-2 bg-ink text-white rounded-cta text-button">⌘ 批量审批</button>
        </div>

        <BlackHero
          density="desktop"
          label="待我初审 ●"
          value="12"
          delta={{ text: '单待处理 · 平均处理 28 分钟 · 累计 ¥97.2K', trend: 'flat' }}
          stats={[
            { label: '月现金流净', value: '+¥185K', tone: 'green' },
            { label: '预收待结',   value: '¥120K',  tone: 'default' as any },
            { label: '应付待结',   value: '¥48K',   tone: 'orange' },
          ]}
        />

        <div className="grid grid-cols-[2.2fr_1fr] gap-4 mt-4">
          {/* 主区 财务待办表格 */}
          <section className="bg-white rounded-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center justify-between">
              <h2 className="text-h2">财务待办</h2>
              <span className="text-caption text-red-fg">紧急优先 · 12 项</span>
            </header>
            <table className="w-full">
              <thead className="bg-bg/40">
                <tr className="text-micro text-gray3 text-left">
                  <th className="px-3 py-2 font-normal">详情</th>
                  <th className="px-3 py-2 font-normal text-right w-24">金额</th>
                  <th className="px-3 py-2 font-normal text-right w-28">操作</th>
                </tr>
              </thead>
              <tbody>
                {QUEUE.map((q, i) => (
                  <tr key={i} className={`border-t border-border ${q.tone === 'red' ? 'bg-red-bg/30' : q.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <Chip tone={q.tone}>{q.type}</Chip>
                        <span className="text-micro text-gray3">{q.tag}</span>
                      </div>
                      <div className="text-h2">{q.title}</div>
                      <p className="text-caption text-gray2 mt-0.5">{q.sub}</p>
                    </td>
                    <td className="px-3 py-3 font-num text-h2 text-right align-top">¥{q.amount.toLocaleString()}</td>
                    <td className="px-3 py-3 text-right align-top">
                      <button className="px-3 py-1.5 bg-ink text-white rounded-cta text-button">{q.action}</button>
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <td colSpan={3} className="px-4 py-3 text-center text-caption text-gray2">查看全部 12 项 ›</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* 副区 资金概览 + 告警 + 各店健康 */}
          <div className="space-y-4">
            <section className="bg-white rounded-card border border-border p-4">
              <header className="flex items-center justify-between mb-3">
                <h2 className="text-h2">资金概览</h2>
                <span className="text-caption text-gray3">实时</span>
              </header>
              <div className="grid grid-cols-2 gap-2">
                <MetricTile label="总账户余额" value="¥285K" delta="↑ ¥45K 较月初" />
                <MetricTile label="本周应付"   value="¥21K"  delta="3 笔"          tone="orange" />
                <MetricTile label="月流入"     value="+¥420K" delta="85 笔"         tone="green" />
                <MetricTile label="月流出"     value="−¥235K" delta="142 笔"         tone="red" />
              </div>
              <div className="mt-3 bg-orange-bg rounded-card p-2.5 text-caption text-orange-fg flex items-center gap-2">
                <span>余额低</span>
                <span className="font-num text-h2 ml-auto">朝阳店备用 ¥1,500</span>
                <button className="ml-2 px-3 py-1 bg-ink text-white rounded-cta text-button">补拨</button>
              </div>
            </section>

            <section className="bg-white rounded-card border border-border overflow-hidden">
              <header className="px-4 py-3 border-b border-border">
                <h2 className="text-h2">各店财务健康</h2>
              </header>
              <ul className="divide-y divide-border">
                {HEALTH.map(h => (
                  <li key={h.name} className={`px-4 py-2.5 flex items-center gap-3 ${h.tone === 'red' ? 'bg-red-bg/30' : h.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                    <StoreAvatar name={h.name} anomaly={h.tone === 'red'} size="sm" />
                    <div className="flex-1">
                      <div className="text-body flex items-center gap-2">
                        {h.name}
                        <Chip tone={h.tone}>{h.label}</Chip>
                      </div>
                      <p className="text-micro text-gray3">{h.meta}</p>
                    </div>
                    <span className="text-gray3">›</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
