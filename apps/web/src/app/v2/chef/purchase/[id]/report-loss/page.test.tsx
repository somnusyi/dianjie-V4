// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), usePathname: () => '/v2/chef/purchase/order-1/report-loss' }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import PostReceiptLossPage from './page'

const mockFetch = vi.mocked(apiFetch)

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('收货后补报异常页内校验', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      id: 'order-1', lossClaims: [],
      receipts: [{
        id: 'receipt-1', no: 'RC-1', status: 'CONFIRMED', confirmedAt: '2026-09-28T01:00:00.000Z', deliveryDate: '2026-09-28',
        items: [{ productId: 'p-1', quantity: 2, amount: 20, productUnitSnapshot: '斤', product: { name: '土豆' } }],
      }],
    })
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('必填原因缺失时显示并聚焦页内提示', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<PostReceiptLossPage params={{ id: 'order-1' }} />))
    await waitFor(() => Boolean(container.querySelector('input[type="number"]')))

    const quantity = container.querySelector('input[type="number"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(quantity, '1')
      quantity.dispatchEvent(new Event('input', { bubbles: true }))
      quantity.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.startsWith('提交异常'))
    act(() => submit?.click())

    await waitFor(() => Boolean(container.querySelector('[role="alert"]')))
    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain('请填写异常原因和具体说明')
    expect(document.activeElement).toBe(alert)
    act(() => root.unmount())
  })
})
