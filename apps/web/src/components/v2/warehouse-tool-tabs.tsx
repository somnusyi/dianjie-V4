'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/v2/supply-chain/inventory', label: '库存查询' },
  { href: '/v2/supply-chain/inbound', label: '入库记录' },
  { href: '/v2/supply-chain/docs', label: '单据审核' },
] as const

export function WarehouseToolTabs() {
  const pathname = usePathname() || ''
  return (
    <nav aria-label="库存与单据视图" className="mb-4 flex min-h-11 items-center gap-2 overflow-x-auto border-b border-border pb-3">
      {TABS.map(tab => {
        const selected = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        return <Link key={tab.href} href={tab.href} aria-current={selected ? 'page' : undefined}
          className={`shrink-0 rounded-cta px-4 py-2 text-button ${selected ? 'bg-ink text-white' : 'border border-border bg-white text-gray2'}`}
        >{tab.label}</Link>
      })}
    </nav>
  )
}
