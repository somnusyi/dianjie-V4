import { describe, expect, it } from 'vitest'
import { buildWarehouseLedgerAudit } from '../../src/services/warehouseLedgerAudit'

const now = new Date('2026-08-02T00:00:00.000Z')

function validRows() {
  return {
    balances: [{ productId: 'p1', inventoryUnit: '袋', physicalQty: 12, reservedQty: 2, inventoryValue: 120, averageUnitCost: 10 }],
    movements: [
      { id: 'm0', type: 'OPENING_BALANCE', productId: 'p1', inventoryUnit: '袋', physicalDelta: 0, reservedDelta: 0, valueDelta: 0, physicalAfter: 0, reservedAfter: 0, valueAfter: 0, recordedAt: new Date(now.getTime() - 2000) },
      { id: 'm1', type: 'MANUAL_INBOUND', productId: 'p1', inventoryUnit: '袋', physicalDelta: 16, reservedDelta: 0, valueDelta: 160, physicalAfter: 16, reservedAfter: 0, valueAfter: 160, recordedAt: new Date(now.getTime() - 1000) },
      { id: 'm2', type: 'ORDER_RESERVED', productId: 'p1', inventoryUnit: '袋', physicalDelta: 0, reservedDelta: 2, valueDelta: 0, physicalAfter: 16, reservedAfter: 2, valueAfter: 160, recordedAt: new Date(now.getTime() - 500) },
      { id: 'm3', type: 'ORDER_OUTBOUND', productId: 'p1', inventoryUnit: '袋', physicalDelta: -4, reservedDelta: 0, valueDelta: -40, physicalAfter: 12, reservedAfter: 2, valueAfter: 120, recordedAt: now },
    ],
    activeReservations: [{ productId: 'p1', inventoryUnit: '袋', inventoryQuantity: 2, orderStatus: 'CONFIRMED' }],
    lots: [{ productId: 'p1', inventoryUnit: '袋', remainingQty: 12 }],
    requiredProducts: [{ id: 'p1', unitConversionStatus: 'VERIFIED' }],
  }
}

describe('warehouse ledger audit', () => {
  it('allows strict activation only when all four books reconcile', () => {
    const result = buildWarehouseLedgerAudit(validRows())
    expect(result).toMatchObject({ readyForStrict: true, blockerCount: 0, checkedSku: 1 })
  })

  it('detects balance, reservation and lot inconsistencies', () => {
    const rows = validRows()
    rows.balances[0].physicalQty = 11
    rows.balances[0].reservedQty = 3
    const result = buildWarehouseLedgerAudit(rows)
    expect(result.readyForStrict).toBe(false)
    expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining([
      'PHYSICAL_MOVEMENT_MISMATCH',
      'RESERVED_MOVEMENT_MISMATCH',
      'ACTIVE_RESERVATION_MISMATCH',
      'LOT_BALANCE_MISMATCH',
      'LATEST_MOVEMENT_AFTER_MISMATCH',
    ]))
  })

  it('blocks negative shadow gaps and mixed inventory units', () => {
    const rows = validRows()
    rows.balances[0].physicalQty = -1
    rows.balances[0].inventoryValue = -10
    rows.balances[0].averageUnitCost = 0
    rows.movements = [{ ...rows.movements[0], physicalDelta: -1, physicalAfter: -1, valueDelta: -10, valueAfter: -10, inventoryUnit: '斤' }]
    rows.activeReservations = []
    rows.lots = []
    const result = buildWarehouseLedgerAudit(rows)
    expect(result.issues.map(item => item.code)).toEqual(expect.arrayContaining([
      'NEGATIVE_PHYSICAL',
      'NEGATIVE_VALUE',
      'INVENTORY_UNIT_MISMATCH',
    ]))
  })

  it('never marks an empty or incomplete baseline ready for strict mode', () => {
    const empty = buildWarehouseLedgerAudit({
      balances: [], movements: [], activeReservations: [], lots: [],
      requiredProducts: [{ id: 'p1', unitConversionStatus: 'PENDING' }],
    })
    expect(empty.readyForStrict).toBe(false)
    expect(empty.issues.map(item => item.code)).toEqual(expect.arrayContaining([
      'SKU_BASELINE_MISSING',
      'UNIT_CONVERSION_UNVERIFIED',
    ]))
  })
})
