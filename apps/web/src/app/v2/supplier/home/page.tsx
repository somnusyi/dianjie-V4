/**
 * 供应商 App · 首页  PDF: supplier_home  Tab 1/4
 * Hero 本周成交 + 双向数据 · 待办 4 单红条急办 · "需调整"橙色减量协商卡 · 本周经营 3 metric
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { UserMenu } from '@/components/v2/user-menu'
import { useDashboard, LoadingScreen, ErrorScreen, greetingFor } from '@/components/v2/use-dashboard'
import { apiFetch } from '@/lib/v2-auth'

type Order = {
  id: string; no: string; status: string; totalAmount: number | string
  createdAt: string; expectedDate: string
  store: { id: string; name: string }
  items?: any[]
}

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
  useEffect(() => {
    apiFetch<any>('/api/orders?pageSize=20')
      .then((d: any) => setOrders((d.items || d || [])))
      .catch(() => setOrders([]))
  }, [])
  if (error) return <ErrorScreen message={error} />
  if (!data) return <LoadingScreen />
  const { greeting, today } = greetingFor(data.user?.name)
  const pending = (orders || []).filter(o => ['SUBMITTED', 'CONFIRMED'].includes(o.status))
  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <p className="text-caption text-gray2">餐饮采购平台</p>
          <h1 className="text-h1">{data.supplier?.name || '供应商'}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Chip tone="green">合作伙伴</Chip>
            <span className="text-micro text-gray3">{greeting} · {today}</span>
          </div>
        </div>
        <UserMenu />
      </header>

      <div className="mt-3">
        <GlanceStrip {...(data.hero as any)} />
      </div>

      <Section title="待处理订单" right={pending.length > 0 ? `${pending.length} 单待接` : undefined} rightTone={pending.length > 0 ? 'red' : undefined}>
        {orders === null && <p className="text-caption text-gray3 text-center py-4">加载中…</p>}
        {orders !== null && pending.length === 0 && (
          <p className="text-caption text-gray3 text-center py-4">暂无待接订单 · ✓ 全部已处理</p>
        )}
        <ul className="space-y-2">
          {pending.slice(0, 5).map(o => {
            const isUrgent = o.status === 'SUBMITTED'
            return (
              <li key={o.id}
                  onClick={() => location.href = `/v2/supplier/orders/${o.id}`}
                  className={`relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full ${isUrgent ? 'before:bg-red' : 'before:bg-orange'} cursor-pointer hover:bg-bg-warm active:bg-bg transition-colors`}>
                <div className="flex items-center gap-2 mb-1">
                  <Chip tone={isUrgent ? 'red' : 'orange'}>{isUrgent ? '待接单' : '已接单'}</Chip>
                  <span className="text-micro text-gray3">{timeAgo(o.createdAt)}</span>
                  <span className="ml-auto font-num text-h2">¥{Math.round(Number(o.totalAmount || 0)).toLocaleString()}</span>
                </div>
                <div className="text-h2 flex items-center gap-1">
                  <span className="flex-1 truncate">{o.store?.name} <span className="text-micro text-gray3 font-num ml-1">#{o.no}</span></span>
                  <span className="text-amber-fg text-button">{isUrgent ? '去接单 ›' : '去发货 ›'}</span>
                </div>
                <p className="text-caption text-gray2 mt-0.5">
                  {o.items?.length ?? 0} 项 · 期望 {o.expectedDate?.slice(5, 10).replace('-', '/')}
                </p>
              </li>
            )
          })}
        </ul>
        {pending.length > 0 && (
          <a href="/v2/supplier/orders" className="block mt-2 text-center py-3 bg-white border border-border rounded-cta text-button text-gray2">去订单页处理 ›</a>
        )}
      </Section>

      <Section title="商品报价表">
        <a href="/v2/supplier/products" className="block bg-white rounded-card border border-border p-4 flex items-center gap-3">
          <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center">📋</span>
          <div className="flex-1">
            <div className="text-h2">商品报价表</div>
            <p className="text-micro text-gray3">查看 / 修改自己 SKU 的单价 + 库存</p>
          </div>
          <span className="text-gray3">›</span>
        </a>
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
