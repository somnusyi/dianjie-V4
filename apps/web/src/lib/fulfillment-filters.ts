export type FulfillmentBucket = 'ALL' | 'SUBMITTED' | 'CONFIRMED' | 'DELIVERING'
export type FulfillmentOrderDayFilter = 'ALL' | 'TODAY' | 'YESTERDAY'

const BUCKETS = new Set<FulfillmentBucket>(['ALL', 'SUBMITTED', 'CONFIRMED', 'DELIVERING'])
const ORDER_DAYS = new Set<FulfillmentOrderDayFilter>(['ALL', 'TODAY', 'YESTERDAY'])

export function fulfillmentFiltersFromSearch(search: string | URLSearchParams): {
  bucket: FulfillmentBucket
  orderDay: FulfillmentOrderDayFilter
} {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const bucket = params.get('bucket') as FulfillmentBucket | null
  const orderDay = params.get('orderDay') as FulfillmentOrderDayFilter | null
  return {
    bucket: bucket && BUCKETS.has(bucket) ? bucket : 'ALL',
    orderDay: orderDay && ORDER_DAYS.has(orderDay) ? orderDay : 'ALL',
  }
}
