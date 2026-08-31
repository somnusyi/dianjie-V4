// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import ReceiptsPage from './receipts/page'
import OrdersPage from './orders/page'
import DeliveriesPage from './deliveries/page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/components/v2/skeleton', () => ({
  SkeletonCard: () => <div data-skeleton="true">骨架</div>,
  EmptyState: ({ title, hint }: { title: string; hint?: string }) => (
    <div data-empty="true">
      <div data-empty-title="true">{title}</div>
      {hint && <div data-empty-hint="true">{hint}</div>}
    </div>
  ),
  FriendlyError: ({ message, onRetry }: { message?: string; onRetry?: () => void }) => (
    <div data-error="true">
      <span data-error-message="true">{message}</span>
      {onRetry && (
        <button data-retry="true" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const STORES = [
  { id: 'store-1', no: 'S01', name: '测试门店' },
]

const FINANCIAL_SUBSTRINGS = ['银行', '付款', '对账', '营业额', '成本率', '应付']
const WRITE_ACTION_LABELS = ['收货确认', '发货', '送达', '对账', '付款', '银行']

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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await act(async () => { await sleep(10) })
  }
}

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find(
    b => b.textContent?.trim() === text,
  )
}

function getInputByLabel(container: HTMLElement, labelText: string) {
  const label = Array.from(container.querySelectorAll('label')).find(
    l => l.querySelector('span')?.textContent?.trim() === labelText,
  )
  if (!label) throw new Error(`Label not found: ${labelText}`)
  const input = label.querySelector('input, select')
  if (!input) throw new Error(`Input not found for label: ${labelText}`)
  return input as HTMLInputElement | HTMLSelectElement
}

function setInputValue(input: HTMLInputElement, value: string) {
  Simulate.change(input, { target: { value } as any })
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  Simulate.change(select, { target: { value } as any })
}

function resourceCalls(prefix: string) {
  return mockFetch.mock.calls.filter(([path]) => String(path).startsWith(prefix))
}

function lastResourceUrl(prefix: string) {
  const calls = resourceCalls(prefix)
  const last = calls[calls.length - 1]
  if (!last) throw new Error(`No call found for ${prefix}`)
  return new URL(String(last[0]), 'http://localhost')
}

function mockApi(
  resourceHandler: (path: string, init?: RequestInit) => Promise<any>,
) {
  mockFetch.mockImplementation(async (path, init) => {
    if (String(path).startsWith('/api/stores')) {
      return { items: STORES }
    }
    return resourceHandler(String(path), init as RequestInit)
  })
}

const receiptRaw = {
  id: 'r1',
  no: 'R-001',
  storeId: 'store-1',
  status: 'CONFIRMED',
  deliveryDate: '2026-07-20',
  note: '备注',
  createdAt: '2026-07-19',
  store: STORES[0],
  supplier: { id: 'sup-1', no: 'SUP01', name: '测试供应商' },
  items: [{ productNameSnapshot: '苹果', productCodeSnapshot: 'APL', productSpecSnapshot: '1kg' }],
  totalAmount: 12345.67,
  paymentSchedule: { dueDate: '2026-08-01' },
  invoiceNo: 'INV-001',
  bankAccount: '6222 0000 0000 0000',
}

const orderRaw = {
  id: 'o1',
  no: 'O-001',
  storeId: 'store-1',
  supplierId: 'sup-1',
  status: 'CONFIRMED',
  createdAt: '2026-07-18T10:00:00Z',
  expectedDeliveryDate: '2026-07-22',
  store: STORES[0],
  supplier: { id: 'sup-1', no: 'SUP01', name: '测试供应商' },
  submittedSnapshot: { items: [{ name: '香蕉', code: 'BAN', spec: '2kg' }] },
  items: [{ productNameSnapshot: '香蕉', product: { name: '香蕉', code: 'BAN', spec: '2kg' } }],
  totalAmount: 9999.99,
  costRate: 0.25,
  turnover: 88888,
  paymentSchedule: [{ amount: 9999.99 }],
  invoice: { no: 'INV-002' },
  bankName: '测试银行',
}

const deliveryRaw = {
  id: 'd1',
  no: 'D-001',
  storeId: 'store-1',
  supplierId: 'sup-1',
  status: 'SHIPPED',
  createdAt: '2026-07-18T10:00:00Z',
  shippedAt: '2026-07-19T08:00:00Z',
  purchaseOrder: { id: 'o1', no: 'O-001' },
  store: STORES[0],
  supplier: { id: 'sup-1', no: 'SUP01', name: '测试供应商' },
  items: [{ productNameSnapshot: '胡萝卜', product: { name: '胡萝卜', code: 'CAR' } }],
  totalAmount: 5555.55,
  paymentSchedule: [{ amount: 5555.55 }],
  payable: 5000,
  bankAccount: '6222 3333 4444 5555',
}

function assertNoWriteActions(container: HTMLElement) {
  const buttons = Array.from(container.querySelectorAll('button, a'))
  const labels = buttons.map(b => b.textContent?.trim() ?? '')
  for (const label of labels) {
    expect(WRITE_ACTION_LABELS).not.toContain(label)
  }
}

function assertNoFinancialFields(container: HTMLElement) {
  const text = container.textContent ?? ''
  for (const term of FINANCIAL_SUBSTRINGS) {
    expect(text).not.toContain(term)
  }
  expect(text).not.toContain('paymentSchedule')
  expect(text).not.toContain('invoice')
}

describe('内部供应链只读 PC 页面回归', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('收货查询 /v2/supply-chain/receipts', () => {
    it('首次加载使用默认分页参数，不渲染写入口与财务字段', async () => {
      mockApi(() => Promise.resolve({ items: [receiptRaw], total: 1 }))

      const { container, root } = render(<ReceiptsPage />)
      await waitFor(() => container.textContent?.includes('R-001') ?? false)

      const url = lastResourceUrl('/api/receipts')
      expect(url.searchParams.get('page')).toBe('1')
      expect(url.searchParams.get('pageSize')).toBe('20')
      expect(url.searchParams.get('keyword')).toBeNull()
      expect(url.searchParams.get('storeId')).toBeNull()
      expect(url.searchParams.get('dateFrom')).toBeNull()
      expect(url.searchParams.get('dateTo')).toBeNull()

      assertNoWriteActions(container)
      assertNoFinancialFields(container)
      expect(container.textContent).toContain('测试门店')
      expect(container.textContent).toContain('测试供应商')
      expect(container.textContent).toContain('苹果')

      cleanup(container, root)
    })

    it('输入筛选后点击查询、翻页、清空发出符合合同的 URL', async () => {
      let total = 1
      mockApi(path => {
        if (path.startsWith('/api/receipts')) return Promise.resolve({ items: [receiptRaw], total })
        return Promise.resolve({ items: [], total: 0 })
      })

      const { container, root } = render(<ReceiptsPage />)
      await waitFor(() => container.textContent?.includes('R-001') ?? false)
      total = 100

      const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
      const storeSelect = getInputByLabel(container, '门店') as HTMLSelectElement
      const dateFromInput = getInputByLabel(container, '开始日期') as HTMLInputElement
      const dateToInput = getInputByLabel(container, '结束日期') as HTMLInputElement
      const pageSizeSelect = getInputByLabel(container, '每页') as HTMLSelectElement

      await waitFor(() => storeSelect.options.length > 1)

      act(() => {
        setInputValue(keywordInput, '  R-001  ')
        setSelectValue(storeSelect, 'store-1')
        setInputValue(dateFromInput, '2026-07-01')
        setInputValue(dateToInput, '2026-07-31')
        setSelectValue(pageSizeSelect, '10')
      })

      const queryButton = findButton(container, '查询')!
      act(() => queryButton.click())
      await waitFor(() => lastResourceUrl('/api/receipts').searchParams.get('keyword') === 'R-001')

      const filtered = lastResourceUrl('/api/receipts')
      expect(filtered.searchParams.get('keyword')).toBe('R-001')
      expect(filtered.searchParams.get('storeId')).toBe('store-1')
      expect(filtered.searchParams.get('dateFrom')).toBe('2026-07-01')
      expect(filtered.searchParams.get('dateTo')).toBe('2026-07-31')
      expect(filtered.searchParams.get('page')).toBe('1')
      expect(filtered.searchParams.get('pageSize')).toBe('10')

      await waitFor(() => container.textContent?.includes('100 条收货记录') ?? false)
      total = 100
      act(() => {
        mockFetch.mockClear()
      })
      const nextButton = findButton(container, '下一页')!
      act(() => nextButton.click())
      await waitFor(() => lastResourceUrl('/api/receipts').searchParams.get('page') === '2')

      const paged = lastResourceUrl('/api/receipts')
      expect(paged.searchParams.get('keyword')).toBe('R-001')
      expect(paged.searchParams.get('storeId')).toBe('store-1')
      expect(paged.searchParams.get('dateFrom')).toBe('2026-07-01')
      expect(paged.searchParams.get('dateTo')).toBe('2026-07-31')
      expect(paged.searchParams.get('pageSize')).toBe('10')
      expect(paged.searchParams.get('page')).toBe('2')

      const clearButton = findButton(container, '清空')!
      act(() => clearButton.click())
      await waitFor(() => lastResourceUrl('/api/receipts').searchParams.toString() === 'page=1&pageSize=20')

      const cleared = lastResourceUrl('/api/receipts')
      expect(cleared.searchParams.get('page')).toBe('1')
      expect(cleared.searchParams.get('pageSize')).toBe('20')
      expect(cleared.searchParams.get('keyword')).toBeNull()

      cleanup(container, root)
    })

    it('延迟旧响应返回后不会覆盖最新筛选结果', async () => {
      let firstResolve: (value: any) => void
      const firstPromise = new Promise<any>(resolve => { firstResolve = resolve })
      let receiptRequestCount = 0

      mockApi(path => {
        if (!path.startsWith('/api/receipts')) return Promise.resolve({ items: [], total: 0 })
        receiptRequestCount += 1
        if (receiptRequestCount === 1) return firstPromise
        return Promise.resolve({ items: [{ ...receiptRaw, id: 'r2', no: 'R-NEW' }], total: 1 })
      })

      const { container, root } = render(<ReceiptsPage />)
      await waitFor(() => resourceCalls('/api/receipts').length >= 1)

      const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
      act(() => {
        setInputValue(keywordInput, 'new')
      })
      const queryButton = findButton(container, '查询')!
      act(() => queryButton.click())

      await waitFor(() => container.textContent?.includes('R-NEW') ?? false)
      expect(container.textContent).not.toContain('R-001')

      firstResolve!({ items: [receiptRaw], total: 1 })
      await sleep(80)
      expect(container.textContent).toContain('R-NEW')
      expect(container.textContent).not.toContain('R-001')

      cleanup(container, root)
    })

    it('空列表展示空态', async () => {
      mockApi(() => Promise.resolve({ items: [], total: 0 }))
      const { container, root } = render(<ReceiptsPage />)
      await waitFor(() => container.querySelector('[data-empty-title]') !== null)
      expect(container.querySelector('[data-empty-title]')?.textContent).toContain('暂无收货记录')
      cleanup(container, root)
    })
  })

  describe('订货单查询 /v2/supply-chain/orders', () => {
    it('首次加载使用默认分页参数，状态筛选写入 URL', async () => {
      mockApi(() => Promise.resolve({ items: [orderRaw], total: 1 }))

      const { container, root } = render(<OrdersPage />)
      await waitFor(() => container.textContent?.includes('O-001') ?? false)

      const url = lastResourceUrl('/api/orders')
      expect(url.searchParams.get('page')).toBe('1')
      expect(url.searchParams.get('pageSize')).toBe('20')
      expect(url.searchParams.get('status')).toBeNull()

      assertNoWriteActions(container)
      assertNoFinancialFields(container)
      expect(container.textContent).toContain('金额')
      expect(container.textContent).toContain('合计')
      expect(container.textContent).toContain('¥9,999.99')
      cleanup(container, root)
    })

    it('综合筛选后查询与翻页保留状态等参数', async () => {
      let total = 1
      mockApi(path => {
        if (path.startsWith('/api/orders')) return Promise.resolve({ items: [orderRaw], total })
        return Promise.resolve({ items: [], total: 0 })
      })

      const { container, root } = render(<OrdersPage />)
      await waitFor(() => container.textContent?.includes('O-001') ?? false)
      total = 100

      const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
      const storeSelect = getInputByLabel(container, '门店') as HTMLSelectElement
      const dateFromInput = getInputByLabel(container, '开始日期') as HTMLInputElement
      const dateToInput = getInputByLabel(container, '结束日期') as HTMLInputElement
      const statusSelect = getInputByLabel(container, '状态') as HTMLSelectElement
      const pageSizeSelect = getInputByLabel(container, '每页') as HTMLSelectElement

      await waitFor(() => storeSelect.options.length > 1)

      act(() => {
        setInputValue(keywordInput, 'O-001')
        setSelectValue(storeSelect, 'store-1')
        setInputValue(dateFromInput, '2026-07-01')
        setInputValue(dateToInput, '2026-07-31')
        setSelectValue(statusSelect, 'CONFIRMED')
        setSelectValue(pageSizeSelect, '10')
      })

      act(() => findButton(container, '查询')!.click())
      await waitFor(() => lastResourceUrl('/api/orders').searchParams.get('status') === 'CONFIRMED')

      const url = lastResourceUrl('/api/orders')
      expect(url.searchParams.get('keyword')).toBe('O-001')
      expect(url.searchParams.get('storeId')).toBe('store-1')
      expect(url.searchParams.get('dateFrom')).toBe('2026-07-01')
      expect(url.searchParams.get('dateTo')).toBe('2026-07-31')
      expect(url.searchParams.get('status')).toBe('CONFIRMED')
      expect(url.searchParams.get('page')).toBe('1')
      expect(url.searchParams.get('pageSize')).toBe('10')

      await waitFor(() => container.textContent?.includes('100 条订货记录') ?? false)
      total = 100
      act(() => mockFetch.mockClear())
      act(() => findButton(container, '下一页')!.click())
      await waitFor(() => lastResourceUrl('/api/orders').searchParams.get('page') === '2')

      const paged = lastResourceUrl('/api/orders')
      expect(paged.searchParams.get('status')).toBe('CONFIRMED')
      expect(paged.searchParams.get('page')).toBe('2')

      act(() => findButton(container, '清空')!.click())
      await waitFor(() => lastResourceUrl('/api/orders').searchParams.toString() === 'page=1&pageSize=20')

      cleanup(container, root)
    })

    it('失败后点击重试重新请求', async () => {
      let shouldFail = true
      mockApi(path => {
        if (path.startsWith('/api/stores')) return Promise.resolve({ items: STORES })
        if (shouldFail) return Promise.reject(new Error('network failure'))
        return Promise.resolve({ items: [orderRaw], total: 1 })
      })

      const { container, root } = render(<OrdersPage />)
      await waitFor(() => container.querySelector('[data-error-message]') !== null)
      expect(container.querySelector('[data-error-message]')?.textContent).toContain('network failure')

      shouldFail = false
      act(() => (container.querySelector('[data-retry]') as HTMLButtonElement).click())
      await waitFor(() => container.textContent?.includes('O-001') ?? false)

      const calls = resourceCalls('/api/orders')
      expect(calls.length).toBeGreaterThanOrEqual(2)

      cleanup(container, root)
    })

    it('卸载时取消未完成的请求', async () => {
      let abortReason: string | undefined
      mockApi((_path, init) => {
        const signal = init?.signal
        if (signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'))
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            abortReason = String(signal.reason)
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      })

      const { container, root } = render(<OrdersPage />)
      await waitFor(() => resourceCalls('/api/orders').length >= 1)
      expect(resourceCalls('/api/orders').length).toBe(1)

      cleanup(container, root)
      await sleep(30)
      expect(abortReason).toBeDefined()
    })
  })

  describe('配送单查询 /v2/supply-chain/deliveries', () => {
    it('首次加载使用默认分页参数，不渲染写入口与财务字段', async () => {
      mockApi(() => Promise.resolve({ items: [deliveryRaw], total: 1 }))

      const { container, root } = render(<DeliveriesPage />)
      await waitFor(() => container.textContent?.includes('D-001') ?? false)

      const url = lastResourceUrl('/api/deliveries')
      expect(url.searchParams.get('page')).toBe('1')
      expect(url.searchParams.get('pageSize')).toBe('20')
      expect(url.searchParams.get('status')).toBeNull()

      assertNoWriteActions(container)
      assertNoFinancialFields(container)
      expect(container.textContent).toContain('金额')
      expect(container.textContent).toContain('合计')
      expect(container.textContent).toContain('¥5,555.55')
      cleanup(container, root)
    })

    it('综合筛选、翻页与清空符合 API 合同', async () => {
      let total = 1
      mockApi(path => {
        if (path.startsWith('/api/deliveries')) return Promise.resolve({ items: [deliveryRaw], total })
        return Promise.resolve({ items: [], total: 0 })
      })

      const { container, root } = render(<DeliveriesPage />)
      await waitFor(() => container.textContent?.includes('D-001') ?? false)
      total = 200

      const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
      const storeSelect = getInputByLabel(container, '门店') as HTMLSelectElement
      const dateFromInput = getInputByLabel(container, '开始日期') as HTMLInputElement
      const dateToInput = getInputByLabel(container, '结束日期') as HTMLInputElement
      const statusSelect = getInputByLabel(container, '状态') as HTMLSelectElement
      const pageSizeSelect = getInputByLabel(container, '每页') as HTMLSelectElement

      await waitFor(() => storeSelect.options.length > 1)

      act(() => {
        setInputValue(keywordInput, 'D-001')
        setSelectValue(storeSelect, 'store-1')
        setInputValue(dateFromInput, '2026-07-01')
        setInputValue(dateToInput, '2026-07-31')
        setSelectValue(statusSelect, 'SHIPPED')
        setSelectValue(pageSizeSelect, '50')
      })

      act(() => findButton(container, '查询')!.click())
      await waitFor(() => lastResourceUrl('/api/deliveries').searchParams.get('status') === 'SHIPPED')

      const url = lastResourceUrl('/api/deliveries')
      expect(url.searchParams.get('keyword')).toBe('D-001')
      expect(url.searchParams.get('storeId')).toBe('store-1')
      expect(url.searchParams.get('dateFrom')).toBe('2026-07-01')
      expect(url.searchParams.get('dateTo')).toBe('2026-07-31')
      expect(url.searchParams.get('status')).toBe('SHIPPED')
      expect(url.searchParams.get('page')).toBe('1')
      expect(url.searchParams.get('pageSize')).toBe('50')

      await waitFor(() => container.textContent?.includes('200 条配送记录') ?? false)
      act(() => mockFetch.mockClear())
      act(() => findButton(container, '下一页')!.click())
      await waitFor(() => lastResourceUrl('/api/deliveries').searchParams.get('page') === '2')

      const paged = lastResourceUrl('/api/deliveries')
      expect(paged.searchParams.get('status')).toBe('SHIPPED')
      expect(paged.searchParams.get('page')).toBe('2')
      expect(paged.searchParams.get('pageSize')).toBe('50')

      act(() => findButton(container, '清空')!.click())
      await waitFor(() => lastResourceUrl('/api/deliveries').searchParams.toString() === 'page=1&pageSize=20')

      cleanup(container, root)
    })
  })
})
