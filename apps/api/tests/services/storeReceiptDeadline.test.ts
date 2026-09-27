import { describe, expect, it } from 'vitest'
import {
  storeReceiptDateKey,
  storeReceiptDateFromArrivalAt,
  storeReceiptDeadlineAt,
  storeReceiptDeadlineStatus,
} from '../../src/services/storeReceiptDeadline'

describe('storeReceiptDeadline', () => {
  it('treats a database date as a date-only value and constructs noon in Asia/Shanghai', () => {
    const receiptDate = new Date('2026-09-24T00:00:00.000Z')

    expect(storeReceiptDateKey(receiptDate)).toBe('2026-09-24')
    expect(storeReceiptDeadlineAt(receiptDate).toISOString()).toBe('2026-09-24T04:00:00.000Z')
  })

  it('is on time at exactly noon and overdue strictly after noon', () => {
    const receiptDate = new Date('2026-09-24T00:00:00.000Z')

    expect(storeReceiptDeadlineStatus(receiptDate, new Date('2026-09-24T04:00:00.000Z'))).toMatchObject({
      overdue: false,
      requiresAction: false,
      requiresManualApproval: false,
    })
    expect(storeReceiptDeadlineStatus(receiptDate, new Date('2026-09-24T04:00:00.001Z'))).toMatchObject({
      overdue: true,
      requiresAction: true,
      requiresManualApproval: true,
    })
  })

  it('freezes an actual arrival timestamp to its Shanghai business date', () => {
    // 00:30 in Shanghai on the 24th is still the 23rd in UTC.
    expect(storeReceiptDateFromArrivalAt(new Date('2026-09-23T16:30:00.000Z')).toISOString())
      .toBe('2026-09-24T00:00:00.000Z')
  })
})
