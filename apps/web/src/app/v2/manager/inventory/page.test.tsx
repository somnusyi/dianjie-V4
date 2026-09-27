// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ManagerInventoryPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2/user-menu', () => ({ UserMenu: () => <div data-testid="user-menu" /> }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const item = {
  id: 'product-1', code: 'P001', name: '午餐肉', spec: '340g', category: '干货', unit: '罐', stock: 3,
  avgUnitCost: 8, inventoryValue: 24, minStock: 0, targetStock: null, isLowStock: false,
  hasDataIssue: false, openingDate: '2026-09-01', asOf: '2026-09-28T08:00:00.000Z',
  baselineItemCount: 1, baselineMatchedCount: 1, estimateIncomplete: false,
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<ManagerInventoryPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('店长库存预警设置', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/inventory/snapshot/latest') return Promise.resolve({
        summary: { status: 'AVAILABLE', asOf: item.asOf, openingDate: item.openingDate, totalValue: 24, itemCount: 1, nonzeroCount: 1, zeroCount: 0, matchedCount: 1, unmatchedCount: 0, lowStockCount: 0, sourceFilename: 'inventory.xlsx' },
        items: [],
      })
      if (url === '/api/inventory') return Promise.resolve([item])
      if (url === '/api/inventory/policies/product-1' && init?.method === 'PATCH') return Promise.resolve({ minStock: 5, targetStock: 10 })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('用页面内双数值表单替代 prompt 并保持原 PATCH 口径', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置安全线') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置安全线')?.click())

    expect(container.textContent).toContain('设置“午餐肉”库存预警')
    act(() => {
      change(container.querySelector('input[aria-label="安全库存"]') as HTMLInputElement, '5')
      change(container.querySelector('input[aria-label="建议补货目标"]') as HTMLInputElement, '10')
    })
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/policies/product-1')))

    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/policies/product-1'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ minStock: 5, targetStock: 10 })
    await waitFor(() => container.textContent?.includes('安全线 5') ?? false)
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it('在页面内显示数值关系错误且不发请求', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置安全线') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置安全线')?.click())
    act(() => {
      change(container.querySelector('input[aria-label="安全库存"]') as HTMLInputElement, '8')
      change(container.querySelector('input[aria-label="建议补货目标"]') as HTMLInputElement, '2')
    })
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存')?.click() })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('建议补货目标必须大于等于安全库存')
    expect(mockFetch.mock.calls.some(([path]) => String(path).endsWith('/policies/product-1'))).toBe(false)

    act(() => root.unmount())
    container.remove()
  })
})
