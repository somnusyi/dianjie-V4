// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const back = vi.fn()
const push = vi.fn()
const replace = vi.fn()

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'order-1' }),
  useRouter: () => ({ back, push, replace }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
  getUser: () => ({ id: 'supplier-user-1', role: 'SUPPLIER' }),
}))

vi.mock('@/lib/client-id', () => ({ clientRequestId: () => 'revision-request-1' }))

import { apiFetch } from '@/lib/v2-auth'
import SupplierOrderDetailPage from './page'

const mockFetch = vi.mocked(apiFetch)

const originalOrder = {
  id: 'order-1',
  no: 'PO202609000004',
  status: 'SUBMITTED',
  totalAmount: '40',
  originalTotalAmount: '40',
  currentOrderAmount: '40',
  rowVersion: 3,
  expectedDate: '2026-09-22T00:00:00.000Z',
  createdAt: '2026-09-21T02:34:00.000Z',
  submittedAt: '2026-09-21T02:34:00.000Z',
  shippedAt: null,
  receivedAt: null,
  shippedNote: null,
  note: null,
  store: { id: 'store-1', name: '灰度测试门店', no: 'STORE-1' },
  supplier: { id: 'supplier-1', name: '灰度供应商', inventoryMode: 'NOT_TRACKED' },
  createdBy: { id: 'chef-1', name: '门店厨师长' },
  shippedBy: null,
  items: [{
    id: 'item-1', productId: 'product-1', quantity: '4', shippedQty: null,
    unitPrice: '10', amount: '40', receivedQty: null,
    orderUnitSnapshot: '箱', productUnitSnapshot: '箱',
    product: { name: '云南小土豆', spec: '10kg/箱', unit: '箱', code: 'P001' },
  }],
  revisions: [],
  deliveries: [],
  lossClaims: [],
  receipts: [],
}

const reopenedOrder = {
  ...originalOrder,
  revisions: [{
    id: 'revision-1', revisionNo: 1, status: 'PENDING', reason: '供应商商品明细调整',
    requestedAt: '2026-09-21T03:00:00.000Z', createdAt: '2026-09-21T03:00:00.000Z',
    requestedBy: { name: '供应商操作员' }, reviewedBy: null, reviewedAt: null, reviewNote: null,
    changeSet: [{ kind: 'QUANTITY', productId: 'product-1', before: 4, after: 7 }],
    beforeSnapshot: {
      totalAmount: '40',
      items: [{ productId: 'product-1', code: 'P001', name: '云南小土豆', spec: '10kg/箱', unit: '箱', quantity: '4', unitPrice: '10', amount: '40' }],
    },
    afterSnapshot: {
      totalAmount: '70',
      items: [{ productId: 'product-1', code: 'P001', name: '云南小土豆', spec: '10kg/箱', unit: '箱', quantity: '7', unitPrice: '10', amount: '70' }],
    },
  }],
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<SupplierOrderDetailPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('供应商订单详情改单行为', () => {
  beforeEach(() => {
    back.mockReset()
    push.mockReset()
    replace.mockReset()
    mockFetch.mockReset()
    let detailReads = 0
    mockFetch.mockImplementation((path, init) => {
      if (String(path) === '/api/orders/order-1' && !init) {
        detailReads += 1
        return Promise.resolve(detailReads === 1 ? originalOrder : reopenedOrder)
      }
      if (String(path) === '/api/orders/order-1/revisions' && init?.method === 'POST') {
        return Promise.resolve({ id: 'revision-1', status: 'PENDING' })
      }
      return Promise.reject(new Error(`unexpected API: ${String(path)}`))
    })
  })

  it('修改商品数量后提交新数量，重新加载仍分别展示原始与修改后快照', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('云南小土豆') ?? false)

    const quantity = container.querySelector('input[aria-label="云南小土豆数量"]') as HTMLInputElement
    expect(quantity.value).toBe('4')
    change(quantity, '7')

    const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存')
    expect(save?.hasAttribute('disabled')).toBe(false)
    act(() => save?.click())
    await waitFor(() => container.textContent?.includes('申请调整订货单?') ?? false)

    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交申请')
    await act(async () => { submit?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) =>
      String(path) === '/api/orders/order-1/revisions' && init?.method === 'POST'))

    const revisionCall = mockFetch.mock.calls.find(([path, init]) =>
      String(path) === '/api/orders/order-1/revisions' && init?.method === 'POST')
    expect(JSON.parse(String(revisionCall?.[1]?.body))).toEqual({
      items: [{ productId: 'product-1', quantity: 7 }],
      reason: '供应商商品明细调整',
      baseRowVersion: 3,
      requestKey: 'revision-request-1',
    })

    await waitFor(() => container.textContent?.includes('改单前（原始内容）') ?? false)
    const revisionSection = Array.from(container.querySelectorAll('section'))
      .find(section => section.textContent?.includes('改单记录')) as HTMLElement
    expect(revisionSection.textContent).toContain('改单后（待审核）')

    const snapshotTables = revisionSection.querySelectorAll('table')
    expect(snapshotTables).toHaveLength(2)
    expect(snapshotTables[0].textContent).toContain('4 箱')
    expect(snapshotTables[0].textContent).toContain('¥40.00')
    expect(snapshotTables[1].textContent).toContain('7 箱')
    expect(snapshotTables[1].textContent).toContain('¥70.00')

    // 重新 GET 后主商品表仍显示原订单数量 4，新数量 7 只在待审改单快照中。
    const productSection = Array.from(container.querySelectorAll('section'))
      .find(section => section.textContent?.includes('商品明细 (1)')) as HTMLElement
    expect(productSection.querySelector('tbody')?.textContent).toContain('4箱')
    expect(productSection.querySelector('tbody')?.textContent).not.toContain('7箱')
    expect(productSection.querySelector('tbody input')).toBeNull()
    expect(container.textContent).toContain('修改处理中')

    act(() => root.unmount())
    container.remove()
  })
})
