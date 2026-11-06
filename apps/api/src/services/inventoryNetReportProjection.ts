import { Prisma } from '@dianjie/db'

type CostValue = Prisma.Decimal | string | number | null
export type NetReportMovement = {
  id: string; effectiveAt: Date; physicalDelta: Prisma.Decimal; netValueDelta: CostValue; netValueAfter?: CostValue; valueDelta?: CostValue
}
const amount = (v: CostValue) => v == null ? null : new Prisma.Decimal(v)
/** All visible report costs derive from the same signed net deltas, never the gross ledger sum. */
export function summarizeNetReportCosts(events: NetReportMovement[], start: Date, endExclusive: Date) {
  let opening: Prisma.Decimal | null = new Prisma.Decimal(0)
  let inbound: Prisma.Decimal | null = new Prisma.Decimal(0)
  let outbound: Prisma.Decimal | null = new Prisma.Decimal(0)
  const plus = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) => a == null || b == null ? null : a.plus(b)
  for (const event of events) {
    if (event.effectiveAt >= endExclusive) continue
    const net = amount(event.netValueDelta)
    if (event.effectiveAt < start) { opening = plus(opening, net); continue }
    const isIn = event.physicalDelta.gt(0) || event.physicalDelta.eq(0) && (net == null ? event.valueDelta == null || new Prisma.Decimal(event.valueDelta).gte(0) : net.gte(0))
    if (isIn) inbound = plus(inbound, net)
    else outbound = plus(outbound, net?.negated() ?? null)
  }
  let closing = opening == null || inbound == null || outbound == null ? null : opening.plus(inbound).minus(outbound)
  // A pool confirmation proves the balance from its anchor onward, not fictitious old purchase deltas.
  // A posting-order prefix is necessary: future-effective postings followed by backdated ones cannot
  // use a cumulative snapshot for an earlier business-date cutoff.
  const provenAfter = (cutoff: Date) => {
    let excluded = false, last: NetReportMovement | undefined
    for (const event of events) {
      if (event.effectiveAt >= cutoff) excluded = true
      else { if (excluded) return undefined; last = event }
    }
    return last?.netValueAfter === undefined ? undefined : amount(last.netValueAfter)
  }
  const knownOpening = provenAfter(start), knownClosing = provenAfter(endExclusive)
  if (knownOpening !== undefined) opening = knownOpening
  closing = knownClosing !== undefined ? knownClosing : opening == null || inbound == null || outbound == null ? null : opening.plus(inbound).minus(outbound)
  const numeric = (v: Prisma.Decimal | null) => v == null ? null : v.toDecimalPlaces(4).toNumber()
  return { openingAmount: numeric(opening), inAmount: numeric(inbound), outAmount: numeric(outbound), closingAmount: numeric(closing),
    costStatus: opening == null || closing == null || inbound == null || outbound == null ? 'PENDING_COST' : 'KNOWN' }
}

export function netMovementReportCells(netValue: CostValue, inbound: boolean, originalQuantity: Prisma.Decimal) {
  const net = amount(netValue)?.abs() ?? null
  const price = net == null || originalQuantity.isZero() ? null : net.div(originalQuantity.abs()).toDecimalPlaces(6).toNumber()
  const value = net?.toDecimalPlaces(4).toNumber() ?? null
  return { inAmount: inbound ? value : 0, outAmount: inbound ? 0 : value, inPrice: inbound ? price : null, outPrice: inbound ? null : price,
    costStatus: net == null ? 'PENDING_COST' : 'KNOWN' }
}
