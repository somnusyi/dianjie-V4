'use client'

import Link from 'next/link'
import { SUPPLY_CHAIN_NAV_GROUPS } from '@/components/v2/supply-chain-shell'
import { inventoryReports } from '@/components/v2/inventory-report-menu'
import { managementPages, managementHref } from '@/lib/inventory-management'
import { financeReports } from '@/app/v2/supply-chain/finance-reports/report-definitions'

const warehouseTools = [
  { label: '库存查询与入库', href: '/v2/supply-chain/inventory' },
  { label: '总仓自损', href: '/v2/supply-chain/inventory/loss' },
  { label: '入库记录', href: '/v2/supply-chain/inbound' },
  { label: '单据审核', href: '/v2/supply-chain/docs' },
  { label: '总仓多人盘点作业', href: '/v2/supply-chain/stocktake/work' },
]

export default function SupplyChainNavigationPage() {
  const groups = [
    ...SUPPLY_CHAIN_NAV_GROUPS,
    { title: '库存管理与验收', items: warehouseTools },
    { title: '库存与盘点单据', items: managementPages.map(page => ({ label: page.title, href: managementHref(page) })) },
    { title: '库存报表', items: inventoryReports.map(report => ({ label: report.title, href: `/v2/supply-chain/reports?report=${report.id}` })) },
    { title: '财务报表', items: financeReports.map(report => ({ label: report.title, href: `/v2/supply-chain/finance-reports?report=${report.id}` })) },
    { title: '配送查询', items: [
      { label: '门店订货单', href: '/v2/supply-chain/orders' },
      { label: '门店补货单', href: '/v2/supply-chain/replenishment-orders' },
      { label: '配送单', href: '/v2/supply-chain/deliveries' },
      { label: '收货查询', href: '/v2/supply-chain/receipts' },
    ] },
  ]
  return <div className="p-4 pb-24 lg:p-8">
    <h1 className="text-h1">全部功能</h1>
    <p className="mt-2 text-caption text-gray2">选择需要办理的业务，进入后可随时从页面顶部返回这里。</p>
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      {groups.map(group => <section key={group.title} className="rounded-card border border-border bg-white p-4">
        <h2 className="mb-3 text-h2">{group.title}</h2>
        <div className="grid grid-cols-2 gap-2">{group.items.map(item => <Link key={item.href} href={item.href} className="rounded-xl border border-border px-3 py-3 text-button text-amber-fg hover:bg-bg">{item.label}</Link>)}</div>
      </section>)}
    </div>
  </div>
}
