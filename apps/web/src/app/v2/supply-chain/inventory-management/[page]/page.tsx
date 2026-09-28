import { notFound } from 'next/navigation'
import { ManagementWorkspace } from '@/components/v2/management-workspace'
import { managementPages } from '@/lib/inventory-management'
import { InventoryRules } from '@/components/v2/inventory-rules'
export default function Page({ params }: { params: { page: string } }) {
  const config = managementPages.find(p => p.id === params.page && p.group === 'inventory')
  if (!config) notFound()
  if (config.id === 'limits') return <InventoryRules />
  return <ManagementWorkspace key={config.id} config={config} />
}
