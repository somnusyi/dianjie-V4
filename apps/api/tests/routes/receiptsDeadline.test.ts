import { describe, expect, it } from 'vitest'
import { withStoreReceiptDeadline } from '../../src/routes/receipts'

describe('receipt deadline route projection', () => {
  it('keeps an on-time confirmed receipt on time when viewed the next day', () => {
    const receipt = withStoreReceiptDeadline({
      deliveryDate: new Date('2026-09-24T00:00:00.000Z'),
      status: 'CONFIRMED',
      confirmedAt: new Date('2026-09-24T03:59:00.000Z'),
      purchaseOrder: { expectedDate: new Date('2026-09-24T00:00:00.000Z') },
    }, new Date('2026-09-25T08:00:00.000Z'))

    expect(receipt.storeReceiptDeadline).toMatchObject({
      overdue: false,
      requiresAction: false,
      source: 'RECEIPT_DELIVERY_DATE',
    })
  })

  it('uses the expected business date only while a receipt is still pending', () => {
    const receipt = withStoreReceiptDeadline({
      deliveryDate: new Date('2026-09-23T00:00:00.000Z'),
      status: 'PENDING_CONFIRM',
      purchaseOrder: { expectedDate: new Date('2026-09-24T00:00:00.000Z') },
    }, new Date('2026-09-24T04:00:00.001Z'))

    expect(receipt.storeReceiptDeadline).toMatchObject({
      overdue: true,
      requiresAction: true,
      source: 'PURCHASE_ORDER_EXPECTED_DATE',
    })
  })
})
