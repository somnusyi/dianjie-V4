/**
 * 财务 PC Web · 初审 Tab  PDF: finance_web_review
 * 类型 chips + 8 列表格 + 勾选批量审核 + "凭证待补" 红 chip + 路由可视
 */
'use client'
import { useState } from 'react'
import { Chip, StoreAvatar } from '@/components/v2'
import FinanceTopNav from '../_topnav'

type Tone = 'red' | 'orange' | 'gray'
const ITEMS = [
  { tone: 'red'    as Tone, store: '朝阳店', type: '合同',  title: 'Q3 装修工程款', amount: 45000, voucher: '凭证齐',     route: '→ 老板' },
  { tone: 'red'    as Tone, store: '朝阳店', type: '采购',  title: '厨房设备升级',   amount: 18000, voucher: '凭证齐',     route: '→ 老板' },
  { tone: 'orange' as Tone, store: '朝阳店', type: '报销',  title: '王伟 · 餐饮娱乐', amount: 3200,  voucher: '凭证待补',   route: '→ 老板', red: true },
  { tone: 'gray'   as Tone, store: '朝阳店', type: '采购',  title: '服务员制服 · 12 套', amount: 3000, voucher: '凭证齐',  route: '→ 直接生效' },
  { tone: 'gray'   as Tone, store: '国贸店', type: '其他',  title: '周末活动预算',     amount: 6000,  voucher: '凭证齐',     route: '→ 直接生效' },
  { tone: 'gray'   as Tone, store: '国贸店', type: '采购',  title: '月度餐具补充',     amount: 8000,  voucher: '凭证齐',     route: '→ 直接生效' },
  { tone: 'gray'   as Tone, store: '国贸店', type: '报销',  title: '孙店长 · 客户接待', amount: 1500, voucher: '凭证齐',     route: '→ 直接生效' },
  { tone: 'gray'   as Tone, store: '望京店', type: '其他',  title: '食材跨店调入',     amount: 2000,  voucher: '凭证齐',     route: '→ 直接生效' },
  { tone: 'gray'   as Tone, store: '望京店', type: '预销',  title: '周末团购券',       amount: 2800,  voucher: '凭证齐',     route: '→ 直接生效' },
]
const TYPE_TONE: Record<string, Tone> = { '合同': 'red', '采购': 'red', '报销': 'orange', '其他': 'gray', '预销': 'gray' }

export default function FinancePCReviewPage() {
  const [filter, setFilter] = useState<'全部' | '朝阳' | '国贸' | '望京'>('全部')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const visible = filter === '全部' ? ITEMS : ITEMS.filter(i => i.store.startsWith(filter))

  return (
    <div className="min-h-screen bg-bg">
      <FinanceTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">初审</h1>
            <p className="text-caption text-gray3">12 单待审 · 本月累计 ¥97.2K</p>
          </div>
          <div className="flex items-center gap-3">
            <input className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72" placeholder="搜索" />
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出</button>
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          {(['全部', '朝阳', '国贸', '望京'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-cta text-button ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}>
              {f === '全部' ? `全部 ${ITEMS.length}` : `${f} ${ITEMS.filter(i => i.store.startsWith(f)).length}`}
            </button>
          ))}
          <span className="px-3 py-1.5 text-caption text-gray3">+5 家 3</span>
        </div>

        <div className="bg-white rounded-card border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 w-10"><input type="checkbox" /></th>
                <th className="px-3 py-2 font-normal">门店</th>
                <th className="px-3 py-2 font-normal">类型</th>
                <th className="px-3 py-2 font-normal">详情</th>
                <th className="px-3 py-2 font-normal text-right">金额</th>
                <th className="px-3 py-2 font-normal">凭证</th>
                <th className="px-3 py-2 font-normal">路由</th>
                <th className="px-3 py-2 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((it, i) => (
                <tr key={i} className={`border-t border-border hover:bg-[#FAF8F2] ${it.tone === 'red' ? 'bg-red-bg/30' : it.tone === 'orange' ? 'bg-orange-bg/30' : ''}`}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => {
                      const s = new Set(selected)
                      if (s.has(i)) s.delete(i); else s.add(i)
                      setSelected(s)
                    }} />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <StoreAvatar name={it.store} size="sm" />
                      <span className="text-body">{it.store}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5"><Chip tone={TYPE_TONE[it.type] || 'gray'}>{it.type}</Chip></td>
                  <td className="px-3 py-2.5">
                    <div className="text-body">{it.title}</div>
                  </td>
                  <td className="px-3 py-2.5 font-num text-right">¥{it.amount.toLocaleString()}</td>
                  <td className="px-3 py-2.5">
                    <Chip tone={it.red ? 'red' : 'green'}>{it.voucher}</Chip>
                  </td>
                  <td className="px-3 py-2.5 text-caption">
                    <span className={it.route.includes('老板') ? 'text-red-fg' : 'text-green-fg'}>{it.route}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button className="px-3 py-1.5 bg-ink text-white rounded-cta text-button">审核</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 批量底栏 */}
        <div className="mt-3 sticky bottom-3 bg-white rounded-cta border border-border px-4 py-3 flex items-center justify-between shadow-fab">
          <span className="text-caption text-gray2">勾选后可多选 ({selected.size} 已选) · 批量通过仅支持"直接生效"路由</span>
          <button disabled={selected.size === 0} className="px-4 py-2 bg-ink text-white rounded-cta text-button disabled:opacity-40">批量通过 ({selected.size})</button>
        </div>
      </main>
    </div>
  )
}
