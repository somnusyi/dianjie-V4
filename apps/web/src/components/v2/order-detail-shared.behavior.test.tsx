// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { OrderDeliverySummary, OrderProductTable, type OrderDetailTableRow } from './order-detail-shared'

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

describe('shared order product removal state', () => {
  it('keeps a pending removal row visible, strikes the whole row, and offers restore', () => {
    const rows: OrderDetailTableRow[] = [
      {
        key: 'kept', name: '土豆', spec: '5斤/袋', unit: '袋', quantity: 2,
        unitPrice: 12, originalQuantity: 2,
      },
      {
        key: 'pending', name: '白菜', spec: null, unit: '斤', quantity: 3,
        unitPrice: 4, originalQuantity: 3, pendingRemoval: true,
      },
    ]
    const onRemove = vi.fn()
    const onRestore = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(
      <OrderProductTable
        rows={rows}
        editable
        total="24.00"
        onRemove={onRemove}
        onRestore={onRestore}
      />,
    ))

    const pendingRow = container.querySelector<HTMLTableRowElement>('tr[data-state="pending-removal"]')
    expect(pendingRow).not.toBeNull()
    expect(pendingRow?.textContent).toContain('白菜')
    expect(pendingRow?.style.backgroundImage).toContain('linear-gradient')
    expect(pendingRow?.querySelectorAll('td.line-through')).toHaveLength(6)
    const restoreButton = Array.from(pendingRow?.querySelectorAll('button') || [])
      .find(button => button.textContent === '恢复')
    expect(restoreButton).toBeTruthy()
    expect(pendingRow?.textContent).not.toContain('移除')

    act(() => restoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onRestore).toHaveBeenCalledOnce()
    expect(onRestore).toHaveBeenCalledWith(rows[1])
    expect(onRemove).not.toHaveBeenCalled()

    act(() => root.unmount())
    container.remove()
  })
})
