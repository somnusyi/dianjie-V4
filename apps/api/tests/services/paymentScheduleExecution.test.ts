import { describe, expect, it } from 'vitest'
import { isPaymentScheduleExecutable } from '../../src/services/paymentSchedule'

const now = new Date('2026-07-25T04:00:00.000Z')
const due = new Date('2026-07-25T00:00:00.000Z')
const candidate = {
  status: 'PENDING',
  needApproval: false,
  dueAt: due,
  retryCount: 0,
}

describe('payment schedule execution gate', () => {
  it('allows only due approved or no-approval schedules', () => {
    expect(isPaymentScheduleExecutable(candidate, now)).toBe(true)
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'APPROVED', needApproval: true }, now)).toBe(true)
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'PENDING', needApproval: true }, now)).toBe(false)
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'PENDING_APPROVAL', needApproval: true }, now)).toBe(false)
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'ON_HOLD' }, now)).toBe(false)
  })

  it('bounds overdue retries and rejects future schedules', () => {
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'OVERDUE', retryCount: 4 }, now)).toBe(true)
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'OVERDUE', retryCount: 5 }, now)).toBe(false)
    expect(isPaymentScheduleExecutable({ ...candidate, status: 'OVERDUE', needApproval: true }, now)).toBe(false)
    expect(isPaymentScheduleExecutable({
      ...candidate,
      status: 'APPROVED',
      dueAt: new Date('2026-07-27T00:00:00.000Z'),
    }, now)).toBe(false)
  })
})
