'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import dayjs from 'dayjs'
import AppLayout from '@/components/AppLayout'
import { fmt } from '@/components/ui'
import api from '@/lib/api'

type DashboardStats = {
  purchase?: { thisMonth?: number; lastMonth?: number; growth?: string | number | null }
  pendingPayment?: number
  overdueCount?: number
  pendingApprovalCount?: number
  pendingReceiptCount?: number
  pendingLossCount?: number
  lowStockProducts?: Array<{ id: string; name: string; stock: number; minStock: number; unit: string }>
  upcomingSchedules?: any[]
  recentReceipts?: any[]
  storeBreakdown?: any[]
}

type User = {
  name?: string
  role?: string
  store?: { name?: string }
}

const toneLabel: Record<string, string> = {
  ADMIN: '集团决策',
  SUPER_ADMIN: '集团决策',
  FINANCE: '财务把关',
  MANAGER: '单店操作',
  SUPPLIER_STAFF: '供应商履约',
}

function moneyShort(value: number) {
  if (value >= 1000000) return `¥${(value / 10000).toFixed(1)}万`
  if (value >= 10000) return `¥${Math.round(value / 1000)}K`
  return fmt(value)
}

function cleanStore(name?: string) {
  return name?.replace('滇界·', '') || '未绑定门店'
}

function StatusChip({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'red' | 'orange' | 'green' | 'blue' | 'gray' }) {
  return <span className={`dj-chip dj-chip-${tone}`}>{children}</span>
}

function PageLoading() {
  return (
    <AppLayout>
      <main className="dj-page">
        <div className="dj-loading">正在读取经营数据...</div>
      </main>
    </AppLayout>
  )
}

function BlackHero({ stats, user, isHQ }: { stats: DashboardStats; user: User | null; isHQ: boolean }) {
  const purchase = Number(stats.purchase?.thisMonth || 0)
  const pending = Number(stats.pendingPayment || 0)
  const growth = stats.purchase?.growth
  const growthText = growth === null || growth === undefined ? '新月份' : `${Number(growth) >= 0 ? '↑' : '↓'} ${Math.abs(Number(growth))}% 较上月`
  const subtitle = isHQ
    ? `全集团采购 ${moneyShort(purchase)} · 待付款 ${moneyShort(pending)} · ${dayjs().format('MM月')}实时`
    : `${cleanStore(user?.store?.name)} · 待收货 ${stats.pendingReceiptCount || 0} · 库存预警 ${stats.lowStockProducts?.length || 0}`

  return (
    <section className="dj-hero">
      <div className="dj-hero-meta">
        <span>{toneLabel[user?.role || ''] || '经营中枢'} <i /> 实时</span>
        <span>{dayjs().format('HH:mm')}</span>
      </div>
      <div className="dj-hero-main">
        <strong>{moneyShort(purchase)}</strong>
        <em className={Number(growth) > 0 ? 'is-red' : 'is-green'}>{growthText}</em>
      </div>
      <p>{subtitle}</p>
      <svg className="dj-sparkline" viewBox="0 0 520 70" role="img" aria-label="经营趋势">
        <path d="M4 46 C60 38 88 42 132 34 S226 28 275 22 S360 34 420 22 S486 18 516 10" />
        <line x1="4" y1="62" x2="516" y2="62" />
      </svg>
      <div className="dj-hero-stats">
        <div>
          <span>待审批</span>
          <strong>{stats.pendingApprovalCount || 0} 项</strong>
        </div>
        <div>
          <span>逾期账期</span>
          <strong className={(stats.overdueCount || 0) > 0 ? 'is-red' : 'is-green'}>{stats.overdueCount || 0} 笔</strong>
        </div>
        <div>
          <span>库存预警</span>
          <strong className={(stats.lowStockProducts?.length || 0) > 0 ? 'is-orange' : 'is-green'}>{stats.lowStockProducts?.length || 0} 种</strong>
        </div>
      </div>
    </section>
  )
}

function MetricGrid({ stats }: { stats: DashboardStats }) {
  const purchase = Number(stats.purchase?.thisMonth || 0)
  const pending = Number(stats.pendingPayment || 0)
  return (
    <section className="dj-metric-grid">
      <article>
        <span>本月采购</span>
        <strong>{moneyShort(purchase)}</strong>
        <em>{stats.purchase?.growth == null ? '新月份' : `${stats.purchase.growth}% 环比`}</em>
      </article>
      <article>
        <span>待付款总额</span>
        <strong>{moneyShort(pending)}</strong>
        <em>含所有未付账期</em>
      </article>
      <article className={(stats.pendingReceiptCount || 0) > 0 ? 'tone-orange' : 'tone-green'}>
        <span>待收货</span>
        <strong>{stats.pendingReceiptCount || 0} 笔</strong>
        <em>入库确认</em>
      </article>
      <article className={(stats.pendingLossCount || 0) > 0 ? 'tone-red' : 'tone-green'}>
        <span>报损待处理</span>
        <strong>{stats.pendingLossCount || 0} 笔</strong>
        <em>供应商协同</em>
      </article>
    </section>
  )
}

function TodoBoard({ stats }: { stats: DashboardStats }) {
  const router = useRouter()
  const todos = [
    {
      show: (stats.overdueCount || 0) > 0,
      tone: 'red',
      chip: '立即',
      title: `${stats.overdueCount || 0} 笔账期已逾期`,
      desc: '财务需立即安排处理，避免供应商履约风险',
      action: '去财务',
      path: '/finance',
    },
    {
      show: (stats.pendingApprovalCount || 0) > 0,
      tone: 'blue',
      chip: '审批',
      title: `${stats.pendingApprovalCount || 0} 笔付款待审批`,
      desc: '凭证与账期信息已汇总，可进入审批流处理',
      action: '去审批',
      path: '/approval',
    },
    {
      show: (stats.pendingReceiptCount || 0) > 0,
      tone: 'orange',
      chip: '今日',
      title: `${stats.pendingReceiptCount || 0} 笔入库单待确认`,
      desc: '门店确认收货后自动进入账期与库存链路',
      action: '去入库',
      path: '/receipts',
    },
    {
      show: (stats.lowStockProducts?.length || 0) > 0,
      tone: 'orange',
      chip: '库存',
      title: `${stats.lowStockProducts?.length || 0} 种商品低于安全库存`,
      desc: stats.lowStockProducts?.slice(0, 3).map(p => p.name).join('、') || '需要补货',
      action: '看库存',
      path: '/inventory',
    },
  ].filter(item => item.show)

  return (
    <section className="dj-section">
      <div className="dj-section-title">
        <h2>待处理事项</h2>
        <span>{todos.length ? `${todos.length} 项` : '今日无急办'}</span>
      </div>
      {todos.length ? (
        <div className="dj-todo-list">
          {todos.map(todo => (
            <article className={`dj-todo dj-todo-${todo.tone}`} key={todo.title}>
              <div>
                <StatusChip tone={todo.tone as any}>{todo.chip}</StatusChip>
                <strong>{todo.title}</strong>
                <p>{todo.desc}</p>
              </div>
              <button onClick={() => router.push(todo.path)} type="button">{todo.action}</button>
            </article>
          ))}
        </div>
      ) : (
        <div className="dj-empty-card">暂无急办事项，今日经营链路正常。</div>
      )}
    </section>
  )
}

function StoreOverview({ stores }: { stores?: any[] }) {
  if (!stores?.length) return null
  const max = Number(stores[0]?.totalAmount || 0) || 1
  return (
    <section className="dj-section">
      <div className="dj-section-title">
        <h2>门店概览</h2>
        <span>{stores.length} 家 · 按采购额</span>
      </div>
      <div className="dj-card dj-store-list">
        {stores.slice(0, 8).map((store, index) => {
          const total = Number(store.totalAmount || 0)
          const pct = Math.max(6, Math.round(total / max * 100))
          const tone = index === 0 ? 'blue' : total > max * 0.75 ? 'green' : total < max * 0.35 ? 'orange' : 'gray'
          return (
            <article className={`dj-store-row tone-${tone}`} key={store.storeId || store.storeName}>
              <i>{index + 1}</i>
              <div>
                <div>
                  <strong>{store.storeName}</strong>
                  <span>{moneyShort(total)} · {store.orderCount || 0} 笔</span>
                </div>
                <b><em style={{ width: `${pct}%` }} /></b>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function UpcomingSchedules({ schedules }: { schedules?: any[] }) {
  const router = useRouter()
  return (
    <section className="dj-section">
      <div className="dj-section-title">
        <h2>近 7 天到期账期</h2>
        <button onClick={() => router.push('/finance')} type="button">查看全部</button>
      </div>
      <div className="dj-card dj-compact-table">
        {!schedules?.length ? (
          <div className="dj-empty-row">暂无即将到期账期</div>
        ) : schedules.map(schedule => {
          const daysLeft = dayjs(schedule.dueAt).diff(dayjs(), 'day')
          const tone = daysLeft <= 1 ? 'red' : daysLeft <= 3 ? 'orange' : 'green'
          return (
            <article key={schedule.id}>
              <div>
                <strong>{schedule.supplier?.name || '未知供应商'}</strong>
                <span>{schedule.receipt?.store?.name?.replace('滇界·', '') || '-'} · {schedule.receipt?.no || '-'}</span>
              </div>
              <div>
                <strong>{fmt(schedule.amount || 0)}</strong>
                <StatusChip tone={tone}>{daysLeft === 0 ? '今天' : daysLeft < 0 ? '逾期' : `${daysLeft} 天`}</StatusChip>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function RecentReceipts({ receipts }: { receipts?: any[] }) {
  const router = useRouter()
  return (
    <section className="dj-section">
      <div className="dj-section-title">
        <h2>最近入库记录</h2>
        <button onClick={() => router.push('/receipts')} type="button">查看全部</button>
      </div>
      <div className="dj-card dj-receipt-list">
        {!receipts?.length ? (
          <div className="dj-empty-row">暂无入库记录</div>
        ) : receipts.slice(0, 6).map(receipt => (
          <article key={receipt.id}>
            <div>
              <strong>{receipt.no}</strong>
              <span>{receipt.store?.name?.replace('滇界·', '') || '-'} · {receipt.supplier?.name || '-'}</span>
            </div>
            <div>
              <strong>{fmt(receipt.totalAmount || 0)}</strong>
              <span>{dayjs(receipt.createdAt).format('MM/DD')}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function CostStructurePreview({ stats }: { stats: DashboardStats }) {
  const pending = Number(stats.pendingPayment || 0)
  const purchase = Number(stats.purchase?.thisMonth || 0)
  const overdue = Number(stats.overdueCount || 0)
  const inventory = Number(stats.lowStockProducts?.length || 0)
  const total = Math.max(pending + purchase + overdue * 10000 + inventory * 1000, 1)
  const parts = [
    { label: '采购', value: purchase, className: 's1' },
    { label: '待付款', value: pending, className: 's2' },
    { label: '逾期风险', value: overdue * 10000, className: 's3' },
    { label: '库存风险', value: inventory * 1000, className: 's4' },
  ]
  return (
    <section className="dj-section">
      <div className="dj-section-title">
        <h2>经营链路结构</h2>
        <span>采购 → 入库 → 账期</span>
      </div>
      <div className="dj-card dj-structure-card">
        <div className="dj-stacked">
          {parts.map(part => <i className={part.className} key={part.label} style={{ width: `${Math.max(8, part.value / total * 100)}%` }} />)}
        </div>
        <div className="dj-legend">
          {parts.map(part => (
            <span key={part.label}>
              <i className={part.className} />
              {part.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({})
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    const fallback = window.setTimeout(() => {
      if (mounted) setLoading(false)
    }, 8000)
    const raw = localStorage.getItem('dj_user')
    if (raw) {
      try {
        if (mounted) setUser(JSON.parse(raw))
      } catch {
        localStorage.removeItem('dj_user')
      }
    }
    load().finally(() => window.clearTimeout(fallback))
    return () => {
      mounted = false
      window.clearTimeout(fallback)
    }
  }, [])

  const load = async () => {
    try {
      const response = await api.get('/api/dashboard/stats')
      setStats(response.data || {})
    } catch {
      setStats({})
    } finally {
      setLoading(false)
    }
  }

  const isHQ = user?.role !== 'MANAGER'
  const pageTitle = isHQ ? '集团经营中枢' : `${cleanStore(user?.store?.name)}工作台`
  const pageSub = isHQ ? '老板 / 财务一眼看清采购、入库、账期和风险' : '店长按待办优先级处理门店经营链路'

  const health = useMemo(() => {
    const risk = Number(stats.overdueCount || 0) + Number(stats.pendingLossCount || 0)
    if (risk > 0) return { text: '存在风险', tone: 'red' }
    if ((stats.pendingReceiptCount || 0) > 0 || (stats.lowStockProducts?.length || 0) > 0) return { text: '今日关注', tone: 'orange' }
    return { text: '运行健康', tone: 'green' }
  }, [stats])

  if (loading) return <PageLoading />

  return (
    <AppLayout>
      <main className="dj-page">
        <header className="dj-topbar">
          <div>
            <span>{dayjs().format('YYYY年MM月DD日')} · {toneLabel[user?.role || ''] || '经营视角'}</span>
            <h1>{pageTitle}</h1>
            <p>{pageSub}</p>
          </div>
          <StatusChip tone={health.tone as any}>{health.text}</StatusChip>
        </header>

        <BlackHero stats={stats} user={user} isHQ={isHQ} />
        <MetricGrid stats={stats} />
        <TodoBoard stats={stats} />

        <div className="dj-dashboard-grid">
          <div>
            {isHQ ? <StoreOverview stores={stats.storeBreakdown} /> : <RecentReceipts receipts={stats.recentReceipts} />}
            <CostStructurePreview stats={stats} />
          </div>
          <div>
            <UpcomingSchedules schedules={stats.upcomingSchedules} />
            {isHQ ? <RecentReceipts receipts={stats.recentReceipts} /> : <StoreOverview stores={stats.storeBreakdown} />}
          </div>
        </div>
      </main>
    </AppLayout>
  )
}
