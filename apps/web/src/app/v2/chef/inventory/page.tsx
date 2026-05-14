/**
 * 厨师长 App · 库存 Tab
 * 接 /api/inventory + /api/orders?status=CONFIRMED|SHIPPED
 */
'use client'
import { useEffect, useState } from 'react'
import { BottomNav, ProgressDots, Chip } from '@/components/v2'
import { GlanceStrip } from '@/components/v2/glance-strip'
import { EmptyState, SkeletonCard, FriendlyError } from '@/components/v2/skeleton'
import { apiFetch } from '@/lib/v2-auth'

type InventoryRow = {
  id: string
  code: string
  name: string
  category: string
  unit: string
  price: number | string
  stock: number | string
  minStock: number | string
  shelfDays: number
  isLowStock: boolean
  isExpiringSoon: boolean
  isExpired: boolean
  daysToExpiry: number | null
  monthIn: number
  monthOut: number
}

type OrderRow = {
  id: string
  no: string
  status: string
  totalAmount: number | string
  supplier: { id: string; name: string }
  createdAt: string
}

const STATUS_STEPS = [
  { label: '已发起' }, { label: '接单' }, { label: '在途' }, { label: '送达' }, { label: '验收' },
]
// currentIndex = 已完成步骤数 (步 < currentIndex ✓, 步 = currentIndex highlighted)
const STATUS_TO_IDX: Record<string, number> = {
  SUBMITTED: 1, CONFIRMED: 2, DELIVERING: 3, PENDING_CONFIRM: 4, RECEIVED: 5, COMPLETED: 5,
}

export default function ChefInventoryPage() {
  const [tab, setTab] = useState('inventory')
  const [inv, setInv] = useState<InventoryRow[] | null>(null)
  const [orders, setOrders] = useState<OrderRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedCat, setExpandedCat] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<InventoryRow[]>('/api/inventory').catch(() => []),
      apiFetch<any>('/api/orders?pageSize=20').then(d => (d.items || [])).catch(() => []),
    ])
      .then(([i, o]) => { setInv(i); setOrders(o) })
      .catch(e => setError(String(e?.message || e)))
  }, [])

  const lowStock = (inv || []).filter(p => p.isLowStock)
  const expiring = (inv || []).filter(p => p.isExpiringSoon && !p.isExpired)
  const totalValue = (inv || []).reduce((s, p) => s + Number(p.stock) * Number(p.price), 0)
  const totalSku = (inv || []).length

  // 按 category 分组
  const byCategory: Record<string, { count: number; value: number }> = {}
  ;(inv || []).forEach(p => {
    const k = p.category || '其他'
    byCategory[k] = byCategory[k] || { count: 0, value: 0 }
    byCategory[k].count++
    byCategory[k].value += Number(p.stock) * Number(p.price)
  })
  const categories = Object.entries(byCategory).map(([label, v]) => ({ label, ...v }))

  const inProgress = (orders || []).filter(o => ['SUBMITTED','CONFIRMED','SHIPPED','PENDING_CONFIRM'].includes(o.status))
  const inProgressAmount = inProgress.reduce((s, o) => s + Number(o.totalAmount || 0), 0)

  return (
    <div className="min-h-screen bg-bg pb-20">
      <header className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div>
          <h1 className="text-h1">库存</h1>
          <p className="text-caption text-gray3">本店 · 后厨</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⌕</button>
          <button className="w-9 h-9 rounded-full bg-white border border-border flex items-center justify-center">⋮</button>
        </div>
      </header>

      <div className="mt-3">
        <GlanceStrip
          label="库存价值 ● 实时"
          value={`¥${Math.round(totalValue).toLocaleString()}`}
          meta={`SKU ${totalSku} 项`}
          stats={[
            { label: '紧急补货', value: `${lowStock.length} 项`, tone: lowStock.length > 0 ? 'red' : 'default' },
            { label: '临期预警', value: `${expiring.length} 项`, tone: expiring.length > 0 ? 'orange' : 'default' },
            { label: '在途采购', value: `¥${Math.round(inProgressAmount / 1000)}K`, tone: 'default' },
          ]}
        />
      </div>

      {error && <div className="px-4 mt-3"><FriendlyError message={error} /></div>}
      {!inv && !error && (
        <div className="px-4 mt-3 space-y-2">
          {[1,2,3].map(i => <SkeletonCard key={i} />)}
        </div>
      )}

      {inv && lowStock.length > 0 && (
        <Section title="紧急补货" right="需即刻处理" rightTone="red">
          <ul className="space-y-2">
            {lowStock.map(p => (
              <li key={p.id} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-red flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-h2">{p.name} · <span className="text-red-fg">仅剩 {Number(p.stock)} {p.unit}</span></div>
                  <p className="text-caption text-gray3">安全库存 {Number(p.minStock)} {p.unit}</p>
                </div>
                <a href="/v2/chef/purchase/new" className="px-3 py-1.5 bg-ink text-white rounded-cta text-button shrink-0">立即下单</a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {inv && expiring.length > 0 && (
        <Section title="临期预警" right={`7 日内到期 ${expiring.length} 项`} rightTone="orange">
          <ul className="space-y-2">
            {expiring.map(p => (
              <li key={p.id} className="relative bg-white rounded-card p-3 pl-4 border border-border before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-orange flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-h2">{p.name} · {Number(p.stock)} {p.unit}</div>
                  <p className="text-caption text-gray3">{p.daysToExpiry != null ? `${p.daysToExpiry} 天后到期` : '到期日待录入'}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  {/* "优先用"标记功能待开发, 暂只链到报损 */}
                  <a href="/v2/chef/check/new" className="px-3 py-1.5 border border-red text-red rounded-cta text-button">报损</a>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {inv && inv.length > 0 && (
        <Section title="库存分类" right={`${totalSku} 项 · ¥${Math.round(totalValue).toLocaleString()}`}>
          <ul className="bg-white rounded-card border border-border divide-y divide-border">
            {categories.map(c => {
              const open = expandedCat === c.label
              const items = (inv || []).filter(p => (p.category || '其他') === c.label)
              return (
                <li key={c.label}>
                  <button
                    type="button"
                    onClick={() => setExpandedCat(open ? null : c.label)}
                    className="w-full px-3 py-3 flex items-center gap-3 text-left hover:bg-bg-warm">
                    <span className="w-9 h-9 rounded-md bg-bg flex items-center justify-center font-num text-button">{c.label.slice(0, 1)}</span>
                    <div className="flex-1">
                      <div className="text-h2">{c.label}</div>
                      <div className="text-micro text-gray3">{c.count} 项 · ¥{Math.round(c.value).toLocaleString()}</div>
                    </div>
                    <span className="text-gray3">{open ? '▾' : '›'}</span>
                  </button>
                  {open && items.length > 0 && (
                    <ul className="bg-bg/50 border-t border-border divide-y divide-border">
                      {items.map(p => (
                        <li key={p.id} className="px-3 py-2 flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-body truncate">{p.name}</div>
                            <div className="text-micro text-gray3 font-num">¥{Number(p.price).toFixed(2)} / {p.unit}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-num text-body">{Number(p.stock)} {p.unit}</div>
                            {p.isLowStock && <Chip tone="red">低库存</Chip>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {inv && inv.length === 0 && !error && (
        <div className="px-4 mt-4">
          <EmptyState icon="🥬" title="还没有库存" hint="到「商品管理」录入第一个商品, 或等待入库" />
        </div>
      )}

      {inProgress.length > 0 && (
        <Section title="进行中采购" right={`${inProgress.length} 单 · ¥${Math.round(inProgressAmount).toLocaleString()}`}>
          <ul className="space-y-2">
            {inProgress.map(p => (
              <li key={p.id} className="bg-white rounded-card border border-border p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-h2">{p.supplier?.name || '供应商'} <span className="text-micro text-gray3 ml-1 font-num">#{p.no}</span></span>
                  <span className="font-num text-h2">¥{Math.round(Number(p.totalAmount || 0)).toLocaleString()}</span>
                </div>
                <ProgressDots steps={STATUS_STEPS} currentIndex={STATUS_TO_IDX[p.status] ?? 0} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <BottomNav
        tabs={[
          { key: 'home', label: '工作台', icon: '⌂' },
          { key: 'inventory', label: '库存', icon: '⛁' },
          { key: 'purchase', label: '采购', icon: '☰' },
          { key: 'check', label: '盘点', icon: '◐' },
        ]}
        activeKey={tab}
        onChange={(k) => {
          if (k === 'home')     location.href = '/v2/chef/home'
          if (k === 'purchase') location.href = '/v2/chef/purchase'
          if (k === 'check')    location.href = '/v2/chef/check'
        }}
      />
    </div>
  )
}

function Section({ title, right, rightTone, children }: { title: string; right?: string; rightTone?: 'red' | 'orange'; children: React.ReactNode }) {
  return (
    <section className="px-4 mt-5">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-h2">{title}</h2>
        {right && <span className={`text-caption ${rightTone === 'red' ? 'text-red-fg' : rightTone === 'orange' ? 'text-orange-fg' : 'text-gray3'}`}>{right}</span>}
      </div>
      {children}
    </section>
  )
}
