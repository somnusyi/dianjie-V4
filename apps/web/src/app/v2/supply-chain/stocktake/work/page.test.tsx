// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WarehouseStocktakeWorkPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a>,
}))
vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
  getUser: () => ({ id: 'user-1', role: 'SUPPLY_CHAIN' }),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const options = {
  warehouses: [{ id: 'warehouse-1', code: 'WH-01', name: '总仓' }],
  users: [{ id: 'user-1', name: '盘点员甲' }, { id: 'user-2', name: '盘点员乙' }],
  products: [{ id: 'product-1', code: 'P-01', name: '土豆', inventoryUnit: 'kg', unit: 'kg' }],
}

const makeCount = (status = 'COUNTING'): any => ({
  id: 'count-1', no: 'WSC-20260929-001', status, rowVersion: 3,
  warehouse: options.warehouses[0], countedCount: 0, itemCount: 2, totalDifferenceValue: '0', adjustments: [],
  sections: [
    {
      id: 'section-own', name: '冷库', assignedToId: 'user-1', status: 'OPEN', rowVersion: 4, submittedAt: null,
      items: [{
        id: 'item-own', productNameSnapshot: '土豆', productCodeSnapshot: 'P-01', productSpecSnapshot: '10kg/箱', inventoryUnit: 'kg',
        bookQuantity: '10', averageUnitCost: '2', countedQuantity: null, countedUnitCost: null,
        differenceQuantity: null, differenceValue: null, reason: null,
      }],
    },
    {
      id: 'section-other', name: '干货区', assignedToId: 'user-2', status: 'OPEN', rowVersion: 2, submittedAt: null,
      items: [{
        id: 'item-other', productNameSnapshot: '大米', productCodeSnapshot: 'P-02', productSpecSnapshot: null, inventoryUnit: 'kg',
        bookQuantity: '20', averageUnitCost: '3', countedQuantity: null, countedUnitCost: null,
        differenceQuantity: null, differenceValue: null, reason: null,
      }],
    },
  ],
})

function setupFetch(count = makeCount()) {
  mockFetch.mockImplementation((path, init) => {
    const url = String(path)
    if (url === '/api/warehouse-stocktakes/options') return Promise.resolve(options)
    if (url === '/api/warehouse-stocktakes?page=1&pageSize=200') {
      return Promise.resolve({ rows: [{ id: count.id, no: count.no, status: count.status, warehouse: count.warehouse }] })
    }
    if (url === `/api/warehouse-stocktakes/${count.id}`) return Promise.resolve(count)
    if (url === `/api/warehouse-stocktakes/${count.id}/sections/section-own` && init?.method === 'PUT') return Promise.resolve({ ok: true })
    return Promise.reject(new Error(`unexpected API: ${url}`))
  })
}

function renderPage() {
  window.history.replaceState({}, '', '/v2/supply-chain/stocktake/work?doc=count-1')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<WarehouseStocktakeWorkPage />))
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
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function button(container: Element, text: string) {
  return Array.from(container.querySelectorAll('button')).find(item => item.textContent === text) as HTMLButtonElement | undefined
}

describe('总仓多人分区盘点', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    setupFetch()
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('只允许负责人编辑自己的分区，并按会议版接口提交版本与实盘值', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)

    const own = container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    const other = container.querySelector('[aria-label="大米实盘数量"]') as HTMLInputElement
    expect(own.disabled).toBe(false)
    expect(other.disabled).toBe(true)

    change(own, '12.5')
    await act(async () => { button(container, '保存我的分区')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT'))

    const call = mockFetch.mock.calls.find(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      rowVersion: 4,
      submit: false,
      items: [{ itemId: 'item-own', countedQuantity: '12.5', countedUnitCost: '2', reason: '' }],
    })
    expect(container.textContent).toContain('冷库已保存')

    act(() => root.unmount())
  })

  it('保留盘点复盘直达入口和会议版分区提交状态', async () => {
    const count = makeCount()
    count.sections[0].status = 'SUBMITTED'
    count.sections[0].submittedAt = '2026-09-29T08:00:00.000Z'
    setupFetch(count)
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('冷库') ?? false)

    expect(container.querySelector('a[href="/v2/supply-chain/stocktake/count/count-1?source=warehouse"]')?.textContent).toContain('查看差异')
    expect(container.textContent).toContain('冷库 · 盘点员甲 · 已提交')
    expect((container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement).disabled).toBe(true)
    expect(button(container, '保存我的分区')).toBeUndefined()
    expect(button(container, '提交我的分区')).toBeUndefined()

    act(() => root.unmount())
  })
})
