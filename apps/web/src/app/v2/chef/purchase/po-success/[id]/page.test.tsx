// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, back: vi.fn() }) }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import PoSuccessPage from './page'

const mockFetch = vi.mocked(apiFetch)

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('厨师长采购单打印入口', () => {
  beforeEach(() => {
    push.mockReset()
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      id: 'order-1', no: 'PO-1', status: 'COMPLETED', totalAmount: 20,
      expectedDate: '2026-09-28T00:00:00.000Z', supplier: { name: '供应商' },
      items: [], revisions: [], receipts: [], lossClaims: [],
    })
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('打开现有送货单打印与 PDF 页面', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<PoSuccessPage params={{ id: 'order-1' }} />))
    await waitFor(() => Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('打印送货单')))

    const print = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('打印送货单'))
    await act(async () => { print?.click() })

    expect(push).toHaveBeenCalledWith('/v2/chef/purchase/po-success/order-1/delivery-note')
    act(() => root.unmount())
  })
})
