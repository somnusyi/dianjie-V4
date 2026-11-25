import { describe, expect, it } from 'vitest'
import { fulfillmentFiltersFromSearch } from './fulfillment-filters'

describe('履约页面查询筛选', () => {
  it('恢复状态和订货日组合筛选', () => {
    expect(fulfillmentFiltersFromSearch('bucket=CONFIRMED&orderDay=TODAY')).toEqual({ bucket: 'CONFIRMED', orderDay: 'TODAY' })
    expect(fulfillmentFiltersFromSearch('bucket=DELIVERING&orderDay=YESTERDAY')).toEqual({ bucket: 'DELIVERING', orderDay: 'YESTERDAY' })
  })

  it('独立接单入口清除旧订货日筛选', () => {
    expect(fulfillmentFiltersFromSearch('bucket=SUBMITTED')).toEqual({ bucket: 'SUBMITTED', orderDay: 'ALL' })
  })

  it('未知参数安全回退全部待办', () => {
    expect(fulfillmentFiltersFromSearch('bucket=COMPLETED&orderDay=EARLIER')).toEqual({ bucket: 'ALL', orderDay: 'ALL' })
  })
})
