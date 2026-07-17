import { describe, expect, it } from 'vitest'
import { calendarDateSchema } from '../../src/lib/calendar-date'

describe('calendar date validation', () => {
  it('accepts a real leap day', () => {
    expect(calendarDateSchema.safeParse('2024-02-29').success).toBe(true)
  })

  it.each(['2026-02-29', '2026-04-31', '2026-13-01'])('rejects a nonexistent date %s', value => {
    expect(calendarDateSchema.safeParse(value).success).toBe(false)
  })

  it.each(['2026-7-01', '01/07/2026', ''])('rejects a non-ISO date %s', value => {
    expect(calendarDateSchema.safeParse(value).success).toBe(false)
  })
})
