import { describe, expect, it } from 'vitest'
import { parseBoundedInteger, parsePagination } from '../../src/lib/pagination'

describe('pagination input normalization', () => {
  it('uses explicit defaults when values are absent', () => {
    expect(parsePagination({}, { defaultPageSize: 20, maxPageSize: 100 })).toEqual({ page: 1, pageSize: 20 })
  })

  it('accepts bounded integer strings', () => {
    expect(parsePagination({ page: '2', pageSize: '50' }, { defaultPageSize: 20, maxPageSize: 100 }))
      .toEqual({ page: 2, pageSize: 50 })
  })

  it.each(['NaN', '1.5', '1x', '-1', '0', '9007199254740992', Infinity, {}, []])(
    'rejects invalid integer input %p',
    value => expect(parseBoundedInteger(value, { defaultValue: 1, max: 100 })).toBeNull(),
  )

  it('rejects page and page-size values above their route bounds', () => {
    expect(parsePagination({ page: '100001' }, { defaultPageSize: 20, maxPageSize: 100 })).toBeNull()
    expect(parsePagination({ pageSize: '101' }, { defaultPageSize: 20, maxPageSize: 100 })).toBeNull()
  })
})
