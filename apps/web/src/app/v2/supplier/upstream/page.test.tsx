// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SupplierUpstreamPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const order = {
  id: 'order-1', no: 'UPO202609000001', status: 'SUPPLIER_ACCEPTED', totalAmount: 200,
  expectedArrivalAt: '2026-09-18T00:00:00.000Z', warehouse: { id: 'warehouse-1', name: '供应链总仓' },
  _count: { lines: 1, shipments: 0, receipts: 0 },
}
const detail = {
  ...order,
  lines: [{
    id: 'line-1', productNameSnapshot: '人工见手青', purchaseUnit: 'kg',
    orderedQty: 2, confirmedQty: null, shippedQty: 0, unitPrice: 100,
  }],
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<SupplierUpstreamPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('上游供应商发货防重', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders' && !init) return Promise.resolve([order])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/purchase-orders/order-1') return Promise.resolve(detail)
      if (url === '/api/upstream/purchase-orders/order-1/shipments' && init?.method === 'POST') return Promise.resolve({ id: 'shipment-1' })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('sends an idempotency key when creating a shipment draft', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('新建发货单') ?? false)
    const openButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '新建发货单')
    await act(async () => { openButton?.click() })
    await waitFor(() => container.textContent?.includes('保存发货单草稿') ?? false)
    const saveButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存发货单草稿')
    await act(async () => { saveButton?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) =>
      String(path) === '/api/upstream/purchase-orders/order-1/shipments' && init?.method === 'POST'))

    const call = mockFetch.mock.calls.find(([path, init]) =>
      String(path) === '/api/upstream/purchase-orders/order-1/shipments' && init?.method === 'POST')
    const payload = JSON.parse(String(call?.[1]?.body))
    expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(payload.lines).toEqual([{ purchaseOrderLineId: 'line-1', shippedQty: 2 }])

    act(() => root.unmount())
    container.remove()
  })
})
