// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UpstreamProcurementPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const postedReceipt = {
  id: 'receipt-1', no: 'URC202609000001', status: 'POSTED', payableAmount: 120,
  postedAt: '2026-09-16T04:00:00.000Z', createdAt: '2026-09-16T03:00:00.000Z',
  supplier: { id: 'supplier-1', no: 'SUP001', name: '测试供应商' },
  purchaseOrder: { id: 'order-1', no: 'UPO202609000001', status: 'RECEIVED' },
  shipment: { id: 'shipment-1', no: 'USH202609000001', status: 'RECEIVED' },
  _count: { lines: 1, claims: 0 },
}

const receiptDetail = {
  ...postedReceipt,
  supplier: { ...postedReceipt.supplier, postReceiptClaimHours: 48 },
  lines: [{
    id: 'receipt-line-1', acceptedQty: 10, purchaseUnit: 'kg',
    purchaseOrderLine: {
      productCodeSnapshot: 'P001', productNameSnapshot: '人工见手青', productSpecSnapshot: '件/1000g',
    },
  }],
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<UpstreamProcurementPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('上游采购收货后补报', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/receipts') return Promise.resolve([postedReceipt])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/contracts') return Promise.resolve([])
      if (url === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [postedReceipt.supplier], warehouses: [] })
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(receiptDetail)
      if (url === '/api/upload?category=loss-claims' && init?.method === 'POST') return Promise.resolve({ url: 'https://example.invalid/evidence.jpg' })
      if (url === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST') return Promise.resolve({ id: 'claim-1' })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('requires evidence and sends a stable idempotency key with the original receipt line', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('上游采购与供应商协同') ?? false)
    const receiptTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '到货验收')
    act(() => receiptTab?.click())
    await waitFor(() => container.textContent?.includes('收货后补报异常') ?? false)

    const openButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '收货后补报异常')
    await act(async () => { openButton?.click() })
    await waitFor(() => container.textContent?.includes('人工见手青') ?? false)

    change(container.querySelector('textarea') as HTMLTextAreaElement, '拆包后发现内部品质异常')
    const quantity = container.querySelector('input[type="number"][max="10"]') as HTMLInputElement
    change(quantity, '0.5')

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['evidence'], 'evidence.jpg', { type: 'image/jpeg' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => container.textContent?.includes('evidence.jpg') ?? false)

    const submitButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交补报')
    await act(async () => { submitButton?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) =>
      String(path) === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST'))

    const call = mockFetch.mock.calls.find(([path, init]) =>
      String(path) === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST')
    const payload = JSON.parse(String(call?.[1]?.body))
    expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(payload.lines).toEqual([{ receiptLineId: 'receipt-line-1', affectedQty: 0.5 }])
    expect(payload.evidence).toEqual([{ url: 'https://example.invalid/evidence.jpg', name: 'evidence.jpg' }])

    act(() => root.unmount())
    container.remove()
  })
})
