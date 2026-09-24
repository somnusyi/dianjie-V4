'use client'
import { managementPages, managementHref, managementGroupLabel, type ManagementGroup } from '@/lib/inventory-management'
import { WorkspaceMenu } from './workspace-menu'

export function ManagementNav({ group, pathname }: { group: ManagementGroup; pathname: string }) {
  const pages = managementPages.filter(page => page.group === group)
  return <WorkspaceMenu id={`${group}-management-flyout`} title={managementGroupLabel(group)}
    description={group === 'inventory' ? '出入库单据与库存上下限' : '盘点、多人盘点与盈亏单'}
    icon={group === 'inventory' ? '存' : '盘'} selected={pages.some(page => managementHref(page) === pathname)}
    href={managementHref(pages[0])} pathname={pathname} items={pages.map(page => ({ title: page.title, href: managementHref(page) }))} />
}
