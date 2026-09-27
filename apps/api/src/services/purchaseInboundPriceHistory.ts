import { prisma } from '@dianjie/db'

export type PurchaseInboundPriceHistory = { productId: string; purchaseUnit: string; unitPrice: number; effectiveAt: Date; source: 'MANUAL_INBOUND' | 'UPSTREAM_RECEIPT' }

/** Read-only price memory. Units are part of the key: never compare a box price with a kilogram price. */
export async function findLatestPurchaseInboundPrices(input: { tenantId: string; supplierId: string; productIds: string[]; purchaseUnits: Record<string, string> }) {
  if (!input.productIds.length) return [] as PurchaseInboundPriceHistory[]
  const [manual, upstream] = await Promise.all([
    prisma.warehouseDocLine.findMany({
      where: { tenantId: input.tenantId, productId: { in: input.productIds }, doc: { tenantId: input.tenantId, type: 'MANUAL_INBOUND', supplierId: input.supplierId }, movement: { is: { reversal: null } } },
      select: { id: true, productId: true, unit: true, unitPrice: true, doc: { select: { effectiveAt: true } } }, orderBy: [{ doc: { effectiveAt: 'desc' } }, { id: 'desc' }],
    }),
    prisma.upstreamReceiptLine.findMany({
      // The manual inbound form records a CNY tax-inclusive total.  Do not use an
      // upstream contractual price unless it is the same monetary/tax basis.
      where: {
        tenantId: input.tenantId,
        productId: { in: input.productIds },
        acceptedQty: { gt: 0 },
        receipt: {
          tenantId: input.tenantId,
          supplierId: input.supplierId,
          status: 'POSTED',
          purchaseOrder: { currency: 'CNY', taxInclusive: true },
        },
      },
      select: { id: true, productId: true, purchaseUnit: true, unitPrice: true, receipt: { select: { postedAt: true, arrivedAt: true, createdAt: true } } }, orderBy: [{ receipt: { postedAt: 'desc' } }, { id: 'desc' }],
    }),
  ])
  const candidates: Array<PurchaseInboundPriceHistory & { tieBreakId: string }> = [
    ...manual.filter(row => row.unit === input.purchaseUnits[row.productId] && Number.isFinite(Number(row.unitPrice)) && Number(row.unitPrice) > 0).map(row => ({ productId: row.productId, purchaseUnit: row.unit, unitPrice: Number(row.unitPrice), effectiveAt: row.doc.effectiveAt, source: 'MANUAL_INBOUND' as const, tieBreakId: row.id })),
    ...upstream.filter(row => row.purchaseUnit === input.purchaseUnits[row.productId] && Number.isFinite(Number(row.unitPrice)) && Number(row.unitPrice) > 0).map(row => ({ productId: row.productId, purchaseUnit: row.purchaseUnit, unitPrice: Number(row.unitPrice), effectiveAt: row.receipt.postedAt || row.receipt.arrivedAt || row.receipt.createdAt, source: 'UPSTREAM_RECEIPT' as const, tieBreakId: row.id })),
  ]
  return Object.values(candidates.reduce<Record<string, PurchaseInboundPriceHistory & { tieBreakId: string }>>((latest, row) => {
    const key = `${row.productId}\u0000${row.purchaseUnit}`
    // Id makes a deterministic tie-breaker when two facts have the same clock
    // timestamp (for example an imported historical batch).
    if (!latest[key] || latest[key].effectiveAt < row.effectiveAt || (latest[key].effectiveAt.getTime() === row.effectiveAt.getTime() && row.tieBreakId > latest[key].tieBreakId)) latest[key] = row
    return latest
  }, {})).map(({ tieBreakId: _tieBreakId, ...row }) => row)
}
