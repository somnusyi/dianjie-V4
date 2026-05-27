import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseOrderListResponse,
  parseRefundOrderListResponse,
  resolveChannel,
} from '../../../src/services/meituan/parser'

const fxDir = join(__dirname, '../../../src/services/meituan/fixtures')
const loadFx = (name: string) => JSON.parse(readFileSync(join(fxDir, name), 'utf-8'))

describe('parseOrderListResponse', () => {
  it('page1 → 2 单订单, 第 1 单 4 个 itemList, 1 个 payList', () => {
    const fx = loadFx('instore-order-page1-success.json')
    const parsed = parseOrderListResponse(fx)
    expect(parsed.orders).toHaveLength(2)
    expect(parsed.total).toBe(2)
    expect(parsed.totalPageCount).toBe(1)
    expect(parsed.orders[0].mtOrderId).toBe('10001')
    expect(parsed.orders[0].items).toHaveLength(4)
    expect(parsed.orders[0].payments).toHaveLength(1)
    expect(parsed.orders[0].payments[0].payTypeName).toBe('微信')
    expect(parsed.orders[0].payed).toBe(12000)
  })

  it('itemList 数量正确, count 保留小数精度', () => {
    const fx = loadFx('instore-order-page1-success.json')
    const parsed = parseOrderListResponse(fx)
    const items = parsed.orders[0].items
    expect(items.find(i => i.name === '米饭')?.count.toString()).toBe('2')
    expect(items.find(i => i.name === '可乐')?.totalPrice).toBe(1600)
  })

  it('mtOrderId 永远是 string (防 long 溢出)', () => {
    const fx = loadFx('instore-order-page1-success.json')
    const parsed = parseOrderListResponse(fx)
    expect(typeof parsed.orders[0].mtOrderId).toBe('string')
  })

  it('businessTime "yyyy-MM-dd" 解析为本地 Date', () => {
    const fx = loadFx('instore-order-page1-success.json')
    const parsed = parseOrderListResponse(fx)
    expect(parsed.orders[0].businessTime.toISOString().startsWith('2026-05-27')).toBe(true)
  })

  it('空 orderList 也能 parse', () => {
    const fx = loadFx('instore-order-empty.json')
    const parsed = parseOrderListResponse(fx)
    expect(parsed.orders).toHaveLength(0)
    expect(parsed.total).toBe(0)
  })

  it('缺失可选字段不 throw', () => {
    const minimal = {
      code: 'OP_SUCCESS',
      data: {
        orderList: [{
          orderBase: { id: 999, orderNo: 'X', status: 300, payed: 100, receivable: 100, amount: 100, income: 100, businessTime: '2026-05-27', poiId: 1, orgId: 1 },
        }],
        total: 1, pageNo: 1, pageSize: 50, totalPageCount: 1,
      },
    }
    const parsed = parseOrderListResponse(minimal as any)
    expect(parsed.orders[0].items).toEqual([])
    expect(parsed.orders[0].payments).toEqual([])
  })
})

describe('parseRefundOrderListResponse', () => {
  it('退单 fixture → 1 个 refundOrder', () => {
    const fx = loadFx('reverse-order-list.json')
    const parsed = parseRefundOrderListResponse(fx)
    expect(parsed.refunds).toHaveLength(1)
    expect(parsed.refunds[0].mtRefundId).toBe('9001')
    expect(parsed.refunds[0].mtOrderId).toBe('10001')
    expect(parsed.refunds[0].refundAmount).toBe(1600)
  })
})

describe('resolveChannel', () => {
  it('typeName "堂食" → INSTORE', () => {
    expect(resolveChannel({ typeName: '堂食' } as any)).toBe('INSTORE')
  })
  it('payList 含美团外卖 → WAIMAI_MT', () => {
    expect(resolveChannel({ typeName: '外卖' } as any, [{ payTypeName: '美团外卖' }] as any)).toBe('WAIMAI_MT')
  })
  it('payList 含饿了么 → WAIMAI_ELE', () => {
    expect(resolveChannel({ typeName: '外卖' } as any, [{ payTypeName: '饿了么' }] as any)).toBe('WAIMAI_ELE')
  })
  it('未识别 → UNKNOWN', () => {
    expect(resolveChannel({ typeName: 'XXX' } as any)).toBe('UNKNOWN')
  })
})
