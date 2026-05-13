/**
 * 老板 PC Web · 审批列表  PDF: boss_web_approvals
 * Top 搜索 + 类型 segmented · 详细表格 (7 列) · 行内 inline 双按钮 · 3 项阈值内折叠卡
 */
'use client'
import { useState, useEffect } from 'react'
import { Chip } from '@/components/v2'
import BossTopNav from '../_topnav'

const ITEMS = [
  { tone: 'red'    as const, type: '合同',  chips: ['大额'], tag: '3 小时前',    title: 'Q3 装修工程款',     sub: '京华装饰 · 朝阳店 · 张店长发起 · 凭证齐 · 财务初审 ✓ → 老板',  amount: 45000 },
  { tone: 'red'    as const, type: '采购',  chips: ['大额'], tag: '8 分钟前',    title: '厨房设备升级',       sub: '朝阳店 · 张店长发起 · 凭证齐 · 财务初审 ✓ · 阈值合规 · 历史正常', amount: 18000 },
  { tone: 'orange' as const, type: '报销',  chips: ['超阈值', '凭证待补'], tag: '2 小时前', title: '王伟 · 餐饮娱乐 · 招待客户', sub: '朝阳店 · 本月该员工第 3 次报销 · 累计 ¥12K · 建议复盘',     amount: 6200 },
  { tone: 'gray'   as const, type: '人事',  chips: ['绩效达标', '符合调薪规范'], tag: '昨日', title: '李店长 · 月薪 ¥12K → ¥14K', sub: '总厨发起 · 业绩评分 A · 营收同比 +12% · 团队 11/14 高满意度 · 调薪 +¥2K', amount: 2000 },
]
const COLLAPSED = { count: 3, total: 9200, lines: ['采购 1', '报销 1', '调拨 1'] }
const TYPE_TONE: Record<string, 'red' | 'orange' | 'gray'> = { '合同': 'red', '采购': 'red', '报销': 'orange', '人事': 'gray' }

export default function BossWebApprovalsPage() {
  const [filter, setFilter] = useState<'全部' | '合同' | '采购' | '报销' | '人事'>('全部')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const visible = filter === '全部' ? ITEMS : ITEMS.filter(i => i.type === filter)

  return (
    <div className="min-h-screen bg-bg">
      <BossTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">审批</h1>
            <p className="text-caption text-gray3">7 项待我审批 · 共 ¥86K</p>
          </div>
          <input className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72" placeholder="搜索审批 / 发起人 / 门店" />
          <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">筛选</button>
        </div>

        <div className="flex gap-2 mb-4">
          {(['全部', '合同', '采购', '报销', '人事'] as const).map(f => {
            const cnt = f === '全部' ? ITEMS.length : ITEMS.filter(i => i.type === f).length
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-cta text-button ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}
              >{f} {cnt > 0 && <span className="font-num">{cnt}</span>}</button>
            )
          })}
        </div>

        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 w-10"></th>
                <th className="px-3 py-2 font-normal">详情</th>
                <th className="px-3 py-2 font-normal text-right w-[110px]">金额</th>
                <th className="px-3 py-2 font-normal text-right w-[200px]">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((it, i) => (
                <tr key={i} className={`border-t border-border hover:bg-[#FAF8F2] ${it.tone === 'red' ? 'bg-red-bg/30' : it.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                  <td className="px-3 py-3 align-top">
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => {
                        const s = new Set(selected)
                        if (s.has(i)) s.delete(i); else s.add(i)
                        setSelected(s)
                      }}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Chip tone={TYPE_TONE[it.type] || 'gray'}>{it.type}</Chip>
                      {it.chips.map(c => <Chip key={c} tone={it.tone === 'red' ? 'red' : it.tone === 'orange' ? 'orange' : 'gray'}>{c}</Chip>)}
                      <span className="text-micro text-gray3">{it.tag}</span>
                    </div>
                    <div className="text-h2">{it.title}</div>
                    <p className="text-caption text-gray2 mt-0.5">{it.sub}</p>
                  </td>
                  <td className="px-3 py-3 text-right align-top">
                    <span className="font-num text-h2">{it.type === '人事' ? '+' : ''}¥{it.amount.toLocaleString()}{it.type === '人事' && <span className="text-micro text-gray3">/月</span>}</span>
                  </td>
                  <td className="px-3 py-3 align-top text-right">
                    <div className="inline-flex flex-col gap-1">
                      <button className="px-3 py-1.5 bg-ink text-white rounded-cta text-button">批准</button>
                      <button className="px-3 py-1.5 border border-red text-red rounded-cta text-button">驳回</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 阈值内折叠 */}
        <div className="mt-4 bg-white rounded-card border border-border p-3 flex items-center gap-3">
          <div className="flex -space-x-2">
            <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">五</span>
            <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">国</span>
            <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">双</span>
          </div>
          <div className="flex-1">
            <span className="text-h2">{COLLAPSED.count} 项 · 阈值内 · ¥{COLLAPSED.total.toLocaleString()}</span>
            <span className="text-caption text-gray3 ml-2">{COLLAPSED.lines.join(' · ')}</span>
          </div>
          <button className="px-4 py-2 bg-ink text-white rounded-cta text-button">批量审批 →</button>
        </div>
      </main>
    </div>
  )
}
