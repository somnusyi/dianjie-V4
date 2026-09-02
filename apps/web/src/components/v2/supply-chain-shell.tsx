'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { BottomNav } from '@/components/v2'

type NavItem = {
  href: string
  label: string
  description: string
  icon: string
  match?: string[]
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '日常作业',
    items: [
      { href: '/v2/supply-chain/home', label: '工作台', description: '今日待办、异常与健康', icon: '⌂' },
      {
        href: '/v2/supply-chain/fulfillment',
        label: '订单中心',
        description: '待处理、订货与配送',
        icon: '☷',
        match: [
          '/v2/supply-chain/fulfillment',
          '/v2/supply-chain/orders',
          '/v2/supply-chain/deliveries',
        ],
      },
      {
        href: '/v2/supply-chain/differences',
        label: '到货差异',
        description: '短量、破损与报损',
        icon: '!',
        match: ['/v2/supply-chain/differences', '/v2/supply-chain/receipts'],
      },
      {
        href: '/v2/supply-chain/stores',
        label: '门店运营',
        description: '订货、收货、库存与消耗',
        icon: '店',
      },
      {
        href: '/v2/supply-chain/delivery-rules',
        label: '配送班表',
        description: '送货日、到货期与适用门店',
        icon: '班',
      },
    ],
  },
  {
    title: '货品与仓库',
    items: [
      {
        href: '/v2/supply-chain/products',
        label: '商品管理',
        description: '商品、分类、导入与记录',
        icon: '品',
        match: ['/v2/supply-chain/products', '/v2/supply-chain/categories'],
      },
      { href: '/v2/supply-chain/inventory', label: '仓库库存', description: '库存、入库、批次与流水', icon: '仓' },
      { href: '/v2/supply-chain/inbound', label: '入库记录', description: '入库流水、供应商归属与来源认领', icon: '入' },
      { href: '/v2/supply-chain/docs', label: '单据审核', description: '入库/出库单据、会计审核与改单留痕', icon: '单' },
      { href: '/v2/supply-chain/suppliers', label: '上游供应商', description: '总仓采购合作方', icon: '供' },
    ],
  },
  {
    title: '核算与分析',
    items: [
      { href: '/v2/supply-chain/billing', label: '账务查询', description: '账期、对账与发票', icon: '¥' },
      { href: '/v2/supply-chain/analytics', label: '经营分析', description: '门店、SKU、趋势与健康', icon: '↗' },
    ],
  },
]

/** 移动端底部导航 4 Tab */
const MOBILE_TABS = [
  { key: 'home', label: '工作台', icon: '⌂', href: '/v2/supply-chain/home' },
  { key: 'orders', label: '订单', icon: '☷', href: '/v2/supply-chain/fulfillment' },
  { key: 'inventory', label: '库存', icon: '▦', href: '/v2/supply-chain/inventory' },
  { key: 'more', label: '更多', icon: '◐', href: '/v2/supply-chain/analytics' },
]

function active(pathname: string, item: NavItem) {
  return (item.match || [item.href]).some(
    path => pathname === path || pathname.startsWith(`${path}/`),
  )
}

function mobileActiveKey(pathname: string): string {
  // 优先精确匹配，否则按前缀
  for (const t of MOBILE_TABS) {
    if (pathname === t.href || pathname.startsWith(`${t.href}/`)) return t.key
  }
  // 订单相关子页归到 orders
  if (
    pathname.startsWith('/v2/supply-chain/orders') ||
    pathname.startsWith('/v2/supply-chain/deliveries') ||
    pathname.startsWith('/v2/supply-chain/fulfillment')
  ) {
    return 'orders'
  }
  // 库存相关子页归到 inventory
  if (
    pathname.startsWith('/v2/supply-chain/inventory') ||
    pathname.startsWith('/v2/supply-chain/products') ||
    pathname.startsWith('/v2/supply-chain/categories') ||
    pathname.startsWith('/v2/supply-chain/suppliers')
  ) {
    return 'inventory'
  }
  // 分析/账务/差异/收货等归到 more
  if (
    pathname.startsWith('/v2/supply-chain/analytics') ||
    pathname.startsWith('/v2/supply-chain/billing') ||
    pathname.startsWith('/v2/supply-chain/differences') ||
    pathname.startsWith('/v2/supply-chain/receipts') ||
    pathname.startsWith('/v2/supply-chain/stores')
  ) {
    return 'more'
  }
  return 'home'
}

export function SupplyChainShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || ''
  const router = useRouter()
  const sandbox = process.env.NEXT_PUBLIC_SANDBOX_MODE === 'true'

  return (
    <div className="min-h-screen bg-bg">
      {/* PC 侧边栏 — lg 以上显示 */}
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
            <Link href="/v2/me" className="mt-2 block text-micro text-amber-fg">账户与密码设置 ›</Link>
          </div>
        </div>
      </aside>

      {/* 主内容区 — 移动端无左侧内边距，PC 有 lg:pl-64 */}
      <main className="min-h-screen lg:pl-64">
        {sandbox && (
          <div className="sticky top-0 z-40 border-b border-amber/40 bg-amber/15 px-4 py-2 text-center text-caption text-amber-fg">
            本地沙盒 · 页面修改只写入本机，不会更改线上数据
          </div>
        )}
        <div className="mx-auto min-h-screen w-full max-w-[1600px]">{children}</div>
      </main>

      {/* 移动端底部导航 — lg 以下显示 */}
      <div className="lg:hidden">
        <BottomNav
          tabs={MOBILE_TABS.map(t => ({ key: t.key, label: t.label, icon: t.icon }))}
          activeKey={mobileActiveKey(pathname)}
          onChange={(k) => {
            const t = MOBILE_TABS.find(tab => tab.key === k)
            if (t && t.href !== pathname) router.push(t.href)
          }}
        />
      </div>
    </div>
  )
}
