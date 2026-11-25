import { describe, expect, it } from 'vitest'
import { fulfillmentOrderDay, latestFulfillmentGroupOrderId, loadAllActionableFulfillmentOrders, type FulfillmentGroup } from './fulfillment-groups'

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

describe('履约订货业务日', () => {
  const now = '2026-11-20T16:30:00.000Z' // 北京时间 11 月 21 日 00:30

  it('按北京时间区分今日、昨日和更早', () => {
    expect(fulfillmentOrderDay({ submittedAt: '2026-11-20T16:05:00.000Z', createdAt: '2026-11-19T00:00:00.000Z' }, now)).toBe('TODAY')
    expect(fulfillmentOrderDay({ submittedAt: '2026-11-20T15:59:59.000Z', createdAt: '2026-11-19T00:00:00.000Z' }, now)).toBe('YESTERDAY')
    expect(fulfillmentOrderDay({ submittedAt: '2026-11-18T15:59:59.000Z', createdAt: '2026-11-18T15:59:59.000Z' }, now)).toBe('EARLIER')
  })

  it('submittedAt 缺失时才回退 createdAt', () => {
    expect(fulfillmentOrderDay({ submittedAt: null, createdAt: '2026-11-20T17:00:00.000Z' }, now)).toBe('TODAY')
    expect(fulfillmentOrderDay({ submittedAt: '2026-11-20T15:00:00.000Z', createdAt: '2026-11-20T17:00:00.000Z' }, now)).toBe('YESTERDAY')
  })
})

describe('履约待办完整分页', () => {
  const createdAt = '2026-11-20T17:00:00.000Z'

  it('拉齐超过 100 条的第二页并保持今日／昨日计数准确', async () => {
    const confirmed = Array.from({ length: 101 }, (_, index) => ({
      id: `confirmed-${String(index).padStart(3, '0')}`,
      status: 'CONFIRMED',
      createdAt,
      submittedAt: index === 100 ? '2026-11-20T15:00:00.000Z' : createdAt,
    }))
    const delivering = [{ id: 'delivering-yesterday', status: 'DELIVERING', createdAt, submittedAt: '2026-11-20T14:00:00.000Z' }]
    const calls: string[] = []
    const rows = await loadAllActionableFulfillmentOrders(async (status, page, pageSize) => {
      calls.push(`${status}:${page}`)
      const source = status === 'CONFIRMED' ? confirmed : status === 'DELIVERING' ? delivering : []
      return { items: source.slice((page - 1) * pageSize, page * pageSize), total: source.length, page, pageSize }
    })

    expect(calls).toContain('CONFIRMED:2')
    expect(rows).toHaveLength(102)
    expect(rows.filter(order => fulfillmentOrderDay(order, '2026-11-20T18:00:00.000Z') === 'TODAY')).toHaveLength(100)
    expect(rows.filter(order => fulfillmentOrderDay(order, '2026-11-20T18:00:00.000Z') === 'YESTERDAY')).toHaveLength(2)
    expect(rows.some(order => order.id === 'confirmed-100')).toBe(true)
  })

  it('只请求三个待办状态，权限或分页请求失败时不返回部分结果', async () => {
    const calls: string[] = []
    await expect(loadAllActionableFulfillmentOrders(async status => {
      calls.push(status)
      if (status === 'CONFIRMED') throw new Error('403 无权查看采购订单')
      return { items: [], total: 0, page: 1, pageSize: 100 }
    })).rejects.toThrow('403')
    expect(calls.sort()).toEqual(['CONFIRMED', 'DELIVERING', 'SUBMITTED'])
    expect(calls).not.toContain('COMPLETED')
  })
})
