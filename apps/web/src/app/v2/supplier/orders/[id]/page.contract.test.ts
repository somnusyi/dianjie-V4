import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('single confirmed-order shipment draft semantics', () => {
  it('keeps zero quantity visible and models removal separately', () => {
    expect(source).toContain("confirmedLines.filter(line => !removedShipmentItemIds.includes(line.it.id))")
    expect(source).toContain('数量 0 仍保留商品')
    expect(source).toContain('removeShipmentItem(row.itemId)')
    expect(source).toContain('restoreShipmentItem(itemId)')
    expect(source).toContain('已移除商品（可恢复）')
  })

  it('persists removal ids and submits removed items as zero', () => {
    expect(source).toContain('setRemovedShipmentItemIds(restored?.removedItemIds || [])')
    expect(source).toContain('removedItemIds: removedShipmentItemIds')
    expect(source).toContain('Object.fromEntries(removedShipmentItemIds.map(itemId => [itemId, 0]))')
    expect(source).toContain('lines.map(l => ({ itemId: l.it.id, shippedQty: l.sq }))')
    expect(source).toContain('if (!hasAnyPositiveShipment(lines))')
  })

  it('retains the single shared save control', () => {
    expect(source).toContain('onSave={() => void saveDetails()}')
    expect(source).not.toContain('>保存明细</button>')
  })
})
