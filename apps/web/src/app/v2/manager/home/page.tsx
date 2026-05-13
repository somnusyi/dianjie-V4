/**
 * 店长 App · 工作台  PDF: manager_dashboard  Tab 1/4 + 中央 FAB
 * Hero 实时营收 + 三色待办（差评/请假/缺货/调班/储值卡）+ 本月经营 4 metric
 */
'use client'
import { useState, useEffect } from 'react'
import { MetricTile, BottomNav, TodoCard } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { Sparkline } from '@/components/v2/sparkline'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'
import CentralDrawer from '../_drawer'

type LossClaim = { id: string; no: string; status: string; totalLossAmount: string | number; description: string }
type DocItem = { stepId: string; document: { id: string; type: string; title: string; amount: string | number | null; createdAt: string } }

const DOC_TYPE_LABEL: Record<string, string> = {
  PETTY_CASH: '备用金', REIMBURSEMENT: '报销',
  PURCHASE_NON_FOOD: '采购', CONTRACT: '合同',
}

export default function ManagerHomePage() {
  const [tab, setTab] = useState<'home' | 'ops' | 'fab' | 'customer' | 'team'>('home')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [todayRevenueRecorded, setTodayRevenueRecorded] = useState<boolean | null>(null)
  const [pendingLoss, setPendingLoss] = useState<LossClaim[] | null>(null)
  const [pendingInv, setPendingInv] = useState<any[] | null>(null)
  const [myDocs, setMyDocs] = useState<DocItem[] | null>(null)
  const { data, error } = useDashboard()

  useEffect(() => {
    // 检测今日是否已录营业额
    const today = new Date().toISOString().slice(0, 10)
    const month = today.slice(0, 7)
    apiFetch<any[]>(`/api/revenue?month=${month}`)
      .then(rows => {
        const hit = (rows || []).find(r => r.date?.slice(0, 10) === today && Number(r.amount) > 0)
        setTodayRevenueRecorded(!!hit)
      })
      .catch(() => setTodayRevenueRecorded(true))
    // 本店报损待处理 (店长视角看自己店的报损)
    apiFetch<LossClaim[]>('/api/loss-claims?limit=10')
      .then(rows => setPendingLoss((rows || []).filter(r => r.status === 'PENDING' || r.status === 'NEGOTIATING')))
      .catch(() => setPendingLoss([]))
    // 待验收 PO
    apiFetch<any>('/api/orders?pageSize=20')
      .then(d => setPendingInv((d.items || d || []).filter((o: any) => o.status === 'PENDING_CONFIRM')))
      .catch(() => setPendingInv([]))
  }, [])

  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)
  const storeName = data.store?.name || '门店'
  // 22 点后还没录提示更明显, 中午就温和提醒
  const now = new Date()
  const isLate = now.getHours() >= 21
  const showRecordReminder = todayRevenueRecorded === false

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">店长工作台</h1>
          <p className="text-caption text-gray3 mt-0.5">{storeName} · {today}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="搜索">⌕</button>
          <UserMenu />
        </div>
      </header>

      <div className="mt-3">
        <GlanceStrip
          {...(data.hero as any)}
          sparkline={data.hero?.revenue7d && data.hero.revenue7d.length > 1
            ? <Sparkline data={data.hero.revenue7d} />
            : undefined}
        />
      </div>

      {/* 每日 1 件事:今日营业额未录提醒 */}
      {showRecordReminder && (
        <a href="/v2/manager/revenue"
           className={`mx-4 mt-3 flex items-center gap-3 rounded-card px-3 py-3 ${
             isLate ? 'bg-red text-white' : 'bg-amber/10 border border-amber/30'
           }`}>
          <span className={`w-9 h-9 rounded-full flex items-center justify-center text-h2 ${
            isLate ? 'bg-white/20' : 'bg-amber text-white'
          }`}>¥</span>
          <div className="flex-1">
            <div className={`text-button ${isLate ? '' : 'text-amber-fg'}`}>
              {isLate ? '今日营业额还没录入' : '记得录今日营业额'}
            </div>
            <div className={`text-micro mt-0.5 ${isLate ? 'text-white/70' : 'text-gray2'}`}>
              {isLate ? '马上闭店, 录完今日数据才能上传' : '收档后录今日 4 渠道流水'}
            </div>
          </div>
          <span className={isLate ? 'text-white' : 'text-gray3'}>›</span>
        </a>
      )}
      {todayRevenueRecorded && (
        <div className="mx-4 mt-3 flex items-center gap-2 px-3 py-2">
          <span className="text-green-fg">✓</span>
          <span className="text-caption text-gray2">今日营业额已录入</span>
        </div>
      )}

      <Section title="待办" right={(() => {
        const n = (pendingLoss?.length || 0) + (pendingInv?.length || 0)
        return n > 0 ? `${n} 项` : undefined
      })()} rightTone={(pendingLoss?.length || 0) > 0 ? 'red' : undefined}>
        <div className="space-y-2">
          {pendingLoss === null && pendingInv === null && (
            <p className="text-caption text-gray3 text-center py-4">加载中…</p>
          )}
          {(pendingLoss?.length || 0) === 0 && (pendingInv?.length || 0) === 0 && pendingLoss !== null && (
            <p className="text-caption text-gray3 text-center py-4">✓ 今日无加急</p>
          )}
          {(pendingInv || []).slice(0, 2).map(o => (
            <TodoCard
              key={`po-${o.id}`}
              tone="immediate"
              chips={[{ label: '待验收', tone: 'red' }, { label: `#${o.no}`, tone: 'gray' }]}
              title={`${o.supplier?.name || '供应商'} · ${o.items?.length ?? 0} 项 · ¥${Math.round(Number(o.totalAmount || 0)).toLocaleString()}`}
              sub="厨师长 / 店长 都能验收 · 实收 < 下单自动建报损"
              primary={{ label: '去验收', onClick: () => location.href = `/v2/chef/purchase/${o.id}/receive` }}
            />
          ))}
          {(pendingLoss || []).slice(0, 3).map(l => (
            <TodoCard
              key={`l-${l.id}`}
              tone="today"
              chips={[{ label: '报损', tone: 'orange' }, { label: l.status === 'NEGOTIATING' ? '协商中' : '待处理', tone: 'gray' }]}
              title={`${l.no} · ¥${Math.round(Number(l.totalLossAmount)).toLocaleString()}`}
              sub={l.description}
            />
          ))}
        </div>
      </Section>

      <Section title="本月经营" right={today}>
        <div className="grid grid-cols-2 gap-2">
          {(data.monthlyMetrics || []).map((m: any) => (
            <MetricTile key={m.label} label={m.label} value={m.value} delta={m.delta} tone={m.tone} />
          ))}
        </div>
      </Section>

      {/* 中央抽屉 (FAB) */}
      {drawerOpen && <CentralDrawer onClose={() => setDrawerOpen(false)} />}

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
          setTab(k as any)
          if (k === 'ops')      location.href = '/v2/manager/ops'
          if (k === 'customer') location.href = '/v2/manager/customer'
          if (k === 'team')     location.href = '/v2/manager/team'
        }}
        fabKey="fab"
        onFab={() => setDrawerOpen(true)}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
