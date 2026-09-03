// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { OrderDeliverySummary } from './order-detail-shared'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function renderSummary(lines: string[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<OrderDeliverySummary lines={lines} />))
  return { container, cleanup: () => { act(() => root.unmount()); container.remove() } }
}

describe('shared delivery summary', () => {
  it('renders one compact, continuously numbered product list', () => {
    const { container, cleanup } = renderSummary(['白菜2斤', '土豆3袋'])
    expect(container.querySelector('p')?.textContent).toBe('1.白菜2斤、2.土豆3袋')
    cleanup()
  })

  it('does not add a range control or delivery grouping UI', () => {
    const { container, cleanup } = renderSummary(['白菜2斤'])
    expect(container.querySelector('input[type="range"]')).toBeNull()
    expect(container.querySelectorAll('p')).toHaveLength(1)
    cleanup()
  })
})
