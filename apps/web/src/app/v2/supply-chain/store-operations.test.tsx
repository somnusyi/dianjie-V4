// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import StoresPage from './stores/page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const STORES = [
  { id: 'store-1', no: 'S01', name: '瑶海店' },
  { id: 'store-2', no: 'S02', name: '政务店' },
]

vi.mock('@/components/v2/use-dashboard', () => ({
  useDashboard: () => ({
    data: {
      supplyChain: {
        stores: STORES,
        counts: { orders: 2, deliveries: 1, receipts: 3 },
      },
    },
    error: null,
  }),
  ErrorScreen: ({ message }: { message: string }) => <div>{message}</div>,
  LoadingScreen: () => <div>加载中</div>,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(ui))
  return { container, root }
}

function cleanup(container: HTMLElement, root: ReturnType<typeof createRoot>) {
  act(() => root.unmount())
  container.remove()
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('内部供应链门店运营', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async path => {
      const url = new URL(String(path), 'http://localhost')
      const storeId = url.searchParams.get('storeId')
      if (url.pathname === '/api/orders') {
        return {
          items: [{
            id: `order-${storeId}`,
            no: storeId === 'store-2' ? 'PO-S02' : 'PO-S01',
            status: 'SUBMITTED',
            createdAt: '2026-07-26',
            totalAmount: 100,
            supplier: { id: 'supplier-1', name: '测试供应商' },
          }],
          total: 1,
        }
      }
      if (url.pathname === '/api/receipts') {
        return {
          items: [{
            id: `receipt-${storeId}`,
            no: storeId === 'store-2' ? 'RK-S02' : 'RK-S01',
            status: 'CONFIRMED',
            deliveryDate: '2026-07-26',
            supplier: { id: 'supplier-1', name: '测试供应商' },
          }],
          total: 1,
        }
      }
      if (url.pathname === '/api/inventory') {
        return [{
          id: `inventory-${storeId}`,
          code: 'SKU-001',
          name: storeId === 'store-2' ? '政务店土豆' : '瑶海店土豆',
          stock: 2,
          minStock: 5,
          inventoryUnit: 'kg',
        }]
      }
      if (url.pathname === '/api/inventory/consumptions') {
        return [{
          id: `consumption-${storeId}`,
          date: '2026-07-26',
          quantity: 1,
          unitSnapshot: 'kg',
          product: { code: 'SKU-001', name: '土豆', unit: 'kg' },
        }]
      }
      throw new Error(`unexpected path: ${path}`)
    })
  })

  it('默认按第一家门店加载四类只读数据，并可切换视图', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const urls = mockFetch.mock.calls.map(([path]) => String(path))
    expect(urls).toContain('/api/orders?storeId=store-1&page=1&pageSize=50')
    expect(urls).toContain('/api/receipts?storeId=store-1&page=1&pageSize=50')
    expect(urls).toContain('/api/inventory?storeId=store-1')
    expect(urls).toContain('/api/inventory/consumptions?days=30&storeId=store-1')
    expect(container.textContent).toContain('门店运营')
    expect(container.textContent).toContain('低于安全线')
    expect(container.textContent).toContain('瑶海店土豆')

    const inventoryTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '当前库存')!
    act(() => inventoryTab.click())
    expect(container.textContent).toContain('最近盘点 + 后续实收 − 消耗 − 报损')
    expect(container.textContent).not.toContain('调整库存')
    expect(container.textContent).not.toContain('确认收货')

    cleanup(container, root)
  })

  it('切换门店后重新按所选门店加载，不混用上一家门店结果', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const select = container.querySelector('select[aria-label="选择门店"]') as HTMLSelectElement
    act(() => Simulate.change(select, { target: { value: 'store-2' } as any }))
    await waitFor(() => container.textContent?.includes('PO-S02') ?? false)

    expect(mockFetch.mock.calls.some(([path]) => String(path).includes('storeId=store-2'))).toBe(true)
    expect(container.textContent).toContain('政务店土豆')
    expect(container.textContent).not.toContain('瑶海店土豆')

    cleanup(container, root)
  })
})
