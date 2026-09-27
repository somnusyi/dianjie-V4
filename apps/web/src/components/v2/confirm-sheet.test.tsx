// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmSheet, useConfirmSheet } from './confirm-sheet'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = []

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount())
    entry.container.remove()
  }
})

function Harness({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [state, openConfirm] = useConfirmSheet()
  return <>
    <button onClick={() => openConfirm({ title: '确认调拨', confirmLabel: '确认发货', onConfirm })}>打开</button>
    <ConfirmSheet {...state} />
  </>
}

function mount(onConfirm: () => Promise<void>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<Harness onConfirm={onConfirm} />))
  mounted.push({ root, container })
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(node => node.textContent === label) as HTMLButtonElement
  return { container, button }
}

describe('ConfirmSheet async safety', () => {
  it('submits once and cannot close from the backdrop while busy', async () => {
    let resolve!: () => void
    const onConfirm = vi.fn(() => new Promise<void>(done => { resolve = done }))
    const { container, button } = mount(onConfirm)
    act(() => button('打开').click())
    const confirmButton = button('确认发货')
    const backdrop = container.querySelector('[data-testid="confirm-sheet-backdrop"]') as HTMLElement

    act(() => {
      confirmButton.click()
      confirmButton.click()
      backdrop.click()
    })

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => { resolve(); await Promise.resolve() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the sheet open and shows the operation error after rejection', async () => {
    const onConfirm = vi.fn(async () => { throw new Error('调拨状态已变化，请刷新') })
    const { container, button } = mount(onConfirm)
    act(() => button('打开').click())
    await act(async () => { button('确认发货').click(); await Promise.resolve() })

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('调拨状态已变化，请刷新')
  })
})
