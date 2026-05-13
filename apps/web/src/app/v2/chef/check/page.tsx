/**
 * 厨师长 App · 盘点 Tab  PDF: chef_inventory_check_tab  Tab 4/4
 * Hero 损耗率 (主动可控) + 黑色大入口"新增报损一笔" + 5 类原因 tag 颜色编码
 */
'use client'
import { useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { DemoBanner } from '@/components/v2/demo-banner'

type Reason = '临期' | '客退' | '变质' | '掉落' | '破损'
const REASON_TONE: Record<Reason, 'orange' | 'blue' | 'red' | 'gray'> = {
  '临期': 'orange', '客退': 'blue', '变质': 'red', '掉落': 'gray', '破损': 'gray',
}
const RECORDS: { name: string; qty: string; reason: Reason; time: string; reporter: string; amount: number }[] = [
  { name: '鲜虾滑',   qty: '1.2 kg', reason: '临期', time: '今日 14:23', reporter: '张师傅', amount: -85 },
  { name: '现切肥牛', qty: '0.5 kg', reason: '客退', time: '今日 12:08', reporter: '王师傅', amount: -98 },
  { name: '香菜',     qty: '0.2 kg', reason: '变质', time: '昨日 11:30', reporter: '张师傅', amount: -4 },
  { name: '鱼丸',     qty: '0.3 kg', reason: '掉落', time: '昨日 19:45', reporter: '李师傅', amount: -18 },
  { name: '火锅蘸料', qty: '1 瓶',   reason: '破损', time: '昨日 16:00', reporter: '张师傅', amount: -12 },
]

export default function ChefCheckPage() {
  const [tab, setTab] = useState('check')
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">盘点</h1>
          <p className="text-caption text-gray3">朝阳大悦城店 · 后厨</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">📅</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⋮</button>
        </div>
      </header>

      <DemoBanner note="盘点单 · 等盘点模块上线后替换" />
      <div className="mt-3">
        <GlanceStrip
          label="本周损耗率"
          value="1.8%"
          delta={{ text: '↓ 0.3% 较上周', trend: 'down' }}
          meta="连续 3 周下降 · 集团均值 2.1%"
          rightSlot="04/22 — 04/28"
          stats={[
            { label: '损耗金额', value: '¥328',   tone: 'default' },
            { label: '报损笔数', value: '12 笔',  tone: 'default' },
            { label: '消耗基数', value: '¥18.2K', tone: 'default' },
          ]}
        />
      </div>

      {/* 报损黑色大入口 */}
      <div className="px-4 mt-4">
        <a href="/v2/chef/check/new" className="w-full bg-ink text-white rounded-card p-4 flex items-center gap-3 text-left">
          <span className="w-10 h-10 rounded-full bg-white text-ink flex items-center justify-center text-h1">+</span>
          <div className="flex-1">
            <div className="text-h2">新增报损一笔</div>
            <p className="text-caption text-gray4">食材损耗 · 临期 · 客退 · 破损</p>
          </div>
          <span className="text-gray4">›</span>
        </a>
      </div>

      <Section title="本周报损" right={`${RECORDS.length} 笔 · ¥${RECORDS.reduce((s, r) => s + Math.abs(r.amount), 0)}`}>
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {RECORDS.map((r, i) => (
            <li key={i} className="px-3 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-h2">{r.name} · {r.qty}</span>
                  <Chip tone={REASON_TONE[r.reason]}>{r.reason}</Chip>
                </div>
                <p className="text-micro text-gray3">{r.time} · {r.reporter}</p>
              </div>
              <span className="font-num text-red-fg">{r.amount}</span>
              <span className="text-gray3">›</span>
            </li>
          ))}
        </ul>
        <a href="/v2/chef-director/loss" className="block text-center w-full mt-2 py-3 bg-white border border-border rounded-cta text-button text-gray2">查看全部报损 ›</a>
      </Section>

      <Section title="今日盘点" right="进行中">
        <div className="bg-white rounded-card border border-border p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-h2">已盘 23 / 119 项</span>
            <span className="text-caption text-orange-fg">闭店前完成</span>
          </div>
          <div className="h-2 bg-bg rounded-full overflow-hidden mb-3">
            <div className="h-full bg-ink" style={{ width: '19%' }} />
          </div>
          {/* 盘点流程未实装，先指向新增报损页 */}
          <a href="/v2/chef/check/new" className="block text-center w-full py-2 bg-ink text-white rounded-cta text-button">新增报损一笔</a>
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home', label: '工作台', icon: '⌂' },
          { key: 'inventory', label: '库存', icon: '⛁' },
          { key: 'purchase', label: '采购', icon: '☰' },
          { key: 'check', label: '盘点', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')      location.href = '/v2/chef/home'
          if (k === 'inventory') location.href = '/v2/chef/inventory'
          if (k === 'purchase')  location.href = '/v2/chef/purchase'
        }}
      />
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className="text-caption text-gray3">{right}</span>}
      </div>
      {children}
    </section>
  )
}
