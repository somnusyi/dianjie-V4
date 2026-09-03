import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('delivery note live refresh contract', () => {
  it('refreshes when the document becomes active again', () => {
    expect(source).toContain("window.addEventListener('focus', refreshWhenActive)")
    expect(source).toContain("document.addEventListener('visibilitychange', refreshWhenVisible)")
    expect(source).toContain("document.visibilityState === 'visible'")
    expect(source).toContain("window.removeEventListener('focus', refreshWhenActive)")
    expect(source).toContain("document.removeEventListener('visibilitychange', refreshWhenVisible)")
  })

  it('refreshes and renders latest details before every document action', () => {
    expect(source.match(/await refreshBeforeDocumentAction\(\)/g)).toHaveLength(3)
    expect(source).toContain('async function exportPDF()')
    expect(source).toContain('async function exportExcel()')
    expect(source).toContain('async function tryPrint()')
    expect(source).toContain('await waitForDocumentPaint()')
  })

  it('invalidates generated artifacts when a newer document is adopted', () => {
    expect(source).toContain('artifactEpochRef.current += 1')
    expect(source).toContain('setPdfUrl(null)')
    expect(source).toContain('setPdfBlob(null)')
    expect(source).toContain('setOssUrl(null)')
    expect(source).toContain('artifactEpoch === artifactEpochRef.current')
  })

  it('reapplies only a valid schema-v2 group-page preview after every server refresh', () => {
    expect(source).toContain('function readOperationGroupPreview(groupId: string)')
    expect(source).toContain("new URLSearchParams(window.location.search).get('preview')")
    expect(source).toContain("window.sessionStorage.getItem(storageKey)")
    expect(source).toContain('payload.schemaVersion !== 2')
    expect(source).toContain('payload.ownerUserId !== ownerUserId')
    expect(source).toContain('payload.tenantKey !== tenantKey')
    expect(source).toContain('payload.groupId !== groupId')
    expect(source).toContain('expiresAt - createdAt !== GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS')
    expect(source).toContain('expiresAt <= now')
    expect(source).toContain('!Array.isArray(payload.draftRows)')
    expect(source).toContain('const projection = parseOperationGroupDeliveryNoteProjection({')
    expect(source).toContain('draftRows: payload.draftRows')
    expect(source).toContain('items: projection.items')
    expect(source).toContain('totals: projection.totals')
    expect(source).toContain('mergedItems: preview.items')
    expect(source).toContain('preview ? applyOperationGroupPreview(data, preview) : data')
  })

  it('binds the preview to the exact order, draft, and non-draft delivery versions', () => {
    expect(source).toContain('function operationGroupServerSignature(')
    expect(source).toContain('.sort((a, b) => a.id.localeCompare(b.id))')
    expect(source).toContain('Number(order.rowVersion)')
    expect(source).toContain("String(order.status || '')")
    expect(source).toContain('draft ? [draft.id, Number(draft.rowVersion)] : null')
    expect(source).toContain(".filter(delivery => delivery.status !== 'DRAFT')")
    expect(source).toContain('Boolean(delivery.hasReceipt)')
    expect(source).toContain('operationGroupServerSignature(data, shipmentDrafts) !== preview.serverSignature')
  })

  it('reads member DRAFT versions from the same coherent group response', () => {
    expect(source).toContain('const preview = readOperationGroupPreview(groupId)')
    expect(source).toContain('if (!preview) return null')
    expect(source).toContain('const shipmentDrafts = Object.fromEntries(data.orders.map(member => [')
    expect(source).toContain("member.status === 'CONFIRMED' && member.shipmentDraft")
    expect(source).not.toContain('`/api/orders/${encodeURIComponent(order.id)}`')
  })

  it('deletes unverifiable snapshots and fails closed for an explicitly requested preview', () => {
    expect(source.match(/removeOperationGroupPreview\(groupId, preview\.token, preview\.storageKey\)/g)).toHaveLength(1)
    expect(source).toContain('if (deliveryNotePreviewRequested() && !preview)')
    expect(source).toContain("throw new Error('送货单预览已失效，请返回商品明细重新打开')")
  })

  it('still renders one coherent server document when no preview was requested', () => {
    expect(source).toContain('normalizeOperationGroup(preview ? applyOperationGroupPreview(data, preview) : data)')
    expect(source).toContain('return { order: normalized.order, members: normalized.members }')
  })

  it('keeps item JSON out of the delivery-note URL', () => {
    expect(source).toContain("return /^[0-9a-f-]{36}$/i.test(token) ? token : ''")
    expect(source).not.toContain("JSON.parse(new URLSearchParams(window.location.search)")
  })

  it('verifies and applies a valid single-order preview against the server version', () => {
    expect(source).toContain('if (isOperationGroup) {')
    expect(source).toContain('const preview = await verifyOperationGroupPreview(data, id)')
    expect(source).toContain('const data = await apiFetch<Order>(`/api/orders/${id}`)')
    expect(source).toContain('const preview = verifySingleOrderPreview(data, id)')
    expect(source).toContain('singleOrderServerSignature(data) !== preview.serverSignature')
    expect(source).toContain('preview ? applySingleOrderPreview(normalized, preview) : normalized')
  })

  it('uses a saved confirmed DRAFT as the coherent no-preview server fallback', () => {
    expect(source).toContain("const shipmentDraft = data.status === 'CONFIRMED'")
    expect(source).toContain(".find(delivery => delivery.status === 'DRAFT')")
    expect(source).toContain('totalAmount: shipmentDraft.actualTotalAmount')
    expect(source).toContain('items: shipmentDraft.items.map(item => ({')
    expect(source).toContain('shippedQty: item.shippedQty')
    expect(source).not.toContain('no: shipmentDraft.no')
  })

  it('renders and exports the authoritative line amount for single and group documents', () => {
    expect(source).toContain("const itemAmtLocal = (i: Order['items'][number]) => i.amount != null")
    expect(source).toContain("const itemAmt = (i: Order['items'][number]) => i.amount != null")
    expect(source).not.toContain('isOperationGroup && i.amount != null')
  })
})
