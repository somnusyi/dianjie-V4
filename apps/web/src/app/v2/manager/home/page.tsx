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
  const [dailyReportState, setDailyReportState] = useState<'PENDING' | 'OVERDUE' | 'CONFIRMED' | null>(null)
  const [pendingLoss, setPendingLoss] = useState<LossClaim[] | null>(null)
  const [pendingInv, setPendingInv] = useState<any[] | null>(null)
  const [myDocs, setMyDocs] = useState<DocItem[] | null>(null)
  const { data, error } = useDashboard()

  useEffect(() => {
    // 每日上午 11 点前提交前一营业日两表；后端统一按北京时间判断逾期。
    apiFetch<{ state: 'PENDING' | 'OVERDUE' | 'CONFIRMED' }>('/api/daily-business-imports/status')
      .then(result => setDailyReportState(result.state))
      .catch(() => setDailyReportState(null))
    // 本店报损待处理 (店长视角看自己店的报损)
    apiFetch<{ items: LossClaim[] }>('/api/loss-claims?page=1&pageSize=10')
      .then(result => setPendingLoss((result.items || []).filter(r => r.status === 'PENDING' || r.status === 'NEGOTIATING')))
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
  const isLate = dailyReportState === 'OVERDUE'
  const showRecordReminder = dailyReportState === 'PENDING' || dailyReportState === 'OVERDUE'

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

      {/* 每日 1 件事：上午 11 点前上传前一日营业与菜品两表 */}
      {showRecordReminder && (
        <a href="/v2/manager/upload-platform"
           className={`mx-4 mt-3 flex items-center gap-3 rounded-card px-3 py-3 ${
             isLate ? 'bg-red text-white' : 'bg-amber/10 border border-amber/30'
           }`}>
          <span className={`w-9 h-9 rounded-full flex items-center justify-center text-h2 ${
            isLate ? 'bg-white/20' : 'bg-amber text-white'
          }`}>⇪</span>
          <div className="flex-1">
            <div className={`text-button ${isLate ? '' : 'text-amber-fg'}`}>
              {isLate ? '昨日营业日报已逾期' : '请上传昨日营业日报'}
            </div>
            <div className={`text-micro mt-0.5 ${isLate ? 'text-white/70' : 'text-gray2'}`}>
              {isLate ? '已超过上午 11 点，请尽快上传两表并确认' : '综合营业统计 + 菜品销售明细，预览后确认'}
            </div>
          </div>
          <span className={isLate ? 'text-white' : 'text-gray3'}>›</span>
        </a>
      )}
      {dailyReportState === 'CONFIRMED' && (
        <div className="mx-4 mt-3 flex items-center gap-2 px-3 py-2">
          <span className="text-green-fg">✓</span>
          <span className="text-caption text-gray2">昨日营业日报已确认，销量与库存已同步</span>
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

      <InventoryOverviewCard inventory={data.inventorySummary} />

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

function InventoryOverviewCard({ inventory }: { inventory: NonNullable<ReturnType<typeof useDashboard>['data']>['inventorySummary'] }) {
  const available = inventory?.status === 'AVAILABLE'
  const asOf = inventory?.asOf
    ? new Date(inventory.asOf).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <Section title="库存概况" right={available && asOf ? `更新 ${asOf}` : '实时账面预估'}>
      {available ? (
        <a href="/v2/manager/inventory"
           className="block overflow-hidden rounded-card border border-border bg-white active:bg-bg/50">
          <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
            <div>
              <div className="text-caption text-gray2">实时预估库存金额</div>
              <div className="font-num text-[28px] leading-tight mt-1">
                ¥{Number(inventory.totalValue || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="text-micro text-gray3 mt-1">最近盘点基准 + 收货 − BOM/人工消耗 − 门店报损</div>
            </div>
            <span className="shrink-0 rounded-chip bg-green-bg px-2 py-1 text-micro text-green-fg">实时预估</span>
          </div>

          <div className="grid grid-cols-3 border-y border-border bg-bg/40">
            <InventoryStat label="预计品项" value={`${inventory.itemCount}`} unit="种" />
            <InventoryStat label="预计有库存" value={`${inventory.nonzeroCount}`} unit="种" />
            <InventoryStat label="预计为 0" value={`${inventory.zeroCount}`} unit="种" tone={inventory.zeroCount > 0 ? 'red' : undefined} />
          </div>

          <div className="flex items-center gap-2 px-4 py-3">
            <span className={`w-2 h-2 rounded-full ${inventory.unmatchedCount > 0 ? 'bg-amber' : 'bg-green'}`} />
            <span className="text-caption text-gray2 flex-1">
              {inventory.unmatchedCount > 0
                ? `${inventory.unmatchedCount} 个盘点品项待匹配，暂不计入实时预估`
                : '预计库存已按最新收货、消耗和报损滚动计算'}
            </span>
            <span className="text-gray3">›</span>
          </div>
        </a>
      ) : (
        <a href="/v2/manager/inventory"
           className="flex items-center gap-3 rounded-card border border-amber/30 bg-amber/10 px-4 py-4">
          <span className="w-10 h-10 shrink-0 rounded-full bg-amber text-white flex items-center justify-center text-h2">库</span>
          <div className="flex-1">
            <div className="text-button text-amber-fg">盘点基准待导入</div>
            <div className="text-caption text-gray2 mt-0.5">暂不展示历史累计入库推算值，避免库存虚高</div>
          </div>
          <span className="text-gray3">›</span>
        </a>
      )}
    </Section>
  )
}

function InventoryStat({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: 'red' }) {
  return (
    <div className="px-3 py-3 text-center border-r border-border last:border-r-0">
      <div className="text-micro text-gray3">{label}</div>
      <div className={`font-num text-h2 mt-0.5 ${tone === 'red' ? 'text-red-fg' : 'text-ink'}`}>
        {value}<span className="text-micro font-normal ml-0.5">{unit}</span>
      </div>
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
