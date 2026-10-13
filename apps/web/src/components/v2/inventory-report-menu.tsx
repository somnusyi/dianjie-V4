'use client'
import { WorkspaceMenu } from './workspace-menu'
export const inventoryReports = [
  { id: 'realtime', title: '实时库存查询表' }, { id: 'movements', title: '出入库明细表' }, { id: 'summary', title: '出入库汇总表' }, { id: 'other-summary', title: '其他出入库汇总表' }, { id: 'transfer-detail', title: '机构间调拨明细表' }, { id: 'transfer-summary', title: '机构间调拨汇总表' }, { id: 'stagnant', title: '库存呆滞品查询表' }, { id: 'alerts', title: '库存预警表' },
]
export function InventoryReportMenu({ selected }: { selected: boolean }) {
  return <WorkspaceMenu openOnly id="inventory-report-flyout" title="库存报表" description="库存管理与验收、库存查询与报表" icon="仓" selected={selected}
    href="/v2/supply-chain/inventory" items={[{ title: '库存管理与验收', href: '/v2/supply-chain/inventory' }, ...inventoryReports.map(report => ({ title: report.title, href: `/v2/supply-chain/reports?report=${report.id}` }))]}
    shortcuts={[
      { title: '总仓自损', href: '/v2/supply-chain/inventory/loss' },
      { title: '入库记录', href: '/v2/supply-chain/inbound' },
      { title: '单据审核', href: '/v2/supply-chain/docs' },
    ]} />
}
