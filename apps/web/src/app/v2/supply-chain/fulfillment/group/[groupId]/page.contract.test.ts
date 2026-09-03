import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('confirmed operation-group shipment removal recovery', () => {
  it('keeps zero quantity distinct from explicit removal and exposes recovery', () => {
    expect(source).toContain('数量 0 仍保留商品')
    expect(source).toContain('restoreShipmentRow(row)')
    expect(source).toContain('已移除商品（可恢复）')
    expect(source).toContain('恢复 {row.name}')
    expect(source).toContain('(shipmentEditable || deliveryEditable) ? <div')
  })

  it('blocks saving when a confirmed source order has no active shipment row', () => {
    expect(source).toContain(".filter(order => order.status === 'CONFIRMED')")
    expect(source).toContain('.find(order => !rows.some(row => row.orderId === order.id))')
    expect(source).toContain('的所有商品已被移除')
  })

  it('uses the editable product total until no group detail remains editable', () => {
    expect(source).toContain('amount={money(detailEditable ? productTotal : detail.totals.hasAnyShipment ? detail.totals.shipmentAmount : productTotal)}')
  })

  it('adds products only to an explicitly selected editable delivery', () => {
    expect(source).toContain("delivery.status === 'SHIPPED' && !delivery.hasReceipt")
    expect(source).toContain('加入哪张原订单配送单')
    expect(source).toContain('const delivery = editableDeliveries.find(candidate => candidate.id === addDeliveryId)')
    expect(source).toContain('rowVersion: target.delivery.rowVersion')
    expect(source).toContain('`/api/deliveries/${encodeURIComponent(target.delivery.id)}/items`')
    expect(source).toContain("method: 'PATCH'")
    expect(source).toContain('quantityChanges: target.quantityChanges')
    expect(source).toContain('removals: target.removals')
    expect(source).toContain('additions: target.additions')
  })

  it('saves quantity changes and removals against each delivery row version', () => {
    expect(source).toContain('!row.isDeliveryAddition && row.deliveryId === delivery.id')
    expect(source).toContain('{ itemId: row.itemId, targetQuantity: row.quantity }')
    expect(source).toContain("removedShipmentRows\n          .filter(row => row.deliveryId === delivery.id)")
    expect(source).toContain('rowVersion: target.delivery.rowVersion')
    expect(source).toContain('editableDeliveryIds.has(row.deliveryId)')
    expect(source).toContain('canRemove={row =>')
  })

  it('reloads after a partial delivery save and restores only uncommitted edits for retry', () => {
    expect(source).toContain('const remainingDeliveryIds = new Set(mutationTargets.slice(index)')
    expect(source).toContain('await load()')
    expect(source).toContain('...remainingRows')
    expect(source).toContain('setRemovedShipmentRows(current => [')
    expect(source).toContain('...current.filter(row => !row.deliveryId)')
    expect(source).toContain('...remainingRemovedRows')
    expect(source).toContain('已保存 ${completed} 张配送单；剩余修改已保留，可重试')
  })

  it('keeps mixed confirmed drafts and editable delivery rows aligned with the dirty baseline', () => {
    expect(source).toContain('setBaseline(fingerprint(editableRows))')
    expect(source).not.toContain('setBaseline(fingerprint(shipmentRows.filter(row => confirmedOrderIds.has(row.orderId))))')
  })

  it('never offers delivery editing for received or non-shipped deliveries', () => {
    expect(source).not.toContain("delivery.status === 'DELIVERED' && !delivery.hasReceipt")
    expect(source).not.toContain("delivery.status === 'RECEIVED'")
    expect(source).toContain(".filter(delivery => delivery.status === 'SHIPPED' && !delivery.hasReceipt)")
  })
})
