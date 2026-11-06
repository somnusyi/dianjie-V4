export type PurchaseDraftOwner = { tenantId: string; userId: string; storeId: string }
export type PurchaseDraft = {
  supplierId: string; expectedDate: string; note: string
  items: Array<{ productId: string; quantity: number; unitPrice: number }>
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const TTL_MS = 7 * 86400_000
const newKey = () => `po-${Date.now()}-${Math.random().toString(36).slice(2,10)}`
export function purchaseDraftOwner(user: { id?: string; tenantId?: string } | null, storeId: string | null): PurchaseDraftOwner | null {
  return user?.id && user.tenantId && storeId ? { tenantId: user.tenantId, userId: user.id, storeId } : null
}
export function purchaseDraftKey(owner: PurchaseDraftOwner): string {
  return 'dj:po-new:draft:v2:' + [owner.tenantId, owner.userId, owner.storeId].map(encodeURIComponent).join(':')
}
export function samePurchaseDraftOwner(a: PurchaseDraftOwner | null, b: PurchaseDraftOwner | null): boolean {
  return Boolean(a && b && a.tenantId === b.tenantId && a.userId === b.userId && a.storeId === b.storeId)
}
function fingerprint(owner: PurchaseDraftOwner, draft: PurchaseDraft): string {
  // The API fingerprints business quantities, not its authoritative recalculated prices.
  return JSON.stringify({ storeId: owner.storeId, supplierId: draft.supplierId, expectedDate: draft.expectedDate,
    note: draft.note || null, items: draft.items.map(i => ({ productId: i.productId, quantity: i.quantity })).sort((a,b) => a.productId.localeCompare(b.productId)) })
}
function validDraft(d: any): d is PurchaseDraft {
  return d && typeof d.supplierId === 'string' && typeof d.expectedDate === 'string' && typeof d.note === 'string'
    && Array.isArray(d.items) && d.items.every((i: any) => typeof i.productId === 'string' && Number.isFinite(i.quantity) && i.quantity >= 0 && Number.isFinite(i.unitPrice))
}
/** A mounted editor owns exactly one trusted account/store scope. Never read or delete unknown-owner v1 drafts. */
export function createPurchaseDraftSession(storage: Storage, owner: PurchaseDraftOwner) {
  const key = purchaseDraftKey(owner)
  let current: PurchaseDraft | null = null, currentFingerprint: string | null = null, idempotencyKey = newKey()
  let timer: ReturnType<typeof setTimeout> | null = null, completed = false, disposed = false, inFlight = false
  let submittedKey: string | null = null
  let restored: { draft: PurchaseDraft; savedAt: number } | null = null
  try {
    const d = JSON.parse(storage.getItem(key) || 'null')
    if (d?.version === 2 && samePurchaseDraftOwner(owner, d.owner) && validDraft(d.draft)
      && Number.isFinite(d.savedAt) && Date.now() - d.savedAt <= TTL_MS && d.savedAt <= Date.now()
      && typeof d.idempotencyKey === 'string' && d.idempotencyKey.length >= 8 && d.idempotencyKey.length <= 80
      && d.fingerprint === fingerprint(owner, d.draft)) {
      current = d.draft; currentFingerprint = d.fingerprint; idempotencyKey = d.idempotencyKey
      restored = { draft: d.draft, savedAt: d.savedAt }
    }
  } catch { /* Unreadable local data never blocks the editor. */ }
  const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null }
  const flush = () => {
    cancel()
    if (completed || disposed || !current) return
    try {
      if (!current.items.length && !current.supplierId && !current.note) { storage.removeItem(key); return }
      storage.setItem(key, JSON.stringify({ version: 2, owner, draft: current, fingerprint: currentFingerprint, idempotencyKey, savedAt: Date.now() }))
    } catch { /* Storage unavailable/quota: submitting still uses the in-memory key. */ }
  }
  const update = (draft: PurchaseDraft) => {
    if (completed || disposed) return
    const next = fingerprint(owner, draft)
    if (currentFingerprint !== null && next !== currentFingerprint) idempotencyKey = newKey()
    currentFingerprint = next; current = JSON.parse(JSON.stringify(draft))
    cancel(); timer = setTimeout(flush, 400)
  }
  return {
    owner, restored,
    update, flush,
    beginSubmission(draft: PurchaseDraft): string | null {
      if (inFlight || completed || disposed) return null
      update(draft); flush(); inFlight = true; submittedKey = idempotencyKey
      return idempotencyKey
    },
    failSubmission() { inFlight = false },
    completeSubmission() {
      if (submittedKey !== idempotencyKey) flush()
      cancel(); completed = true; inFlight = false
      try {
        // A late response from an unmounted editor must not delete a newer edited draft.
        const stored = JSON.parse(storage.getItem(key) || 'null')
        if (stored?.idempotencyKey === submittedKey) storage.removeItem(key)
      } catch {}
    },
    clear() {
      cancel(); current = null; currentFingerprint = null; idempotencyKey = newKey()
      try { storage.removeItem(key) } catch {}
    },
    dispose() { flush(); cancel(); disposed = true },
  }
}
