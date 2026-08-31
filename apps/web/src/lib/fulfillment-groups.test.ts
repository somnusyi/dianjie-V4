import { describe, expect, it } from 'vitest'
import { latestFulfillmentGroupOrderId, type FulfillmentGroup } from './fulfillment-groups'

describe('集合新增商品默认归属订单', () => {
  it('优先使用服务端按业务时间排序的完整成员列表', () => {
    const group = {
      orders: [{ id: 'visible-old', createdAt: '2026-08-31T10:00:00.000Z' }],
      metadata: { id: 'og_123456789012345678901234', memberOrderIds: ['old', 'latest'] },
    } as unknown as FulfillmentGroup
    expect(latestFulfillmentGroupOrderId(group)).toBe('latest')
  })

  it('兼容旧接口时按 submittedAt 再按 createdAt 选择最晚订单', () => {
    const group = {
      orders: [
        { id: 'a01', createdAt: '2026-08-31T12:00:00.000Z', submittedAt: '2026-08-31T09:00:00.000Z' },
        { id: 'a02', createdAt: '2026-08-31T10:00:00.000Z', submittedAt: '2026-08-31T11:15:00.000Z' },
      ],
      metadata: null,
    } as unknown as FulfillmentGroup
    expect(latestFulfillmentGroupOrderId(group)).toBe('a02')
  })
})
