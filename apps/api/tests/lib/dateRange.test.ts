import { afterEach, expect, it } from 'vitest'
import { monthRangeForDateCol, monthRangeForTimestampCol } from '../../src/lib/dateRange'

const original = process.env.TZ
afterEach(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original })
it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('business month boundaries do not depend on host %s', tz => {
  process.env.TZ = tz
  const january = monthRangeForTimestampCol('2026-01')
  expect(january.start.toISOString()).toBe('2025-12-31T16:00:00.000Z')
  expect(january.end.toISOString()).toBe('2026-01-31T15:59:59.999Z')
  const february = monthRangeForTimestampCol('2024-02')
  expect(february.end.toISOString()).toBe('2024-02-29T15:59:59.999Z')
  const date = monthRangeForDateCol('2026-01')
  expect(date.start.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  expect(date.end.toISOString()).toBe('2026-01-31T23:59:59.999Z')
})
