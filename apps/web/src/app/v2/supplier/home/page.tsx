/**
 * 供应商 App · 首页 v2
 *
 * Hero: 应收总额 + 在途 + 本月已交付 + 回款率
 * 卡片: 应收账期分桶 / 库存预警 / 待办订单 / 客户分析入口 / SKU 销售榜入口 / 商品报价表入口
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'
import { supplierOrderBucket } from '@/lib/supplier-domain'

type Order = {
  id: string; no: string; status: string; totalAmount: number | string
  createdAt: string; expectedDate: string
  store: { id: string; name: string }
  items?: any[]
  chefAckAt?: string | null      // DELIVERING 期间客户发的验收单 (有值=待供应商确认)
  chefAckImages?: string[]
}
type StockSummary = { totalSku: number; lowStock: number; outOfStock: number; reservedValue: number }
type SupplyAudit = { summary: { errors: number; warnings: number }; issues: Array<{ label: string; detail: string }> }

function timeAgo(iso: string) {
  const d = new Date(iso).getTime()
  const min = Math.round((Date.now() - d) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min/60)} 小时前`
  const dd = new Date(iso)
  return `${String(dd.getMonth()+1).padStart(2,'0')}/${String(dd.getDate()).padStart(2,'0')}`
}

export default function SupplierHomePage() {
  const [tab, setTab] = useState('home')
  const { data, error } = useDashboard()
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [stockSummary, setStockSummary] = useState<StockSummary | null>(null)
  const [supplyAudit, setSupplyAudit] = useState<SupplyAudit | null>(null)
  useEffect(() => {
    apiFetch<any>('/api/orders?pageSize=20')
      .then((d: any) => setOrders((d.items || d || [])))
      .catch(() => setOrders([]))
    apiFetch<StockSummary>('/api/supplier/stock/summary')
      .then(setStockSummary).catch(() => setStockSummary(null))
    apiFetch<SupplyAudit>('/api/supplier/insights/audit?days=90')
      .then(setSupplyAudit).catch(() => setSupplyAudit(null))
  }, [])
  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)
  const ext = (data.hero as any)?.supplierExt || {}
  // 待处理 = 需要供应商动作的订单:
  //   SUBMITTED      → 待接单
  //   CONFIRMED      → 待发货
  //   DELIVERING + chefAckAt → 客户已发验收单, 待供应商确认送达 (2026-05-29 客户反馈)
  // 已发货等门店签收 (PENDING_CONFIRM) 不算待处理
  const pending = (orders || []).filter(o =>
    ['SUBMITTED', 'CONFIRMED'].includes(o.status) ||
    (o.status === 'DELIVERING' && o.chefAckAt)
  )
  // 在途 = 已发货等门店签收
  const shipping = (orders || []).filter(o =>
    supplierOrderBucket(o.status) === 'shipping' && !(o.status === 'DELIVERING' && o.chefAckAt)
  )
  const lowStockCnt = stockSummary
    ? stockSummary.lowStock + stockSummary.outOfStock
    : Number(ext.lowStockCnt || 0)

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">{greeting}</p>
          <h1 className="text-h1">{data.supplier?.name || '供应商'}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Chip tone="green">合作伙伴</Chip>
            <span className="text-micro text-gray3">{today}</span>
          </div>
        </div>
        <UserMenu />
      </header>

      <div className="mt-3">
        <GlanceStrip {...(data.hero as any)} />
      </div>

      {/* 应收账期分桶 — 顶尖供应商最关心 */}
      <Section title="应收账期" right={ext.arOverdue > 0 ? `⚠ 逾期 ¥${Math.round(ext.arOverdue).toLocaleString()}` : undefined} rightTone={ext.arOverdue > 0 ? 'red' : undefined}>
        <div className="bg-white rounded-card border border-border p-3 grid grid-cols-3 gap-2">
          <Bucket label="逾期" amount={ext.arOverdue || 0} tone={ext.arOverdue > 0 ? 'red' : 'gray'} />
          <Bucket label="7 天内到" amount={ext.ar7d || 0} tone={ext.ar7d > 0 ? 'orange' : 'gray'} />
          <Bucket label="30 天内到" amount={ext.ar30d || 0} tone="default" />
        </div>
        <a href="/v2/supplier/billing" className="block mt-2 text-center py-2 text-caption text-amber-fg">查看账期日历 ›</a>
      </Section>

      {/* 库存预警 */}
      {(lowStockCnt > 0 || ext.expiringCnt > 0) && (
        <Section title="库存预警" right="点击去库存处理" rightTone="red">
          <a href="/v2/supplier/inventory" className="block bg-red-bg/30 rounded-card border border-red/30 p-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚠</span>
              <div className="flex-1">
                {lowStockCnt > 0 && <div className="text-body"><b className="text-red-fg">{lowStockCnt}</b> 个 SKU 的可用库存低于安全线，请尽快补货</div>}
                {ext.expiringCnt > 0 && <div className="text-body"><b className="text-orange-fg">{ext.expiringCnt}</b> 批商品 7 天内到期,请尽快出货</div>}
              </div>
              <span className="text-gray3">›</span>
            </div>
          </a>
        </Section>
      )}

      {supplyAudit && (supplyAudit.summary.errors > 0 || supplyAudit.summary.warnings > 0) && (
        <Section
          title="数据健康待办"
          right={supplyAudit.summary.errors > 0 ? `${supplyAudit.summary.errors} 项错误` : `${supplyAudit.summary.warnings} 项提醒`}
          rightTone={supplyAudit.summary.errors > 0 ? 'red' : undefined}
        >
          <a href="/v2/supplier/analytics" className={`block rounded-card border p-3 ${supplyAudit.summary.errors > 0 ? 'border-red/30 bg-red-bg/30' : 'border-amber/30 bg-amber/10'}`}>
            <div className="flex items-start gap-3">
              <span className="text-2xl">{supplyAudit.summary.errors > 0 ? '⚠' : '◐'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-body">库存账本、预占、配送与应付自动核查发现待处理项</div>
                {supplyAudit.issues[0] && <p className="mt-1 truncate text-caption text-gray2">{supplyAudit.issues[0].label} · {supplyAudit.issues[0].detail}</p>}
              </div>
              <span className="text-gray3">›</span>
            </div>
          </a>
        </Section>
      )}

      {/* 待处理订单 — 供应商需要动作 (接单 / 发货) */}
      <Section title="待处理订单" right={pending.length > 0 ? `${pending.length} 单待你处理` : undefined} rightTone={pending.length > 0 ? 'red' : undefined}>
        {orders === null && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {orders !== null && pending.length === 0 && (
          <p className="text-caption text-gray3 text-center py-4">✓ 全部已处理</p>
        )}
        <ul className="space-y-2">
          {pending.slice(0, 5).map(o => {
            // 3 种待处理状态分别配 label/cta/颜色
            const isSubmitted = o.status === 'SUBMITTED'
            const isAckPending = o.status === 'DELIVERING' && o.chefAckAt
            const tone: 'red' | 'orange' | 'amber' = isSubmitted ? 'red' : isAckPending ? 'amber' : 'orange'
            const label = isSubmitted ? '待接单'
                        : isAckPending ? '📷 验收单待确认'
                                       : '待发货'
            const cta = isSubmitted ? '去接单 ›'
                      : isAckPending ? '查看验收单 ›'
                                     : '去发货 ›'
            const stripeCls = isSubmitted ? 'before:bg-red'
                            : isAckPending ? 'before:bg-amber'
                                           : 'before:bg-orange'
            return (
              <li key={o.id}
                  onClick={() => location.href = `/v2/supplier/orders/${o.id}`}
                  className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${stripeCls} cursor-pointer hover:bg-bg-warm active:bg-bg transition-colors`}>
                <div className="flex items-center gap-2 mb-1">
                  <Chip tone={tone as any}>{label}</Chip>
                  <span className="text-micro text-gray3">{timeAgo(o.createdAt)}</span>
                  <span className="ml-auto font-num text-h2">¥{Math.round(Number(o.totalAmount || 0)).toLocaleString()}</span>
                </div>
                <div className="text-h2 flex items-center gap-1">
                  <span className="flex-1 truncate">{o.store?.name} <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span></span>
                  <span className="text-amber-fg text-button">{cta}</span>
                </div>
                <p className="text-caption text-gray2 mt-0.5">
                  {o.items?.length ?? 0} 项 · 期望 {o.expectedDate?.slice(5, 10).replace('-', '/')}
                </p>
              </li>
            )
          })}
        </ul>
      </Section>

      {/* 待处理空 + 有在途时, 给个轻提示, 让供应商知道有单子在途 (避免误以为没单) */}
      {pending.length === 0 && shipping.length > 0 && (
        <p className="px-4 mt-2 text-caption text-gray3 text-center">
          另有 <a href="/v2/supplier/orders" className="text-amber-fg">{shipping.length} 单已发货 待门店签收 ›</a>
        </p>
      )}

      {/* 经营分析 — 4 个入口 */}
      <Section title="经营分析">
        <div className="grid grid-cols-2 gap-2">
          <a href="/v2/supplier/customers" className="bg-white rounded-card border border-border p-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-md bg-amber/10 text-amber-fg flex items-center justify-center">🏪</span>
            <div className="flex-1 min-w-0">
              <div className="text-h2">客户/门店</div>
              <p className="text-micro text-gray3 truncate">合作店铺 · 销售明细</p>
            </div>
          </a>
          <a href="/v2/supplier/analytics" className="bg-white rounded-card border border-border p-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-md bg-blue/10 text-blue-fg flex items-center justify-center">📊</span>
            <div className="flex-1 min-w-0">
              <div className="text-h2">销售分析</div>
              <p className="text-micro text-gray3 truncate">SKU 排行 · 月度趋势</p>
            </div>
          </a>
          <a href="/v2/supplier/products" className="bg-white rounded-card border border-border p-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center">📋</span>
            <div className="flex-1 min-w-0">
              <div className="text-h2">商品报价</div>
              <p className="text-micro text-gray3 truncate">改单价 / 起订量</p>
            </div>
          </a>
          <a href="/v2/supplier/billing" className="bg-white rounded-card border border-border p-3 flex items-center gap-3">
            <span className="w-9 h-9 rounded-md bg-green/10 text-green-fg flex items-center justify-center">💰</span>
            <div className="flex-1 min-w-0">
              <div className="text-h2">账单/对账</div>
              <p className="text-micro text-gray3 truncate">应收 · 已付 · 发票</p>
            </div>
          </a>
        </div>
      </Section>

      <BottomNav
        tabs={[
          { key: 'home',    label: '首页', icon: '⌂' },
          { key: 'orders',  label: '订单', icon: '☷' },
          { key: 'inventory', label: '库存', icon: '▦' },
          { key: 'billing', label: '账单', icon: '⛁' },
          { key: 'me',      label: '我的', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'orders')  location.href = '/v2/supplier/orders'
          if (k === 'inventory') location.href = '/v2/supplier/inventory'
          if (k === 'billing') location.href = '/v2/supplier/billing'
          if (k === 'me')      location.href = '/v2/supplier/history'
        }}
      />
    </div>
  )
}

function Bucket({ label, amount, tone }: { label: string; amount: number; tone: 'red' | 'orange' | 'default' | 'gray' }) {
  const colorMap = { red: 'text-red-fg', orange: 'text-orange-fg', default: 'text-ink', gray: 'text-gray3' }
  return (
    <div className="text-center">
      <div className={`font-num text-h2 ${colorMap[tone]}`}>¥{Math.round(amount).toLocaleString()}</div>
      <div className="text-micro text-gray3 mt-0.5">{label}</div>
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
