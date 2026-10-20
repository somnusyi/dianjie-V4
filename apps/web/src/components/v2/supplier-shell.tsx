'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { BottomNav } from '@/components/v2'
import { getUser } from '@/lib/v2-auth'
import { supplierPortalMode, type SupplierPortalMode } from '@/lib/supplier-experience'

type SupplierCapability =
  | 'dashboard.read'
  | 'order.manage'
  | 'catalog.manage'
  | 'inventory.manage'
  | 'settlement.read'
  | 'analytics.read'

type NavItem = {
  href: string
  label: string
  description: string
  icon: string
  capability: SupplierCapability
  match?: string[]
  modes?: SupplierPortalMode[]
}

// 当前供应商账号统一权限；保留 capability 字段，后续切分订单员、仓管、财务时无需重做导航。
const ACTIVE_CAPABILITIES = new Set<SupplierCapability>([
  'dashboard.read',
  'order.manage',
  'catalog.manage',
  'inventory.manage',
  'settlement.read',
  'analytics.read',
])

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '日常作业',
    items: [
      { href: '/v2/supplier/home', label: '工作台', description: '待办与预警', icon: '⌂', capability: 'dashboard.read' },
      { href: '/v2/supplier/upstream', label: '总仓采购', description: '接单、改单、发货与对账', icon: '采', capability: 'order.manage', modes: ['UPSTREAM_ONLY', 'MIXED', 'UNKNOWN'] },
      { href: '/v2/supplier/orders', label: '门店订单履约', description: '订货、实发、配送', icon: '☷', capability: 'order.manage', modes: ['STORE_ONLY', 'MIXED', 'UNKNOWN'] },
      { href: '/v2/supplier/differences', label: '门店到货差异', description: '短缺、破损、责任确认', icon: '!', capability: 'order.manage', modes: ['STORE_ONLY', 'MIXED', 'UNKNOWN'] },
      { href: '/v2/supplier/inventory', label: '门店履约库存', description: '默认仓与流水', icon: '▦', capability: 'inventory.manage', modes: ['STORE_ONLY', 'MIXED', 'UNKNOWN'] },
    ],
  },
  {
    title: '货品与经营',
    items: [
      { href: '/v2/supplier/products', label: '商品与报价', description: 'SKU、分类、审批', icon: '□', capability: 'catalog.manage', match: ['/v2/supplier/products', '/v2/supplier/categories'], modes: ['STORE_ONLY', 'MIXED', 'UNKNOWN'] },
      { href: '/v2/supplier/billing', label: '门店账单与发票', description: '应收、对账、开票', icon: '¥', capability: 'settlement.read', match: ['/v2/supplier/billing', '/v2/supplier/reconciliation', '/v2/supplier/invoices'], modes: ['STORE_ONLY', 'MIXED', 'UNKNOWN'] },
      { href: '/v2/supplier/analytics', label: '门店经营分析', description: '门店与商品表现', icon: '↗', capability: 'analytics.read', match: ['/v2/supplier/analytics', '/v2/supplier/customers'], modes: ['STORE_ONLY', 'MIXED', 'UNKNOWN'] },
      { href: '/v2/supplier/history', label: '操作记录', description: '历史单据与追溯', icon: '◷', capability: 'dashboard.read' },
    ],
  },
]

function isActive(pathname: string, item: NavItem) {
  const matches = item.match || [item.href]
  return matches.some(path => pathname === path || pathname.startsWith(`${path}/`))
}

export function SupplierShell({ children }: { children: ReactNode }) {
  const [mobileMode, setMobileMode] = useState(false)
  const [section, setSection] = useState('orders')
  const pathname = usePathname()
  const router = useRouter()
  const mode = supplierPortalMode(getUser()?.supplier?.businessScopes)

  useEffect(() => {
    const sync = () => setSection(location.hash.slice(1) || 'orders')
    sync(); window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [pathname])
  const upstreamOnly = mode === 'UPSTREAM_ONLY'
  const mobileTabs = upstreamOnly ? [
    { key: 'home', label: '工作台', icon: '⌂', href: '/v2/supplier/home' },
    { key: 'orders', label: '采购单', icon: '☷', href: '/v2/supplier/upstream#orders' },
    { key: 'claims', label: '差异', icon: '△', href: '/v2/supplier/upstream#claims' },
    { key: 'settlements', label: '对账', icon: '⛁', href: '/v2/supplier/upstream#settlements' },
    { key: 'me', label: '我的', icon: '◐', href: '/v2/me' },
  ] : [
    { key: 'home', label: '首页', icon: '⌂', href: '/v2/supplier/home' },
    { key: 'orders', label: '订单', icon: '☷', href: '/v2/supplier/orders' },
    { key: 'inventory', label: '库存', icon: '▦', href: '/v2/supplier/inventory' },
    { key: 'billing', label: '账单', icon: '⛁', href: '/v2/supplier/billing' },
    { key: 'me', label: '我的', icon: '◐', href: '/v2/supplier/history' },
  ]
  const mobileActive = pathname.startsWith('/v2/supplier/upstream') && upstreamOnly
    ? (section === 'shipments' ? 'orders' : section)
    : mobileTabs.find(item => pathname === item.href || pathname.startsWith(`${item.href}/`))?.key || 'home'

  function navigate(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null
    const href = link?.getAttribute('href') || ''
    if (!href.startsWith('/v2/') || link?.target === '_blank' || link?.hasAttribute('download')) return
    event.preventDefault()
    router.push(href)
  }

  return (
    <div onClickCapture={navigate} data-navigation-mode={mobileMode ? 'mobile' : 'desktop'} className={`supplier-portal min-h-screen bg-bg ${mobileMode ? 'supplier-mobile-mode' : 'supplier-desktop-mode'}`}>
      {!mobileMode && <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-border bg-white">
        <div className="border-b border-border px-5 py-5">
          <Link href="/v2/supplier/home" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber text-lg font-bold text-white">滇</span>
            <span>
              <strong className="block text-h2">供应商工作台</strong>
              <span className="text-micro text-gray3">滇界供应链</span>
            </span>
          </Link>
        </div>

        <nav aria-label="供应商主导航" className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_GROUPS.map(group => (
            <section key={group.title} className="mb-5">
              <h2 className="mb-2 px-3 text-micro font-medium tracking-wider text-gray3">{group.title}</h2>
              <div className="space-y-1">
                {group.items.filter(item =>
                  ACTIVE_CAPABILITIES.has(item.capability)
                  && (!item.modes || item.modes.includes(mode))
                ).map(item => {
                  const active = isActive(pathname, item)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${active ? 'bg-amber/10 text-amber-fg' : 'text-gray1 hover:bg-bg'}`}
                    >
                      <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-button ${active ? 'bg-amber text-white' : 'bg-bg text-gray2'}`}>{item.icon}</span>
                      <span className="min-w-0">
                        <strong className="block text-button">{item.label}</strong>
                        <span className="block truncate text-micro text-gray3">{item.description}</span>
                      </span>
                    </Link>
                  )
                })}
              </div>
            </section>
          ))}
        </nav>

        <div className="border-t border-border p-4">
          <div className="rounded-xl bg-bg px-3 py-2">
            <div className="text-button">{mode === 'UPSTREAM_ONLY' ? '总仓供货合作方' : '默认仓'}</div>
            <p className="mt-0.5 text-micro text-gray3">
              {mode === 'UPSTREAM_ONLY' ? '接单、发货、差异与月结' : '当前单仓执行 · 门店履约'}
            </p>
          </div>
        </div>
      </aside>}

      <main className={`min-h-screen ${mobileMode ? 'pb-16 pt-12' : 'pl-64 pt-10'}`}>
        <div className={`mx-auto min-h-screen w-full max-w-[1440px] ${mobileMode ? '' : 'px-6 py-5'}`}>
          {children}
        </div>
      </main>
      {mobileMode && <BottomNav tabs={mobileTabs} activeKey={mobileActive} onChange={key => {
        const target = mobileTabs.find(item => item.key === key)
        if (!target) return
        if (target.href.startsWith(`${pathname}#`)) location.hash = target.href.split('#')[1]
        else router.push(target.href)
      }} />}
      <button type="button" aria-label={mobileMode ? '切换到电脑版' : '切换到手机版'} aria-pressed={mobileMode} onClick={() => setMobileMode(value => !value)} className="fixed right-4 top-3 z-30 rounded-lg border border-border bg-white px-3 py-1.5 text-caption text-amber-fg shadow-sm">{mobileMode ? '切换电脑版' : '切换手机版'}</button>
    </div>
  )
}
