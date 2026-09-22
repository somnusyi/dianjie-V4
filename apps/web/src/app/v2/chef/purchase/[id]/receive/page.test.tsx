// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn() }),
}))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import ReceivePage from './page'

const mockFetch = vi.mocked(apiFetch)

const order = {
  id: 'order-1',
  no: 'PO202609000004',
  status: 'PENDING_CONFIRM',
  totalAmount: 300,
  supplier: { id: 'supplier-1', name: '测试供应商' },
  deliveries: [{
    id: 'delivery-1',
    no: 'DO202609000002',
    status: 'DELIVERED',
    items: [
      {
        id: 'delivery-line-1', productId: 'potato', shippedQty: 10,
        orderedQtySnapshot: 10, unitPriceSnapshot: 10,
        product: { name: '云南小土豆', spec: '10kg/箱', unit: '箱' },
      },
      {
        id: 'delivery-line-2', productId: 'mushroom', shippedQty: 5,
        orderedQtySnapshot: 5, unitPriceSnapshot: 40,
        product: { name: '赤松茸A', spec: '件/2250g', unit: '件' },
      },
    ],
  }],
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<ReceivePage params={{ id: 'order-1' }} />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('门店验收逐商品差异', () => {
  beforeEach(() => {
    push.mockReset()
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      if (String(path) === '/api/orders/order-1' && !init) return Promise.resolve(order)
      if (String(path) === '/api/orders/order-1/receive' && init?.method === 'PATCH') return Promise.resolve({ success: true })
      return Promise.reject(new Error(`unexpected API: ${String(path)}`))
    })
  })

  it('在一张验收单内分别提交少发和破损商品', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('云南小土豆') ?? false)

    const quantities = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    change(quantities[0], '8')
    change(quantities[1], '4')
    await waitFor(() => container.textContent?.includes('逐商品选择到货差异') ?? false)

    const damageButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent === '破损 / 品质异常')
    expect(damageButtons).toHaveLength(2)
    act(() => damageButtons[1].click())

    const reasons = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[]
    change(reasons[0], '少送 2 箱')
    change(reasons[1], '包装破损')

    const submit = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.startsWith('确认收货 ·'))
    act(() => submit?.click())
    await waitFor(() => Array.from(container.querySelectorAll('button')).some(button => button.textContent === '确认收货'))
    const confirm = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认收货')
    await act(async () => { confirm?.click() })

    await waitFor(() => mockFetch.mock.calls.some(([path, init]) =>
      String(path) === '/api/orders/order-1/receive' && init?.method === 'PATCH'))
    const call = mockFetch.mock.calls.find(([path, init]) =>
      String(path) === '/api/orders/order-1/receive' && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      items: [
        { productId: 'potato', receivedQty: 8, kind: 'ARRIVAL_SHORTAGE', reason: '少送 2 箱' },
        { productId: 'mushroom', receivedQty: 4, kind: 'ARRIVAL_DAMAGE', reason: '包装破损' },
      ],
    })
    expect(push).toHaveBeenCalledWith('/v2/chef/purchase/po-success/order-1')

    act(() => root.unmount())
    container.remove()
  })
})
