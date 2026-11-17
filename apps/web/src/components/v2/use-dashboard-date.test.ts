import { afterEach, describe, expect, it, vi } from 'vitest'
import { greetingFor } from './use-dashboard'

afterEach(() => { vi.useRealTimers() })

describe('工作台北京时间', () => {
  it.each([
    ['2026-11-05T15:59:59Z', '周四 · 11/05'],
    ['2026-11-05T16:00:00Z', '周五 · 11/06'],
    ['2026-12-31T16:00:00Z', '周五 · 01/01'],
  ])('北京时间跨日时同步显示星期和日期：%s', (instant, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(instant))
    expect(greetingFor('经办甲').today).toBe(expected)
    expect(greetingFor('经办甲').greeting).toBe('你好，经办甲')
  })
})
