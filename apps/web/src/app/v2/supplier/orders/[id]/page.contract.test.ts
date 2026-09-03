import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('single confirmed-order shipment draft semantics', () => {
  it('keeps zero quantity and unsaved removals visible with row-level restore', () => {
    expect(source).toContain('const pendingRemoval = removedShipmentItemIds.includes(line.it.id)')
    expect(source).toContain('shipmentRestoreQty[line.it.id] ?? savedShipQty[line.it.id] ?? line.remaining')
    expect(source).toContain('if (row.pendingRemoval) return <>{row.quantity}{row.unit}</>')
    expect(source).toContain('数量 0 仍保留商品')
    expect(source).toContain('removeShipmentItem(row.itemId, row.quantity)')
    expect(source).toContain('restoreShipmentItem(row.itemId, row.quantity)')
    expect(source).not.toContain('已移除商品（可恢复）')
  })

  it('saves a complete server-side shipment draft and reloads after success', () => {
    expect(source).toContain('`/api/orders/${order.id}/shipment-draft`')
    expect(source).toContain("method: 'PUT'")
    expect(source).toContain('orderRowVersion: order.rowVersion')
    expect(source).toContain('draftRowVersion: draftDelivery?.rowVersion ?? null')
    expect(source).toContain('purchaseOrderItemId: item.id')
    expect(source).toContain('shippedQty: removed ? 0 : row.quantity')
    expect(source).toContain('removed,')
    expect(source).toContain('load()')
    expect(source).toContain("setSaveNotice('商品明细已保存')")
  })

  it('uses a returned DRAFT delivery as the saved confirmed-order detail source', () => {
    expect(source).toContain("delivery.status === 'DRAFT'")
    expect(source).toContain('const confirmedDraftRows = draftDelivery ? draftDelivery.items.map')
    expect(source).toContain('...(draftDelivery ? confirmedDraftRows : confirmedLines')
    expect(source).toContain("...(!serverDraft ? { items: itemsBody, removedItemIds: removedShipmentItemIds } : {})")
  })

  it('retains the single shared save control', () => {
    expect(source).toContain('onSave={() => void saveDetails()}')
    expect(source).not.toContain('>保存明细</button>')
  })

  it('uses searchable warehouse products for order, confirmed-shipment, and delivery additions', () => {
    expect(source.match(/loadAllWarehouseProductCatalog\(/g)).toHaveLength(3)
    expect(source).toContain('isDirectOperationGroupRevision')
    expect(source).toContain('matchesWarehouseProductSearch(product, deliveryAddSearch)')
    expect(source).toContain('搜索商品名称')
    expect(source).not.toContain('<select value={deliveryAddProductId}')
    expect(source).toContain('void openShipmentAdd()')
    expect(source).toContain("source: 'shipment-addition' as const")
  })

  it('uses the shared single-select add-product dialog before accepting an order', () => {
    expect(source).toContain('(deliveryAddTarget || shipmentAddOpen || addOpen)')
    expect(source).toContain('const isSubmittedAdd = addOpen')
    expect(source).toContain('<h3 className="text-h2">增加商品</h3>')
    expect(source).toContain('fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4')
    expect(source).not.toContain('flex items-end justify-center bg-ink/60 p-4 sm:items-center')
    expect(source).toContain('aria-pressed={selected}')
    expect(source).toContain("selected ? 'border-l-amber bg-amber/20'")
    expect(source).toContain("selectedRestoresOriginal ? '确认恢复' : '确认增加'")
    expect(source).toContain('if (addOpen) {')
    expect(source).toContain('setAddQtyFor(product.id, 1)')
    expect(source).not.toContain('选择要加入明细的商品')
    expect(source).not.toContain('接单前改单申请抽屉')
  })

  it('keeps submitted removals visible until save and restores them in-row', () => {
    expect(source).toContain('...order.items.map(item => ({')
    expect(source).toContain('pendingRemoval: removedOrderProductIds.includes(item.productId)')
    expect(source).toContain('restoreOrderProduct(row.productId)')
    expect(source).toContain('.filter(([productId, q]) => q >= 0 && !removedOrderProductIds.includes(productId))')
  })

  it('keeps the current delivery as the detail source through receipt locking', () => {
    expect(source).toContain('const currentDelivery =')
    expect(source).toContain("['SHIPPED', 'DELIVERED'].includes(currentDelivery.status)")
    expect(source).toContain('!currentDelivery.receipt')
    expect(source).toContain('const detailRows = currentDelivery')
    expect(source).toContain('? deliveryRows')
    expect(source).toContain('const canEditSubmittedDetails = !currentDelivery')
    expect(source).toContain('const canEditConfirmedDetails = !currentDelivery')
    expect(source).not.toContain('const detailRows = canEditDeliveryDetails')
  })

  it('keeps shipped and delivered removal rows until the delivery save reloads', () => {
    expect(source).toContain("['SHIPPED', 'DELIVERED'].includes(currentDelivery.status)")
    expect(source).toContain('pendingRemoval: canEditDeliveryDetails && removedDeliveryItemIds.includes(item.id)')
    expect(source).not.toContain(".filter(item => !canEditDeliveryDetails || !removedDeliveryItemIds.includes(item.id))")
    expect(source).toContain('calculateSingleDeliveryNoteTotal(detailRows)')
    expect(source).toContain('restoreDeliveryItem(row.itemId)')
    expect(source).toContain("setSaveNotice('商品明细已保存')")
    expect(source).toContain('load()')
  })

  it('treats re-selecting an unsaved delivery removal as an undo', () => {
    expect(source).toContain('const pendingRemovedItem = deliveryAddTarget!.items.find')
    expect(source).toContain('item.productId === product.id && removedDeliveryItemIds.includes(item.id)')
    expect(source).toContain('restoreDeliveryItem(pendingRemovedItem.id)')
    expect(source).toContain('current.filter(item => item.productId !== productId)')
    expect(source).toContain('const pendingRemovedProductIds = isSubmittedAdd')
    expect(source).toContain('? new Set(removedOrderProductIds)')
    expect(source).toContain("selectedPendingRemoval || selectedRestoresOriginal ? '确认恢复' : '确认增加'")
    // Initial shipment already has an explicit local restore path as well.
    expect(source).toContain('restoreShipmentItem(row.itemId, row.quantity)')
  })

  it('keeps workflow actions separate and requires saving dirty shipment details first', () => {
    expect(source).toContain("order.status === 'SUBMITTED'")
    expect(source).toContain("order.status === 'CONFIRMED'")
    expect(source).toContain("order.status === 'DELIVERING'")
    expect(source).toContain('请先保存商品明细后再确认发货')
    expect(source).toContain('<button onClick={ship} disabled={submitting || detailsDirty}')
    expect(source).toContain("确认发货 (出发)")
  })

  it('opens every phase from the current detail rows with the same per-line money rule', () => {
    expect(source).toContain('function openSingleDeliveryNote()')
    expect(source).toContain('payload = buildSingleOrderPreviewPayload({')
    expect(source).toContain('rows: detailRows')
    expect(source).toContain('const detailTotal = calculateSingleDeliveryNoteTotal(detailRows) ?? 0')
    expect(source).toContain('onDeliveryNote={openSingleDeliveryNote}')
    expect(source).toContain('delivery-note?preview=${encodeURIComponent(token)}')
  })
})
