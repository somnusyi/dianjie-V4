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
const claim = {
  id: 'claim-1', no: 'UCL202609000001', type: 'SHORTAGE', status: 'PENDING_SUPPLIER',
  claimedAmount: 50, description: '云南小土豆到货短缺',
  purchaseOrder: { id: 'order-1', no: order.no },
  receipt: { id: 'receipt-1', no: 'URC202609000010' },
  lines: [{ id: 'claim-line-1', affectedQty: 5, purchaseUnit: '箱', product: { name: '云南小土豆' } }],
}
const receiptDetail = {
  id: 'receipt-1', no: claim.receipt.no, status: 'POSTED', payableAmount: 2000,
  purchaseOrder: { id: 'order-1', no: order.no, totalAmount: 21645 },
  shipment: { id: 'shipment-1', no: 'USH202609000008' },
  lines: [{
    id: 'receipt-line-1', arrivedQty: 20, acceptedQty: 15, shortageQty: 5,
    damagedQty: 0, rejectedQty: 0, purchaseUnit: '箱', payableAmount: 2000,
    purchaseOrderLine: { productCodeSnapshot: 'P001', productNameSnapshot: '云南小土豆', productSpecSnapshot: '10kg/箱' },
  }],
}
const statement = {
  id: 'statement-1', no: 'UST202609000001', status: 'SENT_TO_SUPPLIER',
  periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T00:00:00.000Z',
  receiptAmount: 2000, deductionAmount: 50, payableAmount: 1950, version: 1,
  _count: { lines: 1, invoiceAllocations: 0 },
}
const statementDetail = {
  ...statement,
  lines: [{
    id: 'statement-line-1', sourceType: 'CLAIM', sourceNo: claim.no,
    businessDate: '2026-09-18T00:00:00.000Z', description: '云南小土豆到货短缺 5 箱',
    originalAmount: 2000, adjustmentAmount: -50, payableAmount: 1950,
    claim: {
      id: claim.id, no: claim.no,
      purchaseOrder: claim.purchaseOrder,
      receipt: claim.receipt,
    },
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
    window.location.hash = ''
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

  it('采购单号可以直接进入完整明细', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes(order.no) ?? false)

    const link = container.querySelector(`button[aria-label="查看采购单 ${order.no} 明细"]`) as HTMLButtonElement
    await act(async () => { link.click() })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${order.no}`) ?? false)

    expect(container.textContent).toContain('人工见手青')
    expect(container.textContent).toContain('采购单位')
    expect(container.textContent).toContain('订单数量')
    expect(container.textContent).toContain('单价')

    act(() => root.unmount())
    container.remove()
  })

  it('到货差异可打开对应收货单并看到整行收货数据', async () => {
    mockFetch.mockImplementation((path) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([order])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([claim])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/purchase-orders/order-1') return Promise.resolve(detail)
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(receiptDetail)
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('到货差异') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '到货差异')?.click())
    await waitFor(() => container.textContent?.includes('查看对应收货') ?? false)

    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看对应收货')
    await act(async () => { open?.click() })
    await waitFor(() => container.textContent?.includes(`收货单明细 · ${claim.receipt.no}`) ?? false)

    expect(container.textContent).toContain('云南小土豆')
    expect(container.textContent).toContain('采购单金额')
    expect(container.textContent).toContain('¥21,645.00')
    expect(container.textContent).toContain('短缺')

    const purchaseOrderLink = container.querySelector(`button[aria-label="查看采购单 ${order.no} 全部内容"]`) as HTMLButtonElement
    await act(async () => { purchaseOrderLink.click() })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${order.no}`) ?? false)
    expect(container.textContent).toContain('人工见手青')

    act(() => root.unmount())
    container.remove()
  })

  it('月度对账来源明细可追溯采购单、收货单和差异单', async () => {
    mockFetch.mockImplementation((path) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([order])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([claim])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([statement])
      if (url === '/api/upstream/settlement-statements/statement-1') return Promise.resolve(statementDetail)
      if (url === '/api/upstream/purchase-orders/order-1') return Promise.resolve(detail)
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(receiptDetail)
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('月度对账') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '月度对账')?.click())
    await waitFor(() => container.textContent?.includes(statement.no) ?? false)

    const openSources = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看采购 / 收货 / 差异来源')
    await act(async () => { openSources?.click() })
    await waitFor(() => container.textContent?.includes(`对账单来源明细 · ${statement.no}`) ?? false)

    expect(container.textContent).toContain(order.no)
    expect(container.textContent).toContain(claim.receipt.no)
    expect(container.textContent).toContain(claim.no)
    expect(container.textContent).toContain('云南小土豆到货短缺 5 箱')
    expect(container.textContent).toContain('¥2,000.00')
    expect(container.textContent).toContain('¥50.00')
    expect(container.textContent).toContain('¥1,950.00')

    let sourcePanel = Array.from(container.querySelectorAll('section')).find(section =>
      section.querySelector('h2')?.textContent === `对账单来源明细 · ${statement.no}`)
    const purchaseOrderLink = Array.from(sourcePanel?.querySelectorAll('button') || []).find(button => button.textContent === order.no)
    await act(async () => { purchaseOrderLink?.click() })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${order.no}`) ?? false)
    expect(container.textContent).toContain('人工见手青')

    sourcePanel = Array.from(container.querySelectorAll('section')).find(section =>
      section.querySelector('h2')?.textContent === `对账单来源明细 · ${statement.no}`)
    const receiptLink = Array.from(sourcePanel?.querySelectorAll('button') || []).find(button => button.textContent === claim.receipt.no)
    await act(async () => { receiptLink?.click() })
    await waitFor(() => container.textContent?.includes(`收货单明细 · ${claim.receipt.no}`) ?? false)
    expect(container.textContent).toContain('云南小土豆')
    expect(mockFetch).toHaveBeenCalledWith('/api/upstream/purchase-orders/order-1')
    expect(mockFetch).toHaveBeenCalledWith('/api/upstream/receipts/receipt-1')

    act(() => root.unmount())
    container.remove()
  })
})
