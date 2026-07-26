'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/v2/supply-chain/products', label: '商品档案' },
  { href: '/v2/supply-chain/categories', label: '分类管理' },
  { href: '/v2/supply-chain/products/import', label: '批量导入' },
  { href: '/v2/supply-chain/products/history', label: '操作记录' },
] as const

export function ProductToolTabs() {
  const pathname = usePathname() || ''
  return (
    <nav aria-label="商品管理视图" className="flex flex-wrap gap-2 border-b border-border py-4">
      {TABS.map(tab => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-cta px-4 py-2 text-button ${
              active ? 'bg-ink text-white' : 'border border-border bg-white text-gray2'
            }`}
          >{tab.label}</Link>
        )
      })}
    </nav>
  )
}
