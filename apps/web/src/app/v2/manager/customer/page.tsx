/**
 * 店长 App · 客户 Tab  PDF: manager_customer_tab  Tab 3/4
 * 满意度 Hero + 差评分级处理 + VIP/储值卡监控
 */
'use client'
import { useState } from 'react'
import { BlackHero, BottomNav, MetricTile, Chip } from '@/components/v2'
import { DemoBanner } from '@/components/v2/demo-banner'

const REVIEWS = [
  { stars: 1, source: '大众点评', name: '张**', vip: true, content: '"等位 50 分钟还没坐上,服务员态度很冷淡,菜上来发现海带变黑..."', timeAgo: '2 小时前 · 4 月 28 日 12:30', tone: 'red' as const },
  { stars: 1, source: '美团',     name: '138****6611', vip: false, content: '"麻辣锅底油不够红,辣度也不够,跟以前不是一个味..."', timeAgo: '5 小时前 · 4 月 28 日 09:42', tone: 'red' as const },
  { stars: 3, source: '小红书',   name: '火锅小达人', vip: false, content: '"环境还行,味道一般,价格偏贵,人均 180 不太值..."', timeAgo: '昨日 19:23', tone: 'orange' as const },
]

export default function ManagerCustomerPage() {
  const [tab, setTab] = useState<'customer'>('customer')
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">客户</h1>
          <p className="text-caption text-gray3">朝阳大悦城店</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="搜索">⌕</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="筛选">≡</button>
        </div>
      </header>

      <DemoBanner note="客户/评价/储值数据 · 接 POS / 美团 webhook 后替换" />
      <div className="px-4 mt-2">
        <BlackHero
          label="本周满意度"
          value="4.6 ★"
          delta={{ text: '↑ 0.1 较上周', trend: 'up' }}
          meta="本周收到点评 142 条 · 集团均值 4.5"
          rightSlot="04/22 — 04/28"
          stats={[
            { label: '待回复差评', value: '5 条',     tone: 'red' },
            { label: '储值卡余额', value: '¥48.2K',   tone: 'default' as any },
            { label: '活跃会员',  value: '1,238',     tone: 'default' as any },
          ]}
        />
      </div>

      <Section title="待回复差评" right="5 条 · 24h 内回复" rightTone="orange">
        <ul className="space-y-2">
          {REVIEWS.map((r, i) => (
            <li key={i} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${r.tone === 'red' ? 'before:bg-red' : 'before:bg-orange'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-h2 font-num">{'★'.repeat(r.stars)}<span className="text-gray5">{'★'.repeat(5 - r.stars)}</span></span>
                <span className="text-micro text-gray2">{r.source} · {r.name}</span>
                {r.vip && <Chip tone="orange">VIP</Chip>}
              </div>
              <p className="text-body text-gray2">{r.content}</p>
              <p className="text-micro text-gray3 mt-1">{r.timeAgo}</p>
              {r.stars <= 2 && (
                <button className="mt-2 w-full py-2 bg-ink text-white rounded-cta text-button">回复并跟进</button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="会员与储值卡" right="查看 ›">
        <div className="grid grid-cols-2 gap-2">
          <MetricTile label="活跃会员"   value="1,238"     delta="↑ 8% 本月" />
          <MetricTile label="储值卡余额" value="¥48.2K"   delta="大额客户 38 位" />
        </div>
        <div className="mt-2 bg-white rounded-card border border-border p-3 flex items-center justify-between">
          <div>
            <div className="text-h2">大额储值卡客户预警</div>
            <p className="text-caption text-gray3">3 位 VIP 客户超 60 天未到店</p>
          </div>
          <span className="text-gray3">›</span>
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',     label: '工作台', icon: '⌂' },
          { key: 'ops',      label: '营业',   icon: '⛁' },
          { key: 'fab',      label: '',       icon: '+' },
          { key: 'customer', label: '客户',   icon: '★' },
          { key: 'team',     label: '团队',   icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home') location.href = '/v2/manager/home'
          if (k === 'ops')  location.href = '/v2/manager/ops'
          if (k === 'team') location.href = '/v2/manager/team'
        }}
        fabKey="fab"
        onFab={() => location.href = '/v2/manager/home'}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'orange' | 'red'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'orange' ? 'text-orange-fg' : rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
