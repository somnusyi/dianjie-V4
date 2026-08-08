/**
 * 内部供应链 · 移动端工作台 v2
 *
 * 设计原则（与 manager/chef/chef-director/supplier 保持一致）：
 * - 紧凑问候/标题，拒绝巨大标题占满首屏
 * - 今日待办优先：待接单、待发货、配送中、异常差异
 * - 常用入口用 2×2 紧凑网格，二级功能收进“更多”
 * - 库存健康摘要轻量呈现，不做历史累计大卡
 * - 底部导航 4 Tab：工作台 / 订单 / 库存 / 更多
 */
'use client'

import { useEffect, useState } from 'react'
import { TodoCard } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type OrderRow = {
  id: string
  no: string
  status: string
  totalAmount: number | string
  createdAt: string
  expectedDate?: string
  store?: { id: string; name: string } | null
  supplier?: { id: string; name: string } | null
  items?: any[]
}

type DiffRow = {
  id: string
  no: string
  status: string
  createdAt: string
  store?: { name: string } | null
  supplier?: { name: string } | null
  totalAmount?: number | string
}

type WarehouseInventoryResponse = {
  summary: { totalSku: number }
  items: Array<{ statusFlag: 'OK' | 'LOW' | 'OUT' | 'SHADOW_GAP' }>
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '待接单',
  CONFIRMED: '待发货',
  DELIVERING: '配送中',
  PENDING_CONFIRM: '待签收',
}

const STATUS_TONE: Record<string, 'red' | 'orange' | 'green' | 'gray'> = {
  SUBMITTED: 'red',
  CONFIRMED: 'orange',
  DELIVERING: 'green',
  PENDING_CONFIRM: 'gray',
}

export default function InternalSupplyChainHomePage() {
  const { data, error } = useDashboard()
  const [orders, setOrders] = useState<OrderRow[] | null>(null)
  const [diffs, setDiffs] = useState<DiffRow[] | null>(null)
  const [invSummary, setInvSummary] = useState<{
    totalSku: number
    lowStock: number
    outOfStock: number
  } | null>(null)

  useEffect(() => {
    apiFetch<any>('/api/orders?pageSize=50')
      .then((d: any) => setOrders(d.items || d || []))
      .catch(() => setOrders([]))
    apiFetch<{ items: DiffRow[] }>('/api/loss-claims?page=1&pageSize=20&isManual=false&status=PENDING')
      .then((d: any) => setDiffs(d.items || d || []))
      .catch(() => setDiffs([]))
    apiFetch<WarehouseInventoryResponse>('/api/warehouse-inventory?page=1&pageSize=200')
      .then(d => setInvSummary({
        totalSku: d.summary.totalSku,
        lowStock: d.items.filter(item => item.statusFlag === 'LOW').length,
        outOfStock: d.items.filter(item => item.statusFlag === 'OUT').length,
      }))
      .catch(() => setInvSummary(null))
  }, [])

  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)

  const actionCounts = {
    submitted: (orders || []).filter(o => o.status === 'SUBMITTED').length,
    confirmed: (orders || []).filter(o => o.status === 'CONFIRMED').length,
    delivering: (orders || []).filter(o => o.status === 'DELIVERING').length,
    pendingConfirm: (orders || []).filter(o => o.status === 'PENDING_CONFIRM').length,
  }
  const todoCount = actionCounts.submitted + actionCounts.confirmed + actionCounts.delivering

  const pendingDiffs = (diffs || []).filter(d => d.status === 'PENDING').slice(0, 3)
  const inProgressOrders = (orders || []).filter(o =>
    ['SUBMITTED', 'CONFIRMED', 'DELIVERING'].includes(o.status)
  ).slice(0, 3)

  const heroStats: Array<{
    label: string
    value: string
    tone: 'red' | 'orange' | 'green' | 'accent' | 'default'
  }> = [
    { label: '服务门店', value: `${(data.supplyChain?.stores || []).length} 家`, tone: 'default' },
    { label: '在途', value: String(actionCounts.delivering), tone: 'orange' },
    { label: '待签收', value: String(actionCounts.pendingConfirm), tone: actionCounts.pendingConfirm > 0 ? 'orange' : 'default' },
  ]

  return (
    <div className="min-h-screen bg-bg pb-20 lg:pb-8">
      {/* 紧凑头部 */}
      <header className="flex items-center justify-between px-4 pb-2 pt-4 lg:px-8 lg:pt-7">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">供应链工作台</h1>
          <p className="text-caption text-gray3 mt-0.5">{today}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center" aria-label="搜索">⌕</button>
          <UserMenu />
        </div>
      </header>

      {/* Glance 数据条 */}
      <div className="mt-3 lg:px-4">
        <GlanceStrip
          label="今日在途履约"
          value={`${actionCounts.delivering} 单配送中`}
          meta={`待接单 ${actionCounts.submitted} · 待发货 ${actionCounts.confirmed}`}
          stats={heroStats}
        />
      </div>

      {/* 待办 — 真正需要动作的事项 */}
      <Section
        title="待办"
        right={todoCount > 0 ? `${todoCount} 项需处理` : undefined}
        rightTone={todoCount > 0 ? 'red' : undefined}
      >
        <div className="space-y-2">
          {orders === null && diffs === null && (
            <p className="text-caption text-gray3 text-center py-4">加载中…</p>
          )}
          {orders !== null && diffs !== null && todoCount === 0 && pendingDiffs.length === 0 && (
            <p className="text-caption text-gray3 text-center py-4">✓ 今日无加急</p>
          )}

          {/* 订单待办 */}
          {inProgressOrders.map(o => (
            <TodoCard
              key={o.id}
              tone={o.status === 'SUBMITTED' ? 'immediate' : o.status === 'CONFIRMED' ? 'today' : 'routine'}
              chips={[
                { label: STATUS_LABEL[o.status] || o.status, tone: STATUS_TONE[o.status] || 'gray' },
                { label: `#${o.no}`, tone: 'gray' },
              ]}
              title={`${o.supplier?.name || '供应商'} → ${o.store?.name || '门店'} · ${o.items?.length ?? 0} 项`}
              sub={`¥${Math.round(Number(o.totalAmount || 0)).toLocaleString()} · 期望 ${o.expectedDate?.slice(5, 10).replace('-', '/') || '—'}`}
              primary={{ label: '去处理', onClick: () => { location.href = `/v2/supply-chain/fulfillment/${o.id}` } }}
            />
          ))}

          {/* 差异待办 */}
          {pendingDiffs.map(d => (
            <TodoCard
              key={d.id}
              tone="immediate"
              chips={[{ label: '到货差异', tone: 'red' }, { label: `#${d.no}`, tone: 'gray' }]}
              title={`${d.supplier?.name || '供应商'} → ${d.store?.name || '门店'}`}
              sub="短量/破损/报损待确认"
              primary={{ label: '去确认', onClick: () => { location.href = '/v2/supply-chain/differences' } }}
            />
          ))}
        </div>
      </Section>

      {/* 库存健康摘要 — 轻量，不占满屏 */}
      {invSummary && (
        <Section title="库存健康">
          <a
            href="/v2/supply-chain/inventory"
            className="block bg-white rounded-card border border-border p-3 active:bg-bg/50"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center text-h2">仓</span>
                <div>
                  <div className="text-h2">{invSummary.totalSku} 个 SKU</div>
                  <div className="text-caption text-gray2">
                    {invSummary.lowStock > 0 && (
                      <span className="text-orange-fg">{invSummary.lowStock} 个低库存</span>
                    )}
                    {invSummary.lowStock > 0 && invSummary.outOfStock > 0 && ' · '}
                    {invSummary.outOfStock > 0 && (
                      <span className="text-red-fg">{invSummary.outOfStock} 个缺货</span>
                    )}
                    {invSummary.lowStock === 0 && invSummary.outOfStock === 0 && '库存充足'}
                  </div>
                </div>
              </div>
              <span className="text-gray3">›</span>
            </div>
          </a>
        </Section>
      )}

      {/* 常用入口 — 2×2 紧凑网格 */}
      <Section title="常用入口">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <QuickEntry href="/v2/supply-chain/fulfillment" icon="☷" label="订单中心" desc="待处理、配送与签收" tone="amber" />
          <QuickEntry href="/v2/supply-chain/stores" icon="店" label="门店运营" desc="订货、收货、消耗" tone="green" />
          <QuickEntry href="/v2/supply-chain/inventory" icon="仓" label="仓库库存" desc="库存、入库、批次" tone="default" />
          <QuickEntry href="/v2/supply-chain/products" icon="品" label="商品管理" desc="SKU、分类、报价" tone="default" />
        </div>
      </Section>

      {/* 二级功能 — 收进“更多”列表 */}
      <Section title="更多">
        <div className="grid gap-2 lg:grid-cols-2">
          <MoreItem href="/v2/supply-chain/differences" label="到货差异" desc="短量、破损与报损" />
          <MoreItem href="/v2/supply-chain/suppliers" label="上游供应商" desc="总仓采购合作方" />
          <MoreItem href="/v2/supply-chain/billing" label="账务查询" desc="账期、对账与发票" />
          <MoreItem href="/v2/supply-chain/analytics" label="经营分析" desc="门店、SKU、趋势与健康" />
          <MoreItem href="/v2/supply-chain/receipts" label="收货查询" desc="历史收货记录" />
          <MoreItem href="/v2/supply-chain/orders" label="订货查询" desc="历史订货记录" />
        </div>
      </Section>

    </div>
  )
}

/* ─── 子组件 ─── */

function Section({ title, right, rightTone, children }: {
  title: string
  right?: string
  rightTone?: 'red' | 'orange'
  children: React.ReactNode
}) {
  return (
    <section className="mt-5 px-4 lg:px-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && (
          <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : rightTone === 'orange' ? 'text-orange-fg' : 'text-gray3'}`}>
            {right}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function QuickEntry({ href, icon, label, desc, tone }: {
  href: string
  icon: string
  label: string
  desc: string
  tone?: 'amber' | 'green' | 'default'
}) {
  const toneCls =
    tone === 'amber' ? 'bg-amber/10 text-amber-fg' :
    tone === 'green' ? 'bg-green/10 text-green-fg' :
    'bg-bg text-gray1'
  return (
    <a href={href} className="block bg-white rounded-card border border-border p-3 active:bg-bg/50">
      <div className="flex items-center gap-3">
        <span className={`w-9 h-9 rounded-md flex items-center justify-center text-h2 ${toneCls}`}>{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-h2">{label}</div>
          <p className="text-micro text-gray3 truncate">{desc}</p>
        </div>
      </div>
    </a>
  )
}

function MoreItem({ href, label, desc }: { href: string; label: string; desc: string }) {
  return (
    <a href={href} className="flex items-center gap-3 bg-white rounded-card border border-border p-3 active:bg-bg/50">
      <div className="flex-1 min-w-0">
        <div className="text-h2">{label}</div>
        <p className="text-caption text-gray2">{desc}</p>
      </div>
      <span className="text-gray3">›</span>
    </a>
  )
}
