/**
 * 厨师长 App · 工作台 v2  PDF: chef_dashboard  Tab 1/4
 * Hero 物料导向 (本店库存) · 三色待办 · 进行中采购 5 段 ProgressDots
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, ProgressDots, TodoCard } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { Sparkline } from '@/components/v2/sparkline'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'
// currentIndex = 已完成步骤数 (步 < currentIndex 显示 ✓, 步 = currentIndex 高亮当前)
// 状态=做完了某个动作 → 该动作 ✓, 下一个动作高亮
const STATUS_TO_STEP: Record<string, number> = {
  SUBMITTED: 1,        // 已发起 ✓, 接单 current
  CONFIRMED: 2,        // 接单 ✓, 配送 current
  DELIVERING: 3,       // 配送 ✓ (已上车在路上), 送达 current
  PENDING_CONFIRM: 4,  // 送达 ✓, 验收 current
  RECEIVED: 5, COMPLETED: 5,  // 全部 ✓
}
const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '待接单', CONFIRMED: '已接单', DELIVERING: '配送中', PENDING_CONFIRM: '已送达',
}

export default function ChefHomePage() {
  const [tab, setTab] = useState('home')
  const { data, error } = useDashboard()
  const [orders, setOrders] = useState<any[] | null>(null)
  const [inv, setInv] = useState<any[] | null>(null)
  useEffect(() => {
    apiFetch<any>('/api/orders?pageSize=20')
      .then((d: any) => setOrders((d.items || d || []).filter((o: any) => ['SUBMITTED','CONFIRMED','DELIVERING','PENDING_CONFIRM'].includes(o.status))))
      .catch(() => setOrders([]))
    apiFetch<any[]>('/api/inventory')
      .then(d => setInv(Array.isArray(d) ? d : []))
      .catch(() => setInv([]))
  }, [])
  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)
  const inProgress = orders || []

  // 真待办：低库存(缺货) + 临期 + 待验收
  const lowStock = (inv || []).filter(p => p.isLowStock).slice(0, 2)
  const expiring = (inv || []).filter(p => p.isExpiringSoon && !p.isExpired).slice(0, 2)
  const toReceive = inProgress.filter(o => o.status === 'PENDING_CONFIRM').slice(0, 2)
  const todoCount = lowStock.length + expiring.length + toReceive.length
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">厨师长工作台</h1>
          <p className="text-caption text-gray3 mt-0.5">{data.store?.name || '门店'} · {today}</p>
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

      <Section title="待办" right={todoCount > 0 ? `${todoCount} 项加急` : '无加急'} rightTone={todoCount > 0 ? 'red' : undefined}>
        <div className="space-y-2">
          {todoCount === 0 && (
            <p className="text-caption text-gray3 text-center py-4">今日无加急 · 库存健康 + 无临期 + 无待验收</p>
          )}
          {lowStock.map(p => (
            <TodoCard
              key={`low-${p.id}`}
              tone="immediate"
              chips={[{ label: '缺货', tone: 'red' }, { label: '低于安全库存', tone: 'gray' }]}
              title={`${p.name} · 仅剩 ${Number(p.stock)} ${p.unit}`}
              sub={`安全库存 ${Number(p.minStock)} ${p.unit} · 立即补货`}
              primary={{ label: '去下单', onClick: () => location.href = '/v2/chef/purchase/new' }}
            />
          ))}
          {expiring.map(p => (
            <TodoCard
              key={`exp-${p.id}`}
              tone="today"
              chips={[{ label: '临期', tone: 'orange' }, { label: `${p.daysToExpiry ?? '?'} 天内到期`, tone: 'gray' }]}
              title={`${p.name} · ${Number(p.stock)} ${p.unit}`}
              sub="优先用于今晚特价 / 报损"
              primary={{ label: '报损', onClick: () => location.href = '/v2/chef/check/new' }}
            />
          ))}
          {toReceive.map(o => (
            <TodoCard
              key={`po-${o.id}`}
              tone="routine"
              chips={[{ label: '待验收', tone: 'gray' }, { label: `#${o.no}`, tone: 'gray' }]}
              title={`${o.supplier?.name || '供应商'} · ${o.items?.length ?? 0} 项`}
              sub={`总额 ¥${Math.round(Number(o.totalAmount || 0)).toLocaleString()}`}
              primary={{ label: '去验收', onClick: () => location.href = `/v2/chef/purchase/${o.id}/receive` }}
            />
          ))}
        </div>
      </Section>

      <Section title="进行中采购" right={`${inProgress.length} 单`}>
        <ul className="space-y-2">
          {orders === null && <li className="text-caption text-gray3 text-center py-4">加载中…</li>}
          {orders !== null && inProgress.length === 0 && <li className="text-caption text-gray3 text-center py-4">暂无进行中订单</li>}
          {inProgress.slice(0, 3).map((o: any) => (
            <li key={o.id} className="bg-white rounded-card border border-border p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-micro text-gray3 font-num">#{o.no}</span>
                  <span className="ml-2 text-micro text-orange-fg bg-orange-bg px-1.5 rounded-chip">{STATUS_LABEL[o.status]}</span>
                </div>
                <span className="font-num text-h2">¥{Number(o.totalAmount).toLocaleString()}</span>
              </div>
              <div className="text-h2 mb-2">{o.supplier?.name}</div>
              <ProgressDots
                steps={[{label:'已发起'},{label:'接单'},{label:'在途'},{label:'送达'},{label:'验收'}]}
                currentIndex={STATUS_TO_STEP[o.status] ?? 0}
              />
            </li>
          ))}
          {inProgress.length > 3 && (
            <li className="text-center"><a href="/v2/chef/purchase" className="text-caption text-gray2">查看全部 {inProgress.length} 单 ›</a></li>
          )}
        </ul>
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
          setTab(k)
          if (k === 'inventory') location.href = '/v2/chef/inventory'
          if (k === 'purchase')  location.href = '/v2/chef/purchase'
          if (k === 'check')     location.href = '/v2/chef/check'
        }}
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
