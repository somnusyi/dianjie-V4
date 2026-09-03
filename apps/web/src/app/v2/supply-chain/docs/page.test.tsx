// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WarehouseDocsPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
  getUser: () => ({ role: 'SUPPLY_CHAIN' }),
}))
vi.mock('@/components/v2/warehouse-tool-tabs', () => ({
  WarehouseToolTabs: () => <nav aria-label="库存与单据视图" />,
}))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<WarehouseDocsPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(element: HTMLSelectElement | HTMLInputElement, value: string) {
  act(() => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('单据审核页面', () => {
  beforeEach(() => {
    sessionStorage.clear()
    history.replaceState({}, '', '/v2/supply-chain/docs')
    mockFetch.mockReset()
    mockFetch.mockImplementation(path => {
      if (String(path).startsWith('/api/warehouse-docs?')) {
        return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 })
      }
      return Promise.reject(new Error(`unexpected API: ${String(path)}`))
    })
  })

  it('用明确的单据类型筛选取代第二组切换，且只保留重置', async () => {
    const { container, root } = renderPage()
    await waitFor(() => mockFetch.mock.calls.length > 0)

    const typeSelect = Array.from(container.querySelectorAll('select')).find(select =>
      select.closest('label')?.textContent?.includes('单据类型')) as HTMLSelectElement
    expect(typeSelect).toBeTruthy()
    expect(Array.from(typeSelect.options).map(option => option.text)).toEqual(['入库单', '出库单'])
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '查询')).toBe(false)
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '重置')).toBe(true)

    change(typeSelect, 'MANUAL_OUTBOUND')
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).includes('type=MANUAL_OUTBOUND')))

    act(() => root.unmount())
    container.remove()
  })

  it('重置只清除筛选条件，不改变当前单据类型', async () => {
    const { container, root } = renderPage()
    await waitFor(() => mockFetch.mock.calls.length > 0)
    const selects = Array.from(container.querySelectorAll('select'))
    const typeSelect = selects.find(select => select.closest('label')?.textContent?.includes('单据类型'))!
    const statusSelect = selects.find(select => select.closest('label')?.textContent?.includes('审核状态'))!
    const search = container.querySelector('input[placeholder*="单据编号"]') as HTMLInputElement

    change(typeSelect, 'MANUAL_OUTBOUND')
    change(statusSelect, 'CONFIRMED')
    change(search, 'CK2026')
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '重置')?.click())

    await waitFor(() => {
      const url = String(mockFetch.mock.calls.at(-1)?.[0] || '')
      return url.includes('type=MANUAL_OUTBOUND') && !url.includes('status=') && !url.includes('q=')
    })
    expect(typeSelect.value).toBe('MANUAL_OUTBOUND')
    expect(statusSelect.value).toBe('')
    expect(search.value).toBe('')

    act(() => root.unmount())
    container.remove()
  })

  it('入库单可按供应商名称模糊搜索，重置后清除供应商条件', async () => {
    const { container, root } = renderPage()
    await waitFor(() => mockFetch.mock.calls.length > 0)
    const supplierSearch = container.querySelector('input[placeholder="输入供应商名称"]') as HTMLInputElement

    change(supplierSearch, '鲜蔬')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(mockFetch.mock.calls.some(([path]) => decodeURIComponent(String(path)).includes('supplierQ=鲜蔬'))).toBe(true)

    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '重置')?.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(decodeURIComponent(String(mockFetch.mock.calls.at(-1)?.[0] || ''))).not.toContain('supplierQ=')
    expect(supplierSearch.value).toBe('')

    act(() => root.unmount())
    container.remove()
  })
})
