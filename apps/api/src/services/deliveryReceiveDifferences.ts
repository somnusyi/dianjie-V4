export type DeliveryDifferenceKind = 'ARRIVAL_SHORTAGE' | 'ARRIVAL_DAMAGE'

export type DeliveryDifferenceLine = {
  kind: DeliveryDifferenceKind
  reason: string | null
}

export type DeliveryDifferenceGroup<T extends DeliveryDifferenceLine> = {
  kind: DeliveryDifferenceKind
  lines: T[]
}

/**
 * One store receipt may contain shortage and damage on different products.
 * The LossClaim header has one kind, so keep one shared receipt and split only
 * by kind. Per-product reasons live on LossClaimItem; splitting by reason would
 * change the two-decimal rounding boundary and could make the payable amount
 * depend on how the operator worded otherwise identical differences.
 */
export function groupDeliveryReceiveDifferences<T extends DeliveryDifferenceLine>(
  lines: T[],
): DeliveryDifferenceGroup<T>[] {
  const grouped = new Map<DeliveryDifferenceKind, { kind: DeliveryDifferenceKind; lines: T[] }>()
  for (const line of lines) {
    const group = grouped.get(line.kind) || { kind: line.kind, lines: [] }
    group.lines.push(line)
    grouped.set(line.kind, group)
  }
  return [...grouped.values()]
}
