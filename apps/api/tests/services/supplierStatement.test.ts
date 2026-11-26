import { describe, expect, it } from 'vitest'
import { buildSupplierStatement, supplierStatementToCsv, type SupplierStatementSourceRow } from '../../src/services/supplierStatement'

function row(overrides: Partial<SupplierStatementSourceRow> = {}): SupplierStatementSourceRow {
  return {
    id: 'r1', no: 'RK1', deliveryDate: new Date('2026-07-01T00:00:00Z'), totalAmount: 90,
    store: { id: 's1', name: '门店一' },
    purchaseOrder: { id: 'po1', no: 'PO1', totalAmount: 100, currentOrderAmount: 100 },
    deliveryOrder: { id: 'do1', no: 'DO1', actualTotalAmount: 95 },
    paymentSchedule: {
      id: 'ps1', amount: 80, status: 'ON_HOLD', dueAt: new Date('2026-08-01T00:00:00Z'),
      paidAt: null, bankTxNo: null,
    },
    lossClaims: [{
      id: 'lc1', no: 'LC1', kind: 'ARRIVAL_DAMAGE', status: 'PENDING',
      payableBasis: 'GROSS_PENDING_CLAIM', totalLossAmount: 10, resolvedDeductAmount: null,
    }],
    ...overrides,
  }
}

describe('supplier monthly statement projection', () => {
  it('keeps ordered, shipped, received and payable amounts distinct', () => {
    const result = buildSupplierStatement([row()])
    expect(result.summary).toMatchObject({
      orderedAmount: 100, shipmentAmount: 95, receivedAmount: 90, payableAmount: 80,
      payableAdjustment: 10, differenceCount: 1, differenceAmount: 10,
      missingScheduleCount: 0, onHoldCount: 1,
    })
    expect(result.lines[0]).toMatchObject({
      orderedAmount: 100, shipmentAmount: 95, receivedAmount: 90, payableAmount: 80,
    })
  })

  it('deduplicates one purchase order split across multiple receipts', () => {
    const second = row({
      id: 'r2', no: 'RK2', totalAmount: 40,
      deliveryOrder: { id: 'do2', no: 'DO2', actualTotalAmount: 45 },
      paymentSchedule: null, lossClaims: [],
    })
    const result = buildSupplierStatement([row(), second])
    expect(result.summary.purchaseOrderCount).toBe(1)
    expect(result.summary.orderedAmount).toBe(100)
    expect(result.summary.shipmentAmount).toBe(140)
    expect(result.summary.missingScheduleCount).toBe(1)
  })

  it('exports every line with a UTF-8 BOM and neutralizes spreadsheet formulas', () => {
    const statement = buildSupplierStatement([row({ store: { id: 's1', name: '=危险门店' } })])
    const csv = supplierStatementToCsv(statement)
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv).toContain("'=危险门店")
    expect(csv).toContain('RK1')
    expect(csv).toContain('ON_HOLD')
  })
})

it('keeps a negative calculated adjustment numeric in CSV', () => {
  const data = row({ totalAmount: '90.12', paymentSchedule: { id: 'ps2', amount: '100.25', status: 'PENDING', dueAt: new Date('2026-08-01Z'), paidAt: null, bankTxNo: null } })
  const statement = buildSupplierStatement([data])
  expect(statement.lines[0].payableAdjustment).toBe(-10.13)
  const adjustmentCell = supplierStatementToCsv(statement).split('\r\n')[1].split(',')[9]
  expect(adjustmentCell).toBe('"-10.13"')
  expect(Number(adjustmentCell.slice(1, -1))).toBe(-10.13)
})
it.each(['=SUM(1)', '+1+2', '-1+2', '@SUM(1)'])('continues neutralizing untrusted document text %s', name => {
  const csv = supplierStatementToCsv(buildSupplierStatement([row({ store: { id: 's1', name } })]))
  expect(csv).toContain(`"'${name}"`)
})
