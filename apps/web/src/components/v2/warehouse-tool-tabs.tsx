'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/v2/supply-chain/inventory', label: '库存查询' },
  { href: '/v2/supply-chain/inventory/loss', label: '总仓自损' },
] as const

export function WarehouseToolTabs() {
  const pathname = usePathname() || ''
  return (
    <nav aria-label="库存与单据视图" className="mb-4 flex items-center gap-5 border-b border-border">
      {TABS.map(tab => {
        const selected = pathname === tab.href
          || (tab.href !== '/v2/supply-chain/inventory' && pathname.startsWith(`${tab.href}/`))
        return <Link key={tab.href} href={tab.href} aria-current={selected ? 'page' : undefined}
          className={`shrink-0 border-b-2 px-1 py-2 text-button ${selected ? 'border-ink text-ink' : 'border-transparent text-gray2 hover:text-ink'}`}
        >{tab.label}</Link>
      })}
    </nav>
  )
}
