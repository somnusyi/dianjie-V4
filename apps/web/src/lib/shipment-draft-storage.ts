export type ShipmentDraft = {
  version: 1
  orderId: string
  orderRowVersion: number
  userId: string
  quantities: Record<string, number>
  removedItemIds?: string[]
  updatedAt: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const PURCHASE_QUANTITY_MAX = 99_999_999.99

function safeRemove(storage: StorageLike, key: string) {
  try {
    storage.removeItem(key)
  } catch {
    // Storage can be disabled by browser privacy/security policy. Cleanup is best-effort.
  }
}

export function shipmentDraftStorageKey(input: {
  tenantId: string
  userId: string
  orderId: string
}) {
  return `dianjie:v2:shipment-draft:${input.tenantId}:${input.userId}:${input.orderId}`
}

export function readShipmentDraft(
  storage: StorageLike,
  key: string,
  expected: { orderId: string; orderRowVersion: number; userId: string; itemIds: string[] },
): ShipmentDraft | null {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    // Loading an order must never fail because browser storage is unavailable.
    return null
  }
  if (!raw) return null
  try {
    const draft = JSON.parse(raw) as ShipmentDraft
    const allowedItemIds = new Set(expected.itemIds)
    const entries = Object.entries(draft.quantities || {})
    const removedItemIds = Array.isArray(draft.removedItemIds) ? draft.removedItemIds : []
    const valid = draft.version === 1
      && draft.orderId === expected.orderId
      && draft.orderRowVersion === expected.orderRowVersion
      && draft.userId === expected.userId
      && entries.length > 0
      && entries.every(([itemId, quantity]) => allowedItemIds.has(itemId)
        && Number.isFinite(quantity)
        && quantity >= 0
        && quantity <= PURCHASE_QUANTITY_MAX
        && Math.abs(quantity * 100 - Math.round(quantity * 100)) < 0.000001)
      && new Set(removedItemIds).size === removedItemIds.length
      && removedItemIds.every(itemId => allowedItemIds.has(itemId) && draft.quantities[itemId] === 0)
    if (valid) return draft
  } catch {
    // Corrupt or obsolete drafts are removed below.
  }
  safeRemove(storage, key)
  return null
}

export function writeShipmentDraft(storage: StorageLike, key: string, draft: ShipmentDraft) {
  storage.setItem(key, JSON.stringify(draft))
}

export function clearShipmentDraft(storage: StorageLike, key: string) {
  safeRemove(storage, key)
}
