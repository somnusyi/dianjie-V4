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

  it('reads member DRAFT versions only while verifying a locally valid group preview', () => {
    expect(source).toContain('const preview = readOperationGroupPreview(groupId)')
    expect(source).toContain('if (!preview) return null')
    expect(source).toContain('await Promise.all(data.orders.map(order =>')
    expect(source).toContain('`/api/orders/${encodeURIComponent(order.id)}`')
    expect(source).toContain(".filter(delivery => delivery.status === 'DRAFT')")
    expect(source).toContain("if (member.status !== 'CONFIRMED') return [member.id, null]")
  })

  it('deletes unverifiable snapshots and falls back to one coherent server document', () => {
    expect(source.match(/removeOperationGroupPreview\(groupId, preview\.token, preview\.storageKey\)/g)).toHaveLength(1)
    expect(source).toContain('return null')
    expect(source).toContain('normalizeOperationGroup(preview ? applyOperationGroupPreview(data, preview) : data)')
  })

  it('keeps a valid local snapshot when member reads fail transiently', () => {
    expect(source).toContain('A transient member-detail read failure makes this refresh unverifiable')
    expect(source).toContain('keeping the tab-scoped snapshot so returning to the group can revalidate')
    expect(source).toContain('operationGroupServerSignature(data, shipmentDrafts) !== preview.serverSignature')
  })

  it('keeps item JSON out of the delivery-note URL', () => {
    expect(source).toContain("return /^[0-9a-f-]{36}$/i.test(token) ? token : ''")
    expect(source).not.toContain("JSON.parse(new URLSearchParams(window.location.search)")
  })

  it('does not inspect group preview storage for a single order', () => {
    expect(source).toContain('if (isOperationGroup) {')
    expect(source).toContain('const preview = await verifyOperationGroupPreview(data, id)')
    expect(source).toContain('const data = await apiFetch<Order>(`/api/orders/${id}`)')
  })
})
