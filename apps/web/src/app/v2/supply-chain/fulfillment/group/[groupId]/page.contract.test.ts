import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('confirmed operation-group shipment removal recovery', () => {
  it('keeps every pending removal in the table with the shared inline restore interaction', () => {
    expect(source).toContain('{ ...item, pendingRemoval: true }')
    expect(source).toContain('{ ...item, pendingRemoval: false }')
    expect(source).toContain('onRestore={row =>')
    expect(source).toContain('if (row.pendingRemoval) return <>{row.quantity}{row.unit}</>')
    expect(source).toContain('rows={rows}')
    expect(source).not.toContain('已移除商品（可恢复）')
    expect(source).not.toContain('恢复 {row.name}')
    expect(source).not.toContain('每张原订单至少保留一个商品')
  })

  it('keeps zero quantity distinct from explicit removal', () => {
    expect(source).toContain('数量 0 仍保留商品')
    expect(source).toContain("shippedQty: row.pendingRemoval ? 0 : row.quantity")
    expect(source).toContain("...(row.pendingRemoval ? { removed: true } : {})")
    expect(source).toContain('rows.filter(row => !row.pendingRemoval)')
  })

  it('loads and saves one durable server shipment draft per confirmed source order', () => {
    expect(source).toContain('Promise.all(confirmedOrders.map(async order =>')
    expect(source).toContain(".filter(delivery => delivery.status === 'DRAFT')")
    expect(source).toContain('rowsFromDetail(data, nextShipmentDrafts)')
    expect(source).toContain('`/api/orders/${encodeURIComponent(order.id)}/shipment-draft`')
    expect(source).toContain("method: 'PUT'")
    expect(source).toContain('orderRowVersion: order.rowVersion')
    expect(source).toContain('draftRowVersion: shipmentDrafts[order.id].rowVersion')
    expect(source).toContain('purchaseOrderItemId: row.purchaseOrderItemId')
    expect(source).not.toContain('shipment-draft-storage')
    expect(source).not.toContain('writeShipmentDraft')
  })

  it('uses the editable product total until no group detail remains editable', () => {
    expect(source).toContain('const productTotal = rows.filter(row => !row.pendingRemoval)')
    expect(source).toContain('amount={money(detailEditable ? productTotal : detail.totals.hasAnyShipment ? detail.totals.shipmentAmount : productTotal)}')
  })

  it('adds warehouse products to an explicitly selected confirmed order or editable delivery', () => {
    expect(source).toContain('onAdd={detailEditable ? () => void openAdd() : undefined}')
    expect(source).toContain("...confirmedOrders.map(order => `order:${order.id}`)")
    expect(source).toContain("shipmentEditable && addDeliveryId.startsWith('order:')")
    expect(source).toContain('原订单 #{order.no} · 待发货')
    expect(source).toContain("['SHIPPED', 'DELIVERED'].includes(delivery.status) && !delivery.hasReceipt")
    expect(source).toContain("deliveryEditable && addDeliveryId.startsWith('delivery:')")
    expect(source).toContain('加入哪张原订单')
    expect(source).toContain('rowVersion: target.delivery.rowVersion')
    expect(source).toContain('`/api/deliveries/${encodeURIComponent(target.delivery.id)}/items`')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('quantityChanges: target.quantityChanges')
    expect(source).toContain('removals: target.removals')
    expect(source).toContain('additions: target.additions')
  })

  it('uses the same explicit select-and-confirm add-product dialog in the submitted phase', () => {
    expect(source).toContain('role="dialog" aria-modal="true"')
    expect(source).toContain("const [addProductId, setAddProductId] = useState('')")
    expect(source).toContain('aria-pressed={selected}')
    expect(source).toContain("selected ? 'border-l-amber bg-amber/20'")
    expect(source).toContain('✓ 已选择')
    expect(source).toContain("selectedIsRestore ? '确认恢复' : '确认增加'")
    expect(source).toContain('if (selectedAddProduct) addProduct(selectedAddProduct)')
    expect(source).not.toContain('onClick={() => addProduct(product)}')
    const addDialog = source.slice(source.indexOf('{addOpen &&'), source.indexOf('{confirmOpen &&'))
    expect(addDialog).toContain('fixed inset-0 z-50 flex items-center justify-center')
    expect(addDialog).not.toContain('items-end justify-center bg-ink/60')
  })

  it('hides active target products instead of silently adding one to an existing quantity', () => {
    expect(source).toContain('const activeAddProductIds = new Set(addTargetRows')
    expect(source).toContain('if (activeAddProductIds.has(product.id)) return false')
    expect(source).toContain('const pendingRemovalByProductId = new Map(addTargetRows')
    expect(source).toContain('if (pendingRemovalByProductId.has(product.id)) return true')
    const submittedAdd = source.slice(source.indexOf('if (!latestOrder) return'), source.indexOf('function clearDeliveryNotePreview'))
    expect(submittedAdd).toContain('该原订单已有此商品，请直接修改数量')
    expect(submittedAdd).not.toContain('existing.quantity + 1')
    expect(submittedAdd).toContain('isUnsavedAddition: true')
  })

  it('keeps frozen original-order snapshots available only for restoring removed rows', () => {
    expect(source).toContain('...detail.orders.flatMap(order => order.orderedItems)')
    expect(source).toContain("status: 'ORDER_SNAPSHOT'")
    expect(source).toContain("product.status === 'ENABLED' || snapshotProductIds.has(product.id)")
    expect(source).toContain('const recoverableOriginalByProductId = new Map((addTargetOrder?.orderedItems || [])')
    expect(source).toContain('if (recoverableOriginalByProductId.has(product.id)) return true')
    expect(source).toContain('const recoverableOriginal = recoverableOriginalByProductId.get(product.id)')
    expect(source).toContain("(!restoreSnapshot && pricing.status !== 'READY')")
    expect(source).toContain("(!selectedIsRestore && selectedAddPricing?.status !== 'READY')")
    expect(source).toContain('将按原订单冻结价')
    expect(source).toContain('{actionError && <div className="mt-3')
  })

  it('restores a disappeared original product into an editable delivery with its frozen values', () => {
    const deliveryAdd = source.slice(
      source.indexOf("if (deliveryEditable && addDeliveryId.startsWith('delivery:'))"),
      source.indexOf('if (!latestOrder) return'),
    )
    expect(deliveryAdd).toContain('const recoverableOriginal = order?.orderedItems.find')
    expect(deliveryAdd).toContain("if (!recoverableOriginal && pricing.status !== 'READY')")
    expect(deliveryAdd).toContain('name: recoverableOriginal?.name || product.name')
    expect(deliveryAdd).toContain("unit: recoverableOriginal?.unit || (pricing.status === 'READY'")
    expect(deliveryAdd).toContain('unitPrice: recoverableOriginal ? Number(recoverableOriginal.unitPrice)')
    expect(deliveryAdd).toContain('isDeliveryAddition: true')
  })

  it('passes the current unsaved group rows to the delivery note through a short-lived session token', () => {
    expect(source).toContain('function openDeliveryNote()')
    expect(source).toContain('rows.filter(item => !item.pendingRemoval)')
    expect(source).toContain('current.quantity += row.quantity')
    expect(source).toContain('current.amount += row.quantity * row.unitPrice')
    expect(source).toContain('window.sessionStorage.setItem(storageKey, JSON.stringify(preview))')
    expect(source).toContain('GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS')
    expect(source).toContain('schemaVersion: 2')
    expect(source).toContain('ownerUserId,')
    expect(source).toContain('tenantKey,')
    expect(source).toContain('serverSignature: operationGroupServerSignature(detail, shipmentDrafts)')
    expect(source).toContain('draftRows: rows')
    expect(source).toContain('delivery-note?preview=${encodeURIComponent(token)}')
    expect(source).toContain('onDeliveryNote={openDeliveryNote}')
    expect(source).not.toContain('delivery-note?preview=${encodeURIComponent(JSON.stringify')
  })

  it('restores unsaved rows only for the same user, tenant and unchanged server documents', () => {
    expect(source).toContain("const ownerUserId = String(getUser()?.id || '')")
    expect(source).toContain("window.localStorage.getItem('tenant')")
    expect(source).toContain("String(tenant?.id || tenant?.slug || '')")
    expect(source).toContain('function operationGroupServerSignature(')
    expect(source).toContain(".sort((a, b) => a.id.localeCompare(b.id))")
    expect(source).toContain(".filter(delivery => delivery.status !== 'DRAFT')")
    expect(source).toContain('Boolean(delivery.hasReceipt)')
    expect(source).toContain('preview.serverSignature !== operationGroupServerSignature(detail, shipmentDrafts)')
    expect(source).toContain("preview.ownerUserId === ownerUserId && preview.tenantKey === tenantKey")
    expect(source).toContain('expiresAt - createdAt !== GROUP_DELIVERY_NOTE_PREVIEW_TTL_MS')
    expect(source).toContain('const recoveredRows = draftRowsFromPreview(data, nextShipmentDrafts)')
    expect(source).toContain('setRows(recoveredRows || nextRows)')
    expect(source).toContain('setBaseline(fingerprint(baselineRows))')
    expect(source).toContain('discardDeliveryNotePreview(detail.group.id, token)')
  })

  it('invalidates an old preview before every new local row mutation', () => {
    for (const [start, end] of [
      ['function updateQuantity', 'function removeRow'],
      ['function removeRow', 'function removeShipmentRow'],
      ['function removeShipmentRow', 'function restoreShipmentRow'],
      ['function restoreShipmentRow', 'async function openAdd'],
    ]) {
      expect(source.slice(source.indexOf(start), source.indexOf(end))).toContain('clearDeliveryNotePreview()')
    }
    expect(source.slice(source.indexOf('function addProduct'), source.indexOf('function clearDeliveryNotePreview')))
      .toContain('clearDeliveryNotePreview()')
  })

  it('saves quantity changes and removals against each delivery row version', () => {
    expect(source).toContain('!row.isDeliveryAddition && !row.pendingRemoval && row.deliveryId === delivery.id')
    expect(source).toContain('{ itemId: row.itemId, targetQuantity: row.quantity }')
    expect(source).toContain('!row.isDeliveryAddition && row.pendingRemoval && row.deliveryId === delivery.id')
    expect(source).toContain('rowVersion: target.delivery.rowVersion')
    expect(source).toContain('editableDeliveryIds.has(row.deliveryId)')
    expect(source).toContain('canRemove={row =>')
  })

  it('reloads after a partial delivery save and restores only uncommitted edits for retry', () => {
    expect(source).toContain('const remainingDeliveryIds = new Set(mutationTargets.slice(index)')
    expect(source).toContain('await load()')
    expect(source).toContain('...remainingRows')
    expect(source).toContain('已保存 ${completed} 张配送单；剩余修改已保留，可重试')
  })

  it('keeps mixed confirmed drafts and editable delivery rows aligned with the dirty baseline', () => {
    expect(source).toContain('setBaseline(fingerprint(baselineRows))')
    expect(source).toContain('row.pendingRemoval === true')
  })

  it('keeps delivery editing available through delivered and locks it at receipt', () => {
    expect(source).toContain("['SHIPPED', 'DELIVERED'].includes(delivery.status) && !delivery.hasReceipt")
    expect(source).not.toContain("delivery.status === 'RECEIVED'")
  })

  it('ships a saved server draft without resubmitting its item mutations', () => {
    expect(source).toContain('const serverDraft = shipmentDrafts[order.id]')
    expect(source).toContain('...(serverDraft ? {')
    expect(source).toContain('draftRowVersion: serverDraft.rowVersion')
    expect(source).toContain('disabled={dirty || submitting}')
    expect(source).toContain("{dirty ? '请先保存实发数量' : '批量确认发货'}")
  })

  it('keeps the batch workflow actions separate from the shared save action', () => {
    expect(source).toContain('>批量接单</button>')
    expect(source).toContain("'批量确认发货'")
    expect(source).toContain('`批量确认送达 (${deliveringOrders.length})`')
    expect(source).toContain("order.status === 'DELIVERING'")
    expect(source).toContain("order.status === 'PENDING_CONFIRM'")
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('`/api/orders/${encodeURIComponent(order.id)}/deliver`')
    expect(source).toContain('onSave={() => void save()}')
    expect(source).toContain('已送达，待收货')
    expect(source).toContain('并进入收货阶段')
    expect(source).not.toContain('待门店确认')
  })

  it('loads and searches only warehouse-scoped supplier products', () => {
    expect(source).toContain('loadAllWarehouseProductCatalog(detail.group.supplierId)')
    expect(source).toContain('matchesWarehouseProductSearch(product, search)')
    expect(source).toContain('placeholder="搜索商品名称"')
    expect(source).toContain('[product.code, product.category, product.spec]')
  })
})
