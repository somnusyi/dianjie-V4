'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

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
      { href: '/v2/supplier/orders', label: '订单履约', description: '订货、实发、配送', icon: '☷', capability: 'order.manage' },
      { href: '/v2/supplier/differences', label: '到货差异', description: '短缺、破损、责任确认', icon: '!', capability: 'order.manage' },
      { href: '/v2/supplier/inventory', label: '库存', description: '默认仓与流水', icon: '▦', capability: 'inventory.manage' },
    ],
  },
  {
    title: '货品与经营',
    items: [
      { href: '/v2/supplier/products', label: '商品与报价', description: 'SKU、分类、审批', icon: '□', capability: 'catalog.manage', match: ['/v2/supplier/products', '/v2/supplier/categories'] },
      { href: '/v2/supplier/billing', label: '账单与发票', description: '应收、对账、开票', icon: '¥', capability: 'settlement.read', match: ['/v2/supplier/billing', '/v2/supplier/reconciliation', '/v2/supplier/invoices'] },
      { href: '/v2/supplier/analytics', label: '经营分析', description: '门店与商品表现', icon: '↗', capability: 'analytics.read', match: ['/v2/supplier/analytics', '/v2/supplier/customers'] },
      { href: '/v2/supplier/history', label: '操作记录', description: '历史单据与追溯', icon: '◷', capability: 'dashboard.read' },
    ],
  },
]

function isActive(pathname: string, item: NavItem) {
  const matches = item.match || [item.href]
  return matches.some(path => pathname === path || pathname.startsWith(`${path}/`))
}

export function SupplierShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="supplier-portal min-h-screen bg-bg">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-white lg:flex">
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
                {group.items.filter(item => ACTIVE_CAPABILITIES.has(item.capability)).map(item => {
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
            <div className="text-button">默认仓</div>
            <p className="mt-0.5 text-micro text-gray3">当前单仓执行 · 门店直送</p>
          </div>
        </div>
      </aside>

      <main className="min-h-screen lg:pl-64">
        <div className="mx-auto min-h-screen w-full max-w-[1440px] lg:px-6 lg:py-5">
          {children}
        </div>
      </main>
    </div>
  )
}
