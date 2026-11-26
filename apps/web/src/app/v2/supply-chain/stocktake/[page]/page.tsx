import { notFound } from 'next/navigation'
import { ManagementWorkspace } from '@/components/v2/management-workspace'
import { StocktakeWorkspace } from '@/components/v2/stocktake-workspace'
import { managementPages } from '@/lib/inventory-management'
export default function Page({ params }: { params: { page: string } }) {
  const config = managementPages.find(p => p.id === params.page && p.group === 'stocktake')
  if (!config) notFound()
  if (params.page === 'count' || params.page === 'multi-count') return <StocktakeWorkspace mode={params.page} />
  return <ManagementWorkspace key={config.id} config={config} />
}
