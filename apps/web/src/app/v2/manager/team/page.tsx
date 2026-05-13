/**
 * 店长 App · 团队 Tab  PDF: manager_team_tab  Tab 4/4
 * 在岗状态 Hero + 三色待办（请假/调班/培训）+ 今日班次 + 在岗员工
 */
'use client'
import { useState } from 'react'
import { BlackHero, BottomNav } from '@/components/v2'
import { DemoBanner } from '@/components/v2/demo-banner'

const ANOMALIES = [
  { tone: 'red' as const, chip: '主厨张师傅 · 临时请假', tag: '急', sub: '家中突发 · 缺岗到 18:00 晚市', action: '指派替工' },
  { tone: 'orange' as const, chip: '服务员王磊 · 迟到 15 分', sub: '本月第 2 次 · 请关注' },
  { tone: 'gray' as const, chip: '调班申请 · 周日 → 周一', sub: '服务员李娟 · 同岗位有人替', actions: { primary: '批准', secondary: '驳回' } },
]
const SHIFTS = [
  { type: '早班', time: '06:00 — 14:00', n: 4, total: 4, status: '满员' },
  { type: '午班', time: '11:00 — 19:00', n: 5, total: 6, status: '缺 1 · 主厨', current: true },
  { type: '晚班', time: '17:00 — 23:00', n: 4, total: 4, status: '满员' },
]
const STAFF = [
  { name: '王伟', pos: '大堂经理', shift: '午班 · 在岗 3h 22min', status: '在岗' },
  { name: '张师傅', pos: '主厨',   shift: '午班 · 临时请假',     status: '请假' },
  { name: '李娟', pos: '服务员',   shift: '午班 · 在岗 3h 22min', status: '在岗' },
  { name: '王磊', pos: '服务员',   shift: '午班 · 迟到 15 分钟', status: '迟到' },
  { name: '陈姐', pos: '收银',     shift: '午班 · 在岗 3h 10min', status: '在岗' },
]
const STATUS_TONE: Record<string, string> = { '在岗': 'bg-green-bg text-green-fg', '请假': 'bg-red-bg text-red-fg', '迟到': 'bg-orange-bg text-orange-fg' }

export default function ManagerTeamPage() {
  const [tab, setTab] = useState<'team'>('team')
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">团队</h1>
          <p className="text-caption text-gray3">朝阳大悦城店 · 14 人编制</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="搜索">⌕</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="筛选">≡</button>
        </div>
      </header>

      <DemoBanner note="员工/排班/绩效 · 接 HR 模块后替换" />
      <div className="px-4 mt-2">
        <BlackHero
          label="在岗状态 ● 实时"
          value="11 / 14 在岗"
          delta={{ text: '满员率 78% · 较平均低 8%', trend: 'down' }}
          rightSlot="14:23"
          stats={[
            { label: '前厅', value: '5 / 6', tone: 'default' as any },
            { label: '后厨', value: '4 / 5', tone: 'orange' },
            { label: '收银', value: '2 / 3', tone: 'default' as any },
          ]}
        />
      </div>

      <Section title="今日异常" right="3 项需处理" rightTone="orange">
        <ul className="space-y-2">
          {ANOMALIES.map((a, i) => {
            const barColor = a.tone === 'red' ? 'before:bg-red' : a.tone === 'orange' ? 'before:bg-orange' : 'before:bg-gray4'
            return (
              <li key={i} className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${barColor}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="text-h2">{a.chip}{a.tag && <span className="ml-2 text-micro text-orange-fg">{a.tag}</span>}</div>
                    <p className="text-caption text-gray2 mt-0.5">{a.sub}</p>
                  </div>
                  {a.action && <button className="px-3 py-1.5 bg-ink text-white rounded-cta text-button shrink-0">{a.action}</button>}
                  {a.actions && (
                    <div className="flex gap-1 shrink-0">
                      <button className="px-3 py-1.5 bg-white border border-border rounded-cta text-button">{a.actions.secondary}</button>
                      <button className="px-3 py-1.5 bg-ink text-white rounded-cta text-button">{a.actions.primary}</button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title="今日班次" right="排班 ›">
        <div className="grid grid-cols-3 gap-2">
          {SHIFTS.map(s => (
            <div key={s.type} className={`bg-white rounded-card border ${s.current ? 'border-orange' : 'border-border'} p-3`}>
              <div className="text-caption text-gray2">{s.type}</div>
              <div className="text-micro text-gray3 mt-0.5">{s.time}</div>
              <div className="font-num text-h1 mt-1">{s.n} / {s.total}</div>
              <div className={`text-micro mt-1 ${s.current ? 'text-orange-fg' : 'text-gray3'}`}>{s.status}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="在岗员工" right="11 / 14">
        <ul className="bg-white rounded-card border border-border divide-y divide-border">
          {STAFF.map((s) => (
            <li key={s.name} className="px-3 py-3 flex items-center gap-3">
              <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center font-num">{s.name[0]}</span>
              <div className="flex-1 min-w-0">
                <div className="text-h2">{s.name} <span className="text-caption text-gray2">· {s.pos}</span></div>
                <div className="text-micro text-gray3">{s.shift}</div>
              </div>
              <span className={`text-micro px-2 py-0.5 rounded-chip ${STATUS_TONE[s.status] || 'bg-bg text-gray3'}`}>{s.status}</span>
            </li>
          ))}
        </ul>
        <button className="w-full mt-2 py-3 bg-white border border-border rounded-cta text-button text-gray2">查看全部 14 人 ›</button>
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
          if (k === 'home')     location.href = '/v2/manager/home'
          if (k === 'ops')      location.href = '/v2/manager/ops'
          if (k === 'customer') location.href = '/v2/manager/customer'
        }}
        fabKey="fab"
        onFab={() => location.href = '/v2/manager/home'}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'orange'; children: React.ReactNode }) {
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
