import { describe, expect, it } from 'vitest'
import { revenueCreateSchema, revenueQuerySchema } from '../../src/routes/revenue'

describe('revenue command validation', () => {
  it('keeps the legacy string channel payload compatible', () => {
    const parsed = revenueCreateSchema.safeParse({
      storeId: 'store-1',
      date: '2026-07-22',
      channels: {
        meituan: '12.34',
        douyin: '',
        maidan: '',
        wechat: '5',
        cash: '',
      },
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.channels).toEqual({
      meituan: 12.34,
      douyin: 0,
      maidan: 0,
      wechat: 5,
      cash: 0,
    })
  })

  it('keeps the v2 numeric channel payload compatible', () => {
    const parsed = revenueCreateSchema.safeParse({
      date: '2026-07-22',
      amount: 42.5,
      source: 'manual',
      channels: {
        wechatMini: 20,
        alipay: 5,
        cash: 2.5,
        meituanGmv: 10,
        meituanNet: 8,
        douyinGmv: 5,
        douyinNet: 4,
      },
    })

    expect(parsed.success).toBe(true)
  })

  it('accepts only a real calendar month query', () => {
    expect(revenueQuerySchema.safeParse({ month: '2026-07' }).success).toBe(true)
    expect(revenueQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false)
    expect(revenueQuerySchema.safeParse({ unexpected: 'true' }).success).toBe(false)
  })
})
