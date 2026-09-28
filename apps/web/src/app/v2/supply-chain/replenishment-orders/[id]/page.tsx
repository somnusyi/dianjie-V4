import { ReplenishmentOrderEditor } from '@/components/v2/replenishment-order-editor'

export default async function ReplenishmentOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ReplenishmentOrderEditor orderId={id} />
}
