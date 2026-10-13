import { Prisma } from '@dianjie/db'

/** Keep original movement amounts immutable; expose repriced inbound totals separately. */
export async function currentInboundValues(
  db: Pick<Prisma.TransactionClient, 'warehouseLedgerMovement'>,
  tenantId: string,
  warehouseId: string,
  rows: Array<{ id: string; type: string; valueDelta: Prisma.Decimal }>,
) {
  const inbound = rows.filter(row => row.type === 'MANUAL_INBOUND')
  const values = new Map(inbound.map(row => [row.id, row.valueDelta]))
  if (!inbound.length) return values
  const adjustments = await db.warehouseLedgerMovement.groupBy({
    by: ['sourceLineId'],
    where: { tenantId, warehouseId, sourceType: 'WarehouseDocValueAdjust', sourceLineId: { in: inbound.map(row => row.id) } },
    _sum: { valueDelta: true },
  })
  for (const row of adjustments) {
    if (row.sourceLineId && values.has(row.sourceLineId)) {
      values.set(row.sourceLineId, values.get(row.sourceLineId)!.plus(row._sum.valueDelta ?? 0))
    }
  }
  return values
}
