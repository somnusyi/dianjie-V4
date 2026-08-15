import { Prisma } from '@dianjie/db'
import { businessMonthKey } from '../lib/businessTime'
import { nextBusinessNo } from './purchaseOrderIntegrity'

/** Generate a tenant-scoped document number without count + 1 races. */
export async function nextDocumentNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  at: Date = new Date(),
) {
  const period = businessMonthKey(at)
  const prefix = `DOC${period}`
  const latest = await tx.document.findFirst({
    where: { tenantId, no: { startsWith: prefix } },
    orderBy: { no: 'desc' },
    select: { no: true },
  })
  const parsedFloor = Number(latest?.no.slice(prefix.length) || 0)
  const floor = Number.isFinite(parsedFloor) ? parsedFloor : 0
  return nextBusinessNo(tx, tenantId, 'DOCUMENT', period, 'DOC', floor)
}
