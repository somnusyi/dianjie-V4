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
    ;(URL as any).createObjectURL = vi.fn(() => 'blob:docs-export')
    ;(URL as any).revokeObjectURL = vi.fn()
    mockFetch.mockReset()
    mockFetch.mockImplementation(path => {
      if (String(path).startsWith('/api/warehouse-docs?')) {
        return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 })
      }
      return Promise.reject(new Error(`unexpected API: ${String(path)}`))
    })
  })

  it('导出当前筛选的完整单据列表', async () => {
    const row = {
      id: 'doc-export', docNo: 'RK20260928-001', type: 'MANUAL_INBOUND', supplierId: 'sup-1', supplierName: '井育苗菇',
      reason: null, note: '到货', effectiveAt: '2026-09-28T02:00:00.000Z', status: 'CONFIRMED', reviewStatus: 'REVIEWED',
      lineCount: 2, totalAmount: 200, createdAt: '2026-09-28T02:01:00.000Z', confirmedAt: '2026-09-28T03:00:00.000Z', unauditedAt: null, unauditReason: null, attachmentCount: 1,
    }
    mockFetch.mockImplementation(path => String(path).startsWith('/api/warehouse-docs?')
      ? Promise.resolve({ items: [row], total: 1, page: 1, pageSize: String(path).includes('pageSize=200') ? 200 : 20 })
      : Promise.reject(new Error(`unexpected API: ${String(path)}`)))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('RK20260928-001') ?? false)

    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '导出当前筛选')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).includes('pageSize=200')))

    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
    act(() => root.unmount())
    container.remove()
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

  it('在入库单列表和详情显示供应商随货单据，不把它写成报损举证', async () => {
    const row = {
      id: 'doc-1', docNo: 'RK20260927-001', type: 'MANUAL_INBOUND', supplierId: 'sup-1', supplierName: '井育苗菇',
      reason: null, note: '采购到货', effectiveAt: '2026-09-27T02:00:00.000Z', status: 'POSTED', reviewStatus: 'UNREVIEWED',
      lineCount: 1, totalAmount: 100, createdAt: '2026-09-27T02:01:00.000Z', confirmedAt: null, unauditedAt: null, unauditReason: null,
      attachmentCount: 1,
    }
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-docs?')) return Promise.resolve({ items: [row], total: 1, page: 1, pageSize: 20 })
      if (url === '/api/warehouse-docs/doc-1') return Promise.resolve({
        ...row,
        lines: [{ id: 'line-1', lineNo: 1, productId: 'p-1', productName: '土豆', quantity: 10, unit: 'kg', unitPrice: 10, amount: 100, inventoryQuantity: 10, inventoryUnit: 'kg', note: null, batchNo: null, manufactureDate: null, expiryDate: null }],
        logs: [],
        attachments: [{ name: '供应商送货单.pdf', mime: 'application/pdf', size: 2048, url: 'https://signed.test/delivery.pdf' }],
      })
      if (url.startsWith('/api/suppliers?')) return Promise.resolve([])
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('RK20260927-001') ?? false)
    expect(container.textContent).toContain('1 份')
    act(() => Array.from(container.querySelectorAll('button')).find(button => ['查看', '改单'].includes(button.textContent || ''))?.click())
    await waitFor(() => container.textContent?.includes('供应商送货单.pdf') ?? false)
    expect(container.textContent).toContain('供应商随货单据（1份）')
    expect(container.textContent).not.toContain('报损举证')
    expect((container.querySelector('a[href="https://signed.test/delivery.pdf"]') as HTMLAnchorElement).target).toBe('_blank')

    act(() => root.unmount())
    container.remove()
  })
})
