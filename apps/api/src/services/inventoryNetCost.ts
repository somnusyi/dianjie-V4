import { Prisma } from '@dianjie/db'

type DecimalInput = Prisma.Decimal | string | number
export type NetCostEvent = {
  id: string
  quantityDelta: DecimalInput
  valueDelta: DecimalInput
  /** Source-document frozen tax-exclusive value; absent means unavailable. */
  netValueDelta?: DecimalInput | null
  netValueAfterOverride?: DecimalInput | null
  useAverageCost?: boolean
  reversalOfId?: string | null
  /** A documented zero-quantity correction changes the source value for later full reversal. */
  adjustmentOfId?: string | null
}

/** Input must follow immutable ledger posting order. Never guess current tax rates. */
export function projectInventoryNetCost(events: NetCostEvent[]) {
  let quantity = new Prisma.Decimal(0)
  let grossBalance = new Prisma.Decimal(0)
  let net: Prisma.Decimal | null = new Prisma.Decimal(0)
  const movements: Array<{ id: string; netValueDelta: Prisma.Decimal | null; netValueAfter: Prisma.Decimal | null; netValueAfterOverride?: Prisma.Decimal | null }> = []
  const unresolved = new Set<string>()
  const ids = new Set<string>()
  const originals = new Map<string, { quantity: Prisma.Decimal; gross: Prisma.Decimal; cost: Prisma.Decimal | null; reversedQuantity: Prisma.Decimal; reversedGross: Prisma.Decimal; reversedCost: Prisma.Decimal }>()
  for (const event of events) {
    if (ids.has(event.id)) throw new Error('Duplicate inventory cost movement')
    ids.add(event.id)
    const delta = new Prisma.Decimal(event.quantityDelta)
    const gross = new Prisma.Decimal(event.valueDelta)
    if (!delta.isFinite() || !gross.isFinite()) throw new Error('Invalid inventory cost movement')
    const next = quantity.plus(delta)
    if (next.lt(0)) throw new Error('Inventory cost movement exceeds physical balance')
    let cost: Prisma.Decimal | null = null
    const original = event.reversalOfId ? originals.get(event.reversalOfId) : null
    let returnedQuantity: Prisma.Decimal | null = null
    let returnedGross: Prisma.Decimal | null = null
    let finalReversal = false
    if (original) {
      const quantityDriven = !original.quantity.isZero()
      if (quantityDriven ? delta.isZero() || delta.isPositive() === original.quantity.isPositive() : !delta.isZero()) throw new Error('Invalid inventory reversal direction')
      returnedQuantity = original.reversedQuantity.plus(delta.abs())
      returnedGross = original.reversedGross.plus(gross.abs())
      if (returnedQuantity.gt(original.quantity.abs()) || returnedGross.gt(original.gross.abs())) throw new Error('Inventory reversal exceeds original quantity or amount')
      finalReversal = quantityDriven ? returnedQuantity.equals(original.quantity.abs()) : returnedGross.equals(original.gross.abs())
      const expectedGross = !quantityDriven ? gross.abs() : finalReversal
        ? original.gross.abs().minus(original.reversedGross)
        : original.gross.abs().mul(delta.abs()).div(original.quantity.abs()).toDecimalPlaces(4)
      if ((!gross.isZero() && gross.isPositive() !== original.gross.isNegative()) || !gross.abs().equals(expectedGross)) throw new Error('Inventory reversal does not match original frozen cost')
    }
    if (event.netValueDelta != null) {
      cost = new Prisma.Decimal(event.netValueDelta)
      if (!cost.isFinite() || gross.gt(0) && cost.lt(0) || gross.lt(0) && cost.gt(0)) throw new Error('Invalid frozen net basis')
    } else if (event.reversalOfId) {
      if (original?.cost != null && returnedQuantity) {
        const restored = finalReversal
          ? original.cost.abs().minus(original.reversedCost)
          : original.quantity.isZero() ? original.gross.isZero() ? new Prisma.Decimal(0) : original.cost.abs().mul(gross.abs()).div(original.gross.abs()).toDecimalPlaces(4)
          : original.cost.abs().mul(delta.abs()).div(original.quantity.abs()).toDecimalPlaces(4)
        cost = original.cost.isNegative() ? restored : restored.negated()
      }
    } else if (event.useAverageCost !== false && delta.lt(0) && gross.lte(0) && net != null && quantity.gt(0)) {
      cost = next.isZero() ? net.negated() : net.mul(delta).div(quantity).toDecimalPlaces(4)
    } else if (delta.isZero() && gross.isZero()) {
      cost = new Prisma.Decimal(0)
    }
    if (original && returnedQuantity && returnedGross) {
      if (cost != null) {
        const returnedNet = original.reversedCost.plus(cost.abs())
        if (original.cost != null && (returnedNet.gt(original.cost.abs()) || finalReversal && !returnedNet.equals(original.cost.abs()))) throw new Error('Inventory reversal exceeds original net cost')
        original.reversedCost = returnedNet
      }
      original.reversedQuantity = returnedQuantity
      original.reversedGross = returnedGross
    }
    if (event.adjustmentOfId) {
      const adjusted = originals.get(event.adjustmentOfId)
      if (!adjusted || !delta.isZero() || !adjusted.reversedQuantity.isZero() || !adjusted.reversedGross.isZero()) throw new Error('Invalid source value adjustment')
      const adjustedGross = adjusted.gross.plus(gross)
      const adjustedCost = adjusted.cost != null && cost != null ? adjusted.cost.plus(cost) : null
      if (adjustedGross.lt(0) || adjustedCost?.lt(0)) throw new Error('Source value adjustment exceeds original value')
      adjusted.gross = adjustedGross
      adjusted.cost = adjustedCost
    }
    if (cost == null) unresolved.add(event.id)
    net = net == null || cost == null ? null : net.plus(cost).toDecimalPlaces(4)
    if (net?.lt(0)) throw new Error('Frozen net cost exceeds available balance')
    quantity = next
    grossBalance = grossBalance.plus(gross)
    if (event.netValueAfterOverride != null) {
      const verifiedPool = new Prisma.Decimal(event.netValueAfterOverride)
      if (!verifiedPool.isFinite() || !quantity.gt(0) || verifiedPool.lte(0) || verifiedPool.gt(grossBalance)) throw new Error('Invalid confirmed inventory pool net basis')
      net = verifiedPool; cost = null; unresolved.clear()
    }
    if (quantity.isZero() && grossBalance.isZero()) {
      if (net != null && !net.isZero()) throw new Error('Net cost remains on depleted inventory')
      net = new Prisma.Decimal(0); unresolved.clear()
    } else if (quantity.isZero()) {
      net = null; unresolved.add(event.id)
    }
    movements.push({ id: event.id, netValueDelta: cost, netValueAfter: net, ...(event.netValueAfterOverride != null ? { netValueAfterOverride: new Prisma.Decimal(event.netValueAfterOverride) } : {}) })
    originals.set(event.id, { quantity: delta, gross, cost, reversedQuantity: new Prisma.Decimal(0), reversedGross: new Prisma.Decimal(0), reversedCost: new Prisma.Decimal(0) })
  }
  return {
    quantity, grossAmount: grossBalance, netAmount: net,
    netPrice: net != null && quantity.gt(0) ? net.div(quantity).toDecimalPlaces(6) : null,
    status: net == null ? 'PENDING_COST' as const : 'KNOWN' as const,
    unresolvedMovementIds: [...unresolved], movements,
  }
}
