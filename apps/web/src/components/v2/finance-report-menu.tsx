'use client'
import { financeReports } from '@/app/v2/supply-chain/finance-reports/report-definitions'
import { WorkspaceMenu } from './workspace-menu'
export function FinanceReportMenu({ selected }: { selected: boolean }) {
  return <WorkspaceMenu id="finance-report-flyout" title="财务报表" description="毛利分析、物品与明细" icon="¥" selected={selected}
    href="/v2/supply-chain/finance-reports?report=group-profit" items={financeReports.map(report => ({ title: report.title, href: `/v2/supply-chain/finance-reports?report=${report.id}` }))} />
}
