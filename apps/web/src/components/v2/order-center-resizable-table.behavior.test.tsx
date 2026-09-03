// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  clampOrderCenterColumnWidth,
  OrderCenterResizableTable,
  orderCenterHeaderMinimumWidth,
  type OrderCenterTableColumn,
} from './order-center-resizable-table'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type Row = { id: string; summary: string }

const COLUMNS: readonly OrderCenterTableColumn<Row>[] = [
  {
    id: 'sequence',
    header: '序号',
    defaultWidth: 72,
    renderCell: (_row, index) => index + 1,
  },
  {
    id: 'summary',
    header: '商品摘要',
    defaultWidth: 400,
    renderCell: row => row.summary,
  },
]

function renderTable() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <OrderCenterResizableTable
        ariaLabel="测试表格"
        columns={COLUMNS}
        rows={[{ id: 'row-1', summary: '七彩土豆3kg、海菜花2kg、鸡架1箱' }]}
        rowKey={row => row.id}
      />,
    )
  })
  return {
    container,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function pointerEvent(type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX })
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: pointerId },
    pointerType: { configurable: true, value: 'mouse' },
  })
  return event
}

describe('shared order-center resizable table', () => {
  it('derives a heading-sized lower bound and clamps every resize to min/max', () => {
    expect(orderCenterHeaderMinimumWidth('序号')).toBe(58)
    expect(orderCenterHeaderMinimumWidth('期望到货日')).toBe(97)
    expect(clampOrderCenterColumnWidth(20, 96, 400)).toBe(96)
    expect(clampOrderCenterColumnWidth(240, 96, 400)).toBe(240)
    expect(clampOrderCenterColumnWidth(900, 96, 400)).toBe(400)
  })

  it('starts at the configured maximum and supports pointer resizing down to the heading width', () => {
    const { container, cleanup } = renderTable()
    const handle = container.querySelector<HTMLElement>('[aria-label="调整商品摘要列宽"]')
    expect(handle).not.toBeNull()
    const capturedPointers = new Set<number>()
    Object.defineProperties(handle!, {
      setPointerCapture: { value: (pointerId: number) => capturedPointers.add(pointerId) },
      hasPointerCapture: { value: (pointerId: number) => capturedPointers.has(pointerId) },
      releasePointerCapture: { value: (pointerId: number) => capturedPointers.delete(pointerId) },
    })
    expect(handle?.getAttribute('aria-valuenow')).toBe('400')
    expect(handle?.getAttribute('aria-valuemax')).toBe('400')

    act(() => handle?.dispatchEvent(pointerEvent('pointerdown', 400)))
    expect(capturedPointers.has(1)).toBe(true)
    act(() => window.dispatchEvent(pointerEvent('pointermove', 0)))

    const minimum = orderCenterHeaderMinimumWidth('商品摘要')
    expect(handle?.getAttribute('aria-valuemin')).toBe(String(minimum))
    expect(handle?.getAttribute('aria-valuenow')).toBe(String(minimum))
    expect(container.querySelectorAll('col')[1]?.style.width).toBe(`${minimum}px`)

    act(() => window.dispatchEvent(pointerEvent('pointerup', 0)))
    expect(capturedPointers.has(1)).toBe(false)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    cleanup()
  })

  it('ignores a second pointer and restores body interaction when the window loses focus', () => {
    const { container, cleanup } = renderTable()
    const handle = container.querySelector<HTMLElement>('[aria-label="调整商品摘要列宽"]')

    act(() => handle?.dispatchEvent(pointerEvent('pointerdown', 400, 1)))
    act(() => handle?.dispatchEvent(pointerEvent('pointerdown', 200, 2)))
    act(() => window.dispatchEvent(pointerEvent('pointermove', 0, 2)))

    expect(handle?.getAttribute('aria-valuenow')).toBe('400')
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    act(() => window.dispatchEvent(new Event('blur')))
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
    cleanup()
  })

  it('supports keyboard resize/reset and renders wrapping body cells', () => {
    const { container, cleanup } = renderTable()
    const handle = container.querySelector<HTMLElement>('[aria-label="调整商品摘要列宽"]')
    act(() => handle?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' })))
    expect(handle?.getAttribute('aria-valuenow')).toBe(String(orderCenterHeaderMinimumWidth('商品摘要')))

    act(() => handle?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' })))
    expect(handle?.getAttribute('aria-valuenow')).toBe('400')

    const summaryCell = container.querySelectorAll('tbody td')[1]
    expect(summaryCell?.className.split(/\s+/)).toContain('whitespace-normal')
    expect(summaryCell?.className.split(/\s+/)).toContain('break-words')
    expect(summaryCell?.className.split(/\s+/)).toContain('leading-5')
    expect(container.querySelector('table')?.className.split(/\s+/)).toContain('table-fixed')
    cleanup()
  })
})
