'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/v2/supply-chain/fulfillment', label: '待处理', description: '接单、发货、送达' },
  { href: '/v2/supply-chain/orders', label: '订货单', description: '门店原始订货记录' },
  { href: '/v2/supply-chain/deliveries', label: '配送单', description: '按实际发货形成' },
] as const

export function OrderCenterTabs() {
  const pathname = usePathname() || ''
  return (
    <nav aria-label="订单中心视图" className="flex flex-wrap gap-2 border-b border-border py-4">
      {TABS.map(tab => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`min-w-40 rounded-cta border px-4 py-2.5 ${
              active ? 'border-ink bg-ink text-white' : 'border-border bg-white text-gray2'
            }`}
          >
            <strong className="block text-button">{tab.label}</strong>
            <span className={`text-micro ${active ? 'text-white/65' : 'text-gray3'}`}>{tab.description}</span>
          </Link>
        )
      })}
    </nav>
  )
}
