export type OperationGroupProductSnapshotRow = {
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  unitPrice: number
  pendingRemoval?: boolean
}

export type OperationGroupEditableProductRow = OperationGroupProductSnapshotRow & {
  key: string
  originalQuantity: number
}

export type OperationGroupProductDisplayRow<T extends OperationGroupEditableProductRow> = {
  key: string
  mergeKey: string
  memberKeys: string[]
  members: T[]
  productId: string
  name: string
  spec: string | null
  unit: string
  quantity: number
  originalQuantity: number
  unitPrice: number
  amount: number
  pendingRemoval: boolean
  partialPendingRemoval: boolean
}

const QUANTITY_SCALE = 100
const MONEY_SCALE = 100

function quantityUnits(value: number) {
  return Math.round(value * QUANTITY_SCALE)
}

function fromQuantityUnits(value: number) {
  return Number((value / QUANTITY_SCALE).toFixed(2))
}

export function operationGroupProductMergeKey(row: OperationGroupProductSnapshotRow) {
  return `${row.productId}|${row.name}|${row.spec || ''}|${row.unit}`
}

export function operationGroupRoundedLineAmount(quantity: number, unitPrice: number) {
  const quantityHundredths = quantityUnits(quantity)
  const unitPriceCents = Math.round(unitPrice * MONEY_SCALE)
  return Math.round((quantityHundredths * unitPriceCents) / QUANTITY_SCALE) / MONEY_SCALE
}

/**
 * The batch editor keeps one row per original document internally, but exposes
 * the same product aggregation used by its delivery note. This keeps database
 * ownership intact while giving the operator one visible row per product.
 */
export function groupOperationGroupProductRows<T extends OperationGroupEditableProductRow>(
  rows: T[],
): OperationGroupProductDisplayRow<T>[] {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const key = operationGroupProductMergeKey(row)
    grouped.set(key, [...(grouped.get(key) || []), row])
  }

  return [...grouped.entries()].map(([mergeKey, members]) => {
    const activeMembers = members.filter(row => !row.pendingRemoval)
    const visibleMembers = activeMembers.length > 0 ? activeMembers : members
    const quantity = fromQuantityUnits(visibleMembers.reduce((sum, row) => sum + quantityUnits(row.quantity), 0))
    const amount = Number(visibleMembers.reduce(
      (sum, row) => sum + operationGroupRoundedLineAmount(row.quantity, row.unitPrice),
      0,
    ).toFixed(2))
    const first = visibleMembers[0] || members[0]
    return {
      key: `merged:${mergeKey}`,
      mergeKey,
      memberKeys: members.map(row => row.key),
      members,
      productId: first.productId,
      name: first.name,
      spec: first.spec,
      unit: first.unit,
      quantity,
      originalQuantity: fromQuantityUnits(members.reduce(
        (sum, row) => sum + quantityUnits(row.originalQuantity),
        0,
      )),
      unitPrice: Number((quantity > 0 ? amount / quantity : first.unitPrice).toFixed(2)),
      amount,
      pendingRemoval: activeMembers.length === 0,
      partialPendingRemoval: activeMembers.length > 0 && activeMembers.length < members.length,
    }
  })
}

export function updateOperationGroupProductQuantity<T extends OperationGroupEditableProductRow>(
  rows: T[],
  mergeKey: string,
  targetQuantity: number,
  canEdit: (row: T) => boolean,
  maxPerRow = 99_999_999.99,
): { rows: T[]; error: string | null } {
  const members = rows.filter(row => operationGroupProductMergeKey(row) === mergeKey && !row.pendingRemoval)
  const editableMembers = members.filter(canEdit)
  const lockedMembers = members.filter(row => !canEdit(row))
  if (members.length === 0 || editableMembers.length === 0) {
    return { rows, error: '该商品当前不能修改' }
  }

  const targetUnits = quantityUnits(targetQuantity)
  const lockedUnits = lockedMembers.reduce((sum, row) => sum + quantityUnits(row.quantity), 0)
  if (targetUnits < lockedUnits) {
    return { rows, error: `该商品已有 ${fromQuantityUnits(lockedUnits)} ${members[0].unit} 不可修改` }
  }

  // Recalculate from the server baseline on every keystroke. The same visible
  // target must always produce the same per-document allocation, regardless of
  // the sequence of intermediate values the operator typed.
  const nextUnits = new Map(editableMembers.map(row => [row.key, quantityUnits(row.originalQuantity)]))
  const desiredEditableUnits = targetUnits - lockedUnits
  const currentEditableUnits = [...nextUnits.values()].reduce((sum, value) => sum + value, 0)
  let remaining = desiredEditableUnits - currentEditableUnits

  if (remaining > 0) {
    const maxUnits = quantityUnits(maxPerRow)
    for (let index = editableMembers.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const row = editableMembers[index]
      const current = nextUnits.get(row.key) || 0
      const increment = Math.min(remaining, maxUnits - current)
      nextUnits.set(row.key, current + increment)
      remaining -= increment
    }
  } else if (remaining < 0) {
    let reduction = -remaining
    for (let index = editableMembers.length - 1; index >= 0 && reduction > 0; index -= 1) {
      const row = editableMembers[index]
      const current = nextUnits.get(row.key) || 0
      const decrement = Math.min(reduction, current)
      nextUnits.set(row.key, current - decrement)
      reduction -= decrement
    }
    remaining = -reduction
  }

  if (remaining !== 0) return { rows, error: '数量超过系统上限' }
  return {
    rows: rows.map(row => nextUnits.has(row.key)
      ? { ...row, quantity: fromQuantityUnits(nextUnits.get(row.key) || 0) }
      : row),
    error: null,
  }
}

export function setOperationGroupProductRemoval<T extends OperationGroupEditableProductRow>(
  rows: T[],
  mergeKey: string,
  pendingRemoval: boolean,
  canEdit: (row: T) => boolean,
): { rows: T[]; error: string | null } {
  const members = rows.filter(row => operationGroupProductMergeKey(row) === mergeKey)
  const editableMembers = members.filter(canEdit)
  if (members.length === 0 || editableMembers.length === 0) {
    return { rows, error: '该商品当前不能修改' }
  }
  // A mixed batch can contain an immutable delivered row and an editable
  // draft row for the same product. Only mutate the editable source rows;
  // the locked quantity remains visible in the merged row.
  const memberKeys = new Set(editableMembers.map(row => row.key))
  return {
    rows: rows.map(row => memberKeys.has(row.key) ? { ...row, pendingRemoval } : row),
    error: null,
  }
}
