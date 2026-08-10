/**
 * 厨师长 App · 采购 Tab  PDF: chef_purchasing_tab  Tab 3/4
 * 接真实 GET /api/orders 显示进行中 + 待验收
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, ProgressDots, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { apiFetch } from '@/lib/v2-auth'
import dayjs from 'dayjs'

const STATUS_TO_STEP: Record<string, number> = {
  DRAFT: 0, SUBMITTED: 1, CONFIRMED: 2, DELIVERING: 3,
  PENDING_CONFIRM: 4, RECEIVED: 5, COMPLETED: 5, CANCELLED: -1,
}
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿', SUBMITTED: '待接单', CONFIRMED: '已接单',
  DELIVERING: '配送中', PENDING_CONFIRM: '待验收',
  RECEIVED: '已收货', COMPLETED: '已完成', CANCELLED: '已取消',
}

export default function ChefPurchasePage() {
  const [tab, setTab] = useState('purchase')
  const [orders, setOrders] = useState<any[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(new Date())

  async function loadPage(page = 1) {
    if (page > 1) setLoadingMore(true)
    try {
      const d = await apiFetch<{ items: any[]; total: number }>(`/api/orders?page=${page}&pageSize=50`)
      const next = (d as any).items || (d as any) || []
      setOrders(current => page === 1 ? next : [...(current || []), ...next])
      setTotal(Number((d as any).total ?? next.length))
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => { void loadPage() }, [])

  if (error) return <ErrorScreen message={error} />
  const allOrders = orders || []
  const monthStart = dayjs().startOf('month').toDate()
  const monthOrders = allOrders.filter(o => new Date(o.createdAt) >= monthStart)
  const monthTotal = monthOrders.reduce((s, o) => s + Number(o.totalAmount || 0), 0)
  const toReceive = allOrders.filter(o => o.status === 'PENDING_CONFIRM')
  const pendingRevisionOrders = allOrders.filter(o => o.revisions?.some((revision: any) => revision.status === 'PENDING'))
  const inProgress = allOrders.filter(o => ['SUBMITTED','CONFIRMED','DELIVERING'].includes(o.status))
  const inTransitTotal = inProgress.reduce((s, o) => s + Number(o.totalAmount || 0), 0)
  const history = allOrders
    .filter(o => ['COMPLETED', 'RECEIVED', 'CANCELLED'].includes(o.status))
  const hasMore = orders !== null && allOrders.length < total

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">采购</h1>
          <p className="text-caption text-gray3">本月 {monthOrders.length} 单 · 总额 ¥{(monthTotal/1000).toFixed(1)}K</p>
        </div>
        <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌧</button>
      </header>

      <div className="mt-3">
        <GlanceStrip
          label="本月采购"
          value={`¥${monthTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          delta={{ text: `${monthOrders.length} 单`, trend: 'flat' }}
          rightSlot={dayjs().format('MM 月')}
          stats={[
            { label: '在途金额', value: `¥${(inTransitTotal/1000).toFixed(1)}K`, tone: 'default' },
            { label: '改单待确认', value: `${pendingRevisionOrders.length} 单`, tone: pendingRevisionOrders.length > 0 ? 'red' : 'default' },
            { label: '待验收',   value: `${toReceive.length} 单`, tone: toReceive.length > 0 ? 'red' : 'default' },
          ]}
        />
      </div>

      {/* 待确认改单：供应商在接单前提出修改，必须由门店明确确认 */}
      {pendingRevisionOrders.length > 0 && (
        <Section title="改单待确认" right={`${pendingRevisionOrders.length} 单阻塞接单`} rightTone="red">
          <ul className="space-y-2">
            {pendingRevisionOrders.map(o => {
              const revision = o.revisions.find((item: any) => item.status === 'PENDING')
              return (
                <li key={`revision-${o.id}`} className="relative bg-red-bg/40 rounded-card p-3 pl-4 border border-red/40 before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-red">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <Chip tone="red">待确认</Chip>
                        <span className="text-h2 truncate">{o.supplier?.name}</span>
                      </div>
                      <p className="text-micro text-gray3 mt-1">#{o.no} · 第 {revision?.revisionNo} 次改单</p>
                    </div>
                    <span className="font-num text-h2 shrink-0">¥{Number(o.totalAmount).toLocaleString()}</span>
                  </div>
                  <p className="text-caption text-gray2 mb-2 line-clamp-2">
                    {revision?.requestedBy?.name || '供应商'}：{revision?.reason || '申请调整订单'}
                  </p>
                  <a href={`/v2/chef/purchase/po-success/${o.id}`} className="block w-full py-2 bg-ink text-white rounded-cta text-button text-center">立即核对改单</a>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {/* 待验收 */}
      {toReceive.length > 0 && (
        <Section title="待验收" right={`${toReceive.length} 单需当日核对`} rightTone="red">
          <ul className="space-y-2">
            {toReceive.map(o => (
              <li key={o.id} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-red">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-h2">{o.supplier?.name} <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span></span>
                  <span className="font-num text-h2">¥{Number(o.totalAmount).toLocaleString()}</span>
                </div>
                <p className="text-caption text-gray3 mb-2">
                  {o.items?.length ?? 0} 项
                  {o.shippedAt && ` · 送达 ${new Date(o.shippedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}
                </p>
                <a href={`/v2/chef/purchase/${o.id}/receive`} className="block w-full py-2 bg-ink text-white rounded-cta text-button text-center">去验收</a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 发起新采购单 */}
      <Section title="发起新采购单">
        <a href="/v2/chef/purchase/new" className="flex items-center gap-3 bg-white rounded-card border border-border p-4">
          <span className="w-10 h-10 rounded-full bg-ink text-white flex items-center justify-center text-h1">+</span>
          <div className="flex-1">
            <div className="text-h2">发起新采购单</div>
            <p className="text-micro text-gray3">食材 · 调味 · 干货 · 包材</p>
            <p className="text-micro text-gray3 mt-0.5">提交后直发供应商, 任何金额都无审批门槛</p>
          </div>
          <span className="text-gray3">›</span>
        </a>
      </Section>

      {/* 进行中 */}
      <Section title="进行中" right={inProgress.length > 0 ? `${inProgress.length} 单 · ¥${(inTransitTotal/1000).toFixed(1)}K` : ''}>
        <ul className="space-y-2">
          {orders === null && <li className="text-caption text-gray3 text-center py-4">加载中…</li>}
          {orders && inProgress.length === 0 && <li className="text-caption text-gray3 text-center py-4">暂无进行中订单</li>}
          {inProgress.map((o) => {
            const stepIdx = STATUS_TO_STEP[o.status] ?? 1
            const showAckBtn = o.status === 'DELIVERING'
            const pendingRevision = o.revisions?.find((revision: any) => revision.status === 'PENDING')
            return (
              <li key={o.id} className={`bg-white rounded-card border p-3 ${pendingRevision ? 'border-red/50 ring-1 ring-red/10' : 'border-border'}`}>
                <a href={`/v2/chef/purchase/po-success/${o.id}`} className="block">
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-h2 flex items-center gap-1 min-w-0 flex-wrap">
                      <span className="truncate">{o.supplier?.name}</span>
                      {o.createdBy?.role === 'CHEF_DIRECTOR' && (
                        <Chip tone="amber">总厨代下</Chip>
                      )}
                      {pendingRevision && <Chip tone="red">改单待确认</Chip>}
                      <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span>
                    </span>
                    <span className="font-num text-h2 shrink-0">¥{Number(o.totalAmount).toLocaleString()}</span>
                  </div>
                  <p className="text-micro text-gray3 mb-2">
                    {pendingRevision ? '等待你确认改单' : STATUS_LABEL[o.status]} · {o.items?.length ?? 0} 项
                    · 期望 {dayjs(o.expectedDate).format('MM/DD')}
                  </p>
                  <ProgressDots
                    steps={[
                      { label: '已发起' }, { label: '接单' }, { label: '在途' },
                      { label: '送达' }, { label: '验收' },
                    ]}
                    currentIndex={stepIdx}
                  />
                </a>
                {/* DELIVERING (在途) 期间显示发验收单入口 */}
                {showAckBtn && (
                  <div className="mt-2 pt-2 border-t border-border">
                    {o.chefAckAt ? (
                      <div className="text-caption text-gray2">
                        ✓ 验收单已发 <span className="text-gray3">({o.chefAckImages?.length || 0} 张, {new Date(o.chefAckAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}) · 等供应商确认</span>
                        <a href={`/v2/chef/purchase/${o.id}/ack`} className="ml-2 text-amber-fg">重发 ›</a>
                      </div>
                    ) : (
                      <a href={`/v2/chef/purchase/${o.id}/ack`}
                        className="block w-full py-2 bg-amber/10 text-amber-fg text-button rounded-cta text-center">
                        📷 货已收到? 发验收单给供应商
                      </a>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </Section>

      {/* 历史 (已完成 / 已取消) */}
      {history.length > 0 && (
        <Section title="历史订单" right={`已显示 ${history.length} 单`}>
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {history.map(o => (
              <li key={o.id}>
                <a href={`/v2/chef/purchase/po-success/${o.id}`} className="block px-3 py-2.5">
                  <div className="flex items-center gap-2 mb-0.5">
                    <Chip tone={o.status === 'CANCELLED' ? 'gray' : 'green'}>
                      {STATUS_LABEL[o.status] || o.status}
                    </Chip>
                    <span className="text-micro text-gray3 ml-auto">{dayjs(o.createdAt).format('MM/DD')}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-body truncate">{o.supplier?.name}</span>
                    <span className="font-num text-body">¥{Number(o.totalAmount).toLocaleString()}</span>
                  </div>
                  <p className="text-micro text-gray3 truncate">#{o.no} · {o.items?.length ?? 0} 项</p>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hasMore && (
        <div className="px-4 mt-3">
          <button
            type="button"
            onClick={() => void loadPage(Math.floor(allOrders.length / 50) + 1)}
            disabled={loadingMore}
            className="w-full py-3 bg-white rounded-card border border-border text-caption text-amber-fg disabled:opacity-50"
          >
            {loadingMore ? '加载中…' : `加载更多历史订单 · 已显示 ${allOrders.length}/${total}`}
          </button>
        </div>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '工作台', icon: '⌂' },
          { key: 'inventory', label: '库存', icon: '⛁' },
          { key: 'purchase', label: '采购', icon: '☰', badge: pendingRevisionOrders.length },
          { key: 'check', label: '盘点', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')      location.href = '/v2/chef/home'
          if (k === 'inventory') location.href = '/v2/chef/inventory'
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
function ErrorScreen({ message }: { message: string }) {
  return <div className="min-h-screen bg-bg flex items-center justify-center p-6"><div className="bg-red-bg text-red-fg rounded-card p-4">{message}</div></div>
}
