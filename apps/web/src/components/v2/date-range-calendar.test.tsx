// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DateRangeCalendar } from './date-range-calendar'
import { DatePicker } from './date-quick-picker'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const originalZone = process.env.TZ
afterEach(() => {
  vi.useRealTimers()
  if (originalZone === undefined) delete process.env.TZ
  else process.env.TZ = originalZone
})

it.each([
  ['2026-11-08T04:00:00Z', '2026-11-02'],
  ['2026-11-08T16:01:00Z', '2026-11-09'],
])('本周一 uses the Monday of the Beijing week: %s', (instant, expected) => {
  process.env.TZ = 'America/Los_Angeles'
  vi.useFakeTimers()
  vi.setSystemTime(new Date(instant))
  const change = vi.fn()
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  try {
    act(() => root.render(<DatePicker value="" onChange={change} quickButtons={['weekStart']} />))
    act(() => node.querySelector('button')!.click())
    expect(change).toHaveBeenCalledWith(expected)
  } finally {
    act(() => root.unmount())
    node.remove()
  }
})

it.each([
  ['2026-11-05T16:01:00Z', '今天', '2026-11-06', '2026-11-06'],
  ['2026-11-05T16:01:00Z', '昨天', '2026-11-05', '2026-11-05'],
  ['2026-11-05T16:01:00Z', '近7天', '2026-10-31', '2026-11-06'],
  ['2026-12-31T16:01:00Z', '上月', '2026-12-01', '2026-12-31'],
])('calendar shortcut %s %s uses Beijing dates in a Los Angeles browser', (instant, shortcut, from, to) => {
  process.env.TZ = 'America/Los_Angeles'
  vi.useFakeTimers()
  vi.setSystemTime(new Date(instant))
  const change = vi.fn()
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  try {
    act(() => root.render(<DateRangeCalendar value={{ from: '', to: '' }} onChange={change} />))
    act(() => node.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    act(() => [...node.querySelectorAll('button')].find(button => button.textContent === shortcut)!.click())
    expect(change).toHaveBeenCalledWith({ from, to })
  } finally {
    act(() => root.unmount())
    node.remove()
  }
})
