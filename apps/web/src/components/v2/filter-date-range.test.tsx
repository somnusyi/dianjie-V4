// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterDateRange } from './filter-date-range'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root; let container: HTMLDivElement
const change = vi.fn()
const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
const click = (label: string) => act(() => button(label).click())
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T01:00:00Z')); change.mockReset()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  act(() => root.render(<FilterDateRange value={{ start: '2026-08-23', end: '2026-09-23' }} onChange={change} />))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })
describe('shared SCM date range', () => {
  it('opens both months; first click waits, second commits both endpoints and closes', () => {
    click('选择日期范围')
    expect(document.querySelector('section[aria-label="2026年8月"]')).not.toBeNull()
    expect(document.querySelector('section[aria-label="2026年9月"]')).not.toBeNull()
    click('2026-09-21'); expect(change).not.toHaveBeenCalled()
    expect(document.querySelector('[role=status]')?.textContent).toBe('请选择结束日期')
    click('2026-09-24')
    expect(change).toHaveBeenCalledTimes(1)
    expect(change).toHaveBeenCalledWith({ start: '2026-09-21', end: '2026-09-24' })
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('normalizes reverse selection and supports a single day', () => {
    click('选择日期范围'); click('2026-09-24'); click('2026-09-21')
    expect(change).toHaveBeenLastCalledWith({ start: '2026-09-21', end: '2026-09-24' })
    click('选择日期范围'); click('2026-09-23'); click('2026-09-23')
    expect(change).toHaveBeenLastCalledWith({ start: '2026-09-23', end: '2026-09-23' })
  })
  it('Escape discards an unfinished range and returns focus; outside click also cancels', () => {
    click('选择日期范围'); click('2026-09-21')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(change).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button('选择日期范围'))
    click('选择日期范围'); click('2026-09-22')
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(change).not.toHaveBeenCalled(); expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it.each([
    ['今天', '2026-09-24', '2026-09-24'], ['昨天', '2026-09-23', '2026-09-23'],
    ['近7天', '2026-09-18', '2026-09-24'], ['上月', '2026-08-01', '2026-08-31'],
    ['本月', '2026-09-01', '2026-09-24'], ['今年', '2026-01-01', '2026-09-24'],
  ])('%s uses Shanghai business dates', (label, start, end) => {
    click('选择日期范围')
    act(() => [...document.querySelectorAll('footer button')].find(b => b.textContent === label)!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(change).toHaveBeenLastCalledWith({ start, end })
  })
  it('handles leap-year month end and year navigation', () => {
    vi.setSystemTime(new Date('2024-03-01T01:00:00Z')); click('选择日期范围')
    click('上一年'); expect(document.querySelector('section[aria-label="2025年8月"]')).not.toBeNull()
    act(() => [...document.querySelectorAll('footer button')].find(b => b.textContent === '上月')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(change).toHaveBeenLastCalledWith({ start: '2024-02-01', end: '2024-02-29' })
    click('清空日期范围'); expect(change).toHaveBeenLastCalledWith({ start: '', end: '' })
  })
})
