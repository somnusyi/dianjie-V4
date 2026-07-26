'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

type NavItem = {
  href: string
  label: string
  description: string
  icon: string
  match?: string[]
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '履约作业',
    items: [
      { href: '/v2/supply-chain/home', label: '供应链总览', description: '待办、跨店与异常', icon: '⌂' },
      {
        href: '/v2/supply-chain/fulfillment',
        label: '订单履约',
        description: '接单、改单、实发、送达',
        icon: '☷',
        match: ['/v2/supply-chain/fulfillment'],
      },
      { href: '/v2/supply-chain/orders', label: '订货单查询', description: '跨店分页与筛选', icon: '订' },
      { href: '/v2/supply-chain/deliveries', label: '配送单查询', description: '独立配送记录', icon: '配' },
      { href: '/v2/supply-chain/receipts', label: '收货与差异', description: '实收、短量与报损', icon: '收' },
    ],
  },
  {
    title: '商品与仓库',
    items: [
      { href: '/v2/supply-chain/products', label: '商品管理', description: '价格、单位与状态', icon: '品' },
      { href: '/v2/supply-chain/categories', label: '分类管理', description: '分类、排序与合并', icon: '类' },
      { href: '/v2/supply-chain/inventory', label: '仓库库存', description: '默认仓、入库与流水', icon: '仓' },
      { href: '/v2/supply-chain/suppliers', label: '供应商管理', description: '档案、账期与状态', icon: '供' },
    ],
  },
  {
    title: '核算与分析',
    items: [
      { href: '/v2/supply-chain/billing', label: '账务查询', description: '账期、对账与发票', icon: '¥' },
      { href: '/v2/supply-chain/analytics', label: '经营分析', description: '采购趋势与门店分布', icon: '↗' },
      { href: '/v2/me', label: '我的账户', description: '账号与密码', icon: '我' },
    ],
  },
]

function active(pathname: string, item: NavItem) {
  return (item.match || [item.href]).some(
    path => pathname === path || pathname.startsWith(`${path}/`),
  )
}

export function SupplyChainShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || ''

  return (
    <div className="min-h-screen bg-bg">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-white lg:flex">
        <div className="border-b border-border px-5 py-5">
          <Link href="/v2/supply-chain/home" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber text-lg font-bold text-white">滇</span>
            <span>
              <strong className="block text-h2">内部供应链</strong>
              <span className="text-micro text-gray3">统一采购与履约中心</span>
            </span>
          </Link>
        </div>
        <nav aria-label="内部供应链主导航" className="flex-1 overflow-y-auto px-3 py-4">
          {NAV_GROUPS.map(group => (
            <section key={group.title} className="mb-5">
              <h2 className="mb-2 px-3 text-micro font-medium tracking-wider text-gray3">{group.title}</h2>
              <div className="space-y-1">
                {group.items.map(item => {
                  const selected = active(pathname, item)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={selected ? 'page' : undefined}
                      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                        selected ? 'bg-amber/10 text-amber-fg' : 'text-gray1 hover:bg-bg'
                      }`}
                    >
                      <span className={`flex h-8 w-8 items-center justify-center rounded-lg text-button ${
                        selected ? 'bg-amber text-white' : 'bg-bg text-gray2'
                      }`}>{item.icon}</span>
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
            <div className="text-button">当前：默认仓</div>
            <p className="mt-0.5 text-micro text-gray3">保留多仓接口 · 当前单仓执行</p>
          </div>
        </div>
      </aside>
      <main className="min-h-screen lg:pl-64">
        <div className="mx-auto min-h-screen w-full max-w-[1600px]">{children}</div>
      </main>
    </div>
  )
}
