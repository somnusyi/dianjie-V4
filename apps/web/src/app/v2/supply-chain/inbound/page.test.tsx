// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InboundRecordsPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const record = {
  id: 'movement-1', type: 'MANUAL_INBOUND', sourceType: 'WarehouseManualInbound', sourceId: 'req-1',
  effectiveAt: '2026-08-10T02:00:00.000Z', recordedAt: '2026-08-10T02:01:00.000Z',
  product: { id: 'product-1', code: 'MR001', name: '水牛毛肚', category: '荤菜' },
  supplier: { id: 'sup-1', no: 'SUP001', name: '井育苗菇' },
  sourceName: '井育苗菇', note: null,
  originalQuantity: 2, originalUnit: '件', inventoryQuantity: 16, inventoryUnit: '袋',
  inventoryUnitCost: 10, amount: 160, batchNo: 'MI-20260810-abcd1234', expiryDate: null, reversed: false,
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<InboundRecordsPage />))
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
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('入库记录中心', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') {
        return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      }
      if (url === '/api/supplier-aliases/unclaimed') {
        return Promise.resolve({
          items: [
            { sourceName: '美团老王', rowCount: 5, lastUsedAt: '2026-08-09T00:00:00.000Z', multi: false },
            { sourceName: 'A供应商、B供应商', rowCount: 2, lastUsedAt: null, multi: true },
          ],
        })
      }
      if (url.startsWith('/api/warehouse-inventory/inbound-records')) {
        return Promise.resolve({ total: 1, page: 1, pageSize: 50, items: [record] })
      }
      if (url === '/api/supplier-aliases' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, backfilled: 5 })
      }
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('lists inbound records with structured supplier and batch info', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('水牛毛肚') ?? false)

    expect(container.textContent).toContain('井育苗菇')
    expect(container.textContent).toContain('¥160.00')
    expect(container.textContent).toContain('2 件')
    expect(container.textContent).toContain('16 袋')
    expect(container.textContent).toContain('手工入库')
    expect(container.textContent).toContain('MI-20260810-abcd1234')

    act(() => root.unmount())
    container.remove()
  })

  it('claims an unclaimed source name to a supplier and refreshes', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('待认领来源（2）') ?? false)

    // 多供应商拼合行不可认领
    expect(container.textContent).toContain('多供应商拼合，不可认领')

    const select = container.querySelector('select[aria-label="美团老王认领到供应商"]') as HTMLSelectElement
    change(select, 'sup-1')
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === '认领并回填')
    await act(async () => { button?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path) === '/api/supplier-aliases'))

    const call = mockFetch.mock.calls.find(([path]) => String(path) === '/api/supplier-aliases')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ supplierId: 'sup-1', alias: '美团老王', backfill: true })
    await waitFor(() => container.textContent?.includes('已认领「美团老王」并回填 5 行') ?? false)

    act(() => root.unmount())
    container.remove()
  })

  it('applies filters to the inbound-records query', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('水牛毛肚') ?? false)

    const dateButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('请选择日期范围'))
    act(() => dateButton?.click())
    act(() => (container.querySelector('button[aria-label="上个月"]') as HTMLButtonElement).click())
    act(() => (container.querySelector('button[aria-label="2026-08-01"]') as HTMLButtonElement).click())
    act(() => (container.querySelector('button[aria-label="2026-08-31"]') as HTMLButtonElement).click())
    const supplierSelect = Array.from(container.querySelectorAll('select')).find(element =>
      Array.from(element.options).some(option => option.text === '全部供应商')) as HTMLSelectElement
    change(supplierSelect, 'sup-1')

    await waitFor(() => mockFetch.mock.calls.some(([path]) =>
      String(path).includes('inbound-records') && String(path).includes('from=2026-08-01') && String(path).includes('supplierId=sup-1')))

    act(() => root.unmount())
    container.remove()
  })
})
