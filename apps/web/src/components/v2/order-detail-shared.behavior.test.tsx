// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderDeliverySummary } from './order-detail-shared'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let resizeCallback: ResizeObserverCallback

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
  observe() {}
  disconnect() {}
  unobserve() {}
}

function renderSummary(lines: string[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<OrderDeliverySummary lines={lines} />))
  return { container, cleanup: () => { act(() => root.unmount()); container.remove() } }
}

describe('shared delivery summary', () => {
  beforeEach(() => { globalThis.ResizeObserver = ResizeObserverMock as any })

  it('renders every delivery on its own sequentially numbered row', () => {
    const { container, cleanup } = renderSummary(['PS-01 · 白菜2斤', 'PS-02 · 土豆3袋'])
    const numbers = [...container.querySelectorAll('span.min-w-6')]
    expect(numbers.map(node => node.textContent)).toEqual(['1.', '2.'])
    expect(container.textContent).toContain('1.PS-01 · 白菜2斤')
    expect(container.textContent).toContain('2.PS-02 · 土豆3袋')
    cleanup()
  })

  it('shows a range control for horizontal overflow and scrolls with it', () => {
    const { container, cleanup } = renderSummary(['PS-01 · 很长的配送商品内容'])
    const viewport = container.querySelector('.overflow-x-auto') as HTMLDivElement
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 500 },
    })
    const scrollTo = vi.fn()
    viewport.scrollTo = scrollTo as any
    act(() => resizeCallback([], {} as ResizeObserver))

    const range = container.querySelector('input[aria-label="横向拖动查看完整内容"]') as HTMLInputElement
    expect(range).not.toBeNull()
    expect(range.max).toBe('300')
    act(() => {
      Simulate.change(range, { target: { value: '125' } } as any)
    })
    expect(scrollTo).toHaveBeenCalledWith({ left: 125, behavior: 'auto' })
    cleanup()
  })
})
