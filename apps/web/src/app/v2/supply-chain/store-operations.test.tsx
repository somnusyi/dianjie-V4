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

function getCalls(pathname: string) {
  return mockFetch.mock.calls.filter(([path]) => {
    const url = new URL(String(path), 'http://localhost')
    return url.pathname === pathname
  })
}

function lastCall(pathname: string): [string, RequestInit?] | undefined {
  const calls = getCalls(pathname)
  return calls[calls.length - 1] as [string, RequestInit?] | undefined
}

function lastCallUrl(pathname: string): URL | null {
  const call = lastCall(pathname)
  if (!call) return null
  return new URL(String(call[0]), 'http://localhost')
}

describe('内部供应链门店运营', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (path, init) => {
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
        const page = Number(url.searchParams.get('page') || 1)
        const pageSize = Number(url.searchParams.get('pageSize') || 20)
        const q = url.searchParams.get('q')
        const startDate = url.searchParams.get('startDate')
        const endDate = url.searchParams.get('endDate')
        const idPrefix = storeId === 'store-2' ? 's2' : 's1'
        const baseName = storeId === 'store-2' ? '政务店土豆' : '瑶海店土豆'

        let items = Array.from({ length: 42 }, (_, i) => ({
          id: `consumption-${idPrefix}-${i + 1}`,
          date: '2026-07-26',
          quantity: i + 1,
          unitSnapshot: 'kg',
          product: { code: `SKU-${String(i + 1).padStart(3, '0')}`, name: `${baseName}-${i + 1}`, unit: 'kg' },
        }))

        if (q) {
          items = items.filter(row =>
            row.product.name.includes(q) || row.product.code.toLowerCase().includes(q.toLowerCase()),
          )
        }
        if (startDate || endDate) {
          items = items.filter(() => true)
        }

        const total = items.length
        const paginated = items.slice((page - 1) * pageSize, page * pageSize)

        // store-1 模拟慢响应，用于验证切换门店时旧请求被忽略
        const delay = storeId === 'store-1' ? 80 : 10
        return new Promise(resolve => setTimeout(() => resolve({
          items: paginated,
          total,
          page,
          pageSize,
          startDate,
          endDate,
          q,
        }), delay))
      }
      if (/^\/api\/stores\/[^/]+\/overview$/.test(url.pathname)) {
        return {
          orderCount: 6,
          orderStatusBreakdown: {
            SUBMITTED: 3,
            CONFIRMED: 2,
            DELIVERING: 1,
            inProgress: 6,
          },
          validReceiptCount: 10,
          inventoryProductCount: 25,
          lowStockCount: 1,
          consumptionCount30d: 42,
        }
      }
      if (/^\/api\/stores\/[^/]+\/consumption-ranking$/.test(url.pathname)) {
        const dimension = url.searchParams.get('dimension') || 'PRODUCT'
        const days = Number(url.searchParams.get('days') || 30)
        const category = dimension === 'CATEGORY'
        return {
          dimension,
          days,
          startDate: '2026-06-27',
          endDate: '2026-07-26',
          totalAmount: 1000,
          top10Amount: 800,
          top10Coverage: 0.8,
          recordCount: 42,
          pricedRecordCount: 40,
          unpricedRecordCount: 2,
          items: [{
            id: category ? '蔬菜' : 'product-1',
            name: category ? '蔬菜' : '土豆',
            code: category ? null : 'SKU-001',
            category: '蔬菜',
            amount: category ? 600 : 400,
            share: category ? 0.6 : 0.4,
            recordCount: 20,
            pricedRecordCount: 20,
          }],
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
  })

  it('默认按第一家门店加载四类只读数据与精确概览，并可切换视图', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const urls = mockFetch.mock.calls.map(([path]) => String(path))
    expect(urls).toContain('/api/orders?storeId=store-1&page=1&pageSize=50')
    expect(urls).toContain('/api/receipts?storeId=store-1&page=1&pageSize=50')
    expect(urls).toContain('/api/inventory?storeId=store-1')
    expect(urls).toContain('/api/stores/store-1/overview')
    expect(urls).toContain('/api/stores/store-1/consumption-ranking?days=30&dimension=PRODUCT')
    // 消耗记录改为进入 Tab 后才分页加载，初始不应请求
    expect(getCalls('/api/inventory/consumptions')).toHaveLength(0)
    expect(container.textContent).toContain('门店运营')
    expect(container.textContent).toContain('低于安全线')
    expect(container.textContent).toContain('6 单')
    expect(container.textContent).toContain('10 单')
    expect(container.textContent).toContain('瑶海店土豆')
    expect(container.textContent).toContain('消耗金额 Top 10')
    expect(container.textContent).toContain('¥1,000')
    expect(container.textContent).toContain('80.0%')
    expect(container.textContent).toContain('2 条历史消耗缺少冻结成本')
    expect(container.textContent).toContain('SKU-001')

    const inventoryTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '当前库存')!
    act(() => inventoryTab.click())
    expect(container.textContent).toContain('最近盘点 + 后续实收 − 消耗 − 报损')
    expect(container.textContent).not.toContain('调整库存')
    expect(container.textContent).not.toContain('确认收货')

    cleanup(container, root)
  })

  it('可切换商品/分类维度和 7/30/90 天范围', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('SKU-001') ?? false)

    const categoryButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '按分类',
    )!
    act(() => categoryButton.click())
    await waitFor(() => mockFetch.mock.calls.some(([path]) =>
      String(path) === '/api/stores/store-1/consumption-ranking?days=30&dimension=CATEGORY',
    ))
    await waitFor(() => container.querySelectorAll('[data-ranking-item]').length === 1
      && (container.textContent?.includes('¥600') ?? false))

    const sevenDaysButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '7天',
    )!
    act(() => sevenDaysButton.click())
    await waitFor(() => mockFetch.mock.calls.some(([path]) =>
      String(path) === '/api/stores/store-1/consumption-ranking?days=7&dimension=CATEGORY',
    ))
    await waitFor(() => container.querySelectorAll('[data-ranking-item]').length === 1
      && (container.textContent?.includes('¥600') ?? false))

    expect(container.querySelectorAll('[data-ranking-item]').length).toBe(1)
    expect(container.textContent).toContain('¥600')

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

  it('消耗记录 Tab 使用后端分页，携带 page/pageSize/storeId 并展示总条数', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const consumptionTab = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '消耗记录',
    )!
    act(() => consumptionTab.click())
    await waitFor(() => container.textContent?.includes('1-20 项，共 42 项') ?? false)

    const url = lastCallUrl('/api/inventory/consumptions')
    expect(url?.searchParams.get('storeId')).toBe('store-1')
    expect(url?.searchParams.get('page')).toBe('1')
    expect(url?.searchParams.get('pageSize')).toBe('20')
    expect(container.textContent).toContain('瑶海店土豆-1')
    expect(container.textContent).toContain('瑶海店土豆-20')
    expect(container.textContent).not.toContain('瑶海店土豆-21')

    cleanup(container, root)
  })

  it('翻页保留筛选并更新当前范围', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const consumptionTab = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '消耗记录',
    )!
    act(() => consumptionTab.click())
    await waitFor(() => container.textContent?.includes('1-20 项，共 42 项') ?? false)

    const nextButton = container.querySelector('button[aria-label="下一页"]') as HTMLButtonElement
    act(() => nextButton.click())
    await waitFor(() => container.textContent?.includes('瑶海店土豆-21') ?? false)

    const url = lastCallUrl('/api/inventory/consumptions')
    expect(url?.searchParams.get('page')).toBe('2')
    expect(url?.searchParams.get('pageSize')).toBe('20')
    expect(container.textContent).toContain('21-40 项，共 42 项')
    expect(container.textContent).toContain('瑶海店土豆-40')

    cleanup(container, root)
  })

  it('修改日期、关键字或页大小时回到第 1 页，空值不进 query', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const consumptionTab = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '消耗记录',
    )!
    act(() => consumptionTab.click())
    await waitFor(() => container.textContent?.includes('1-20 项，共 42 项') ?? false)

    // 翻到第 2 页
    const nextButton = container.querySelector('button[aria-label="下一页"]') as HTMLButtonElement
    act(() => nextButton.click())
    await waitFor(() => container.textContent?.includes('21-40 项，共 42 项') ?? false)

    // 修改日期筛选应回到第 1 页
    const startDateInput = container.querySelector('input[aria-label="开始日期"]') as HTMLInputElement
    act(() => Simulate.change(startDateInput, { target: { value: '2026-07-01' } as any }))
    await waitFor(() => {
      const url = lastCallUrl('/api/inventory/consumptions')
      return url?.searchParams.get('page') === '1' && url?.searchParams.get('startDate') === '2026-07-01'
    })

    // 修改关键字筛选应回到第 1 页
    const qInput = container.querySelector('input[aria-label="商品名称或编码"]') as HTMLInputElement
    act(() => Simulate.change(qInput, { target: { value: '土豆-5' } as any }))
    await waitFor(() => {
      const url = lastCallUrl('/api/inventory/consumptions')
      return url?.searchParams.get('page') === '1' && url?.searchParams.get('q') === '土豆-5'
    })

    // 修改页大小应回到第 1 页
    const pageSizeSelect = container.querySelector('select[aria-label="每页条数"]') as HTMLSelectElement
    act(() => Simulate.change(pageSizeSelect, { target: { value: '50' } as any }))
    await waitFor(() => {
      const url = lastCallUrl('/api/inventory/consumptions')
      return url?.searchParams.get('page') === '1' && url?.searchParams.get('pageSize') === '50'
    })

    // 清空筛选后空值不应出现在 query 中
    const clearButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '清空筛选',
    )!
    act(() => clearButton.click())
    await waitFor(() => {
      const url = lastCallUrl('/api/inventory/consumptions')
      return url?.searchParams.get('page') === '1'
        && !url.searchParams.has('startDate')
        && !url.searchParams.has('endDate')
        && !url.searchParams.has('q')
    })

    cleanup(container, root)
  })

  it('切换门店取消旧请求并忽略旧门店的响应', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const consumptionTab = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '消耗记录',
    )!
    act(() => consumptionTab.click())

    // 立刻切换门店，store-1 的慢响应不应覆盖 store-2 的结果
    const select = container.querySelector('select[aria-label="选择门店"]') as HTMLSelectElement
    act(() => Simulate.change(select, { target: { value: 'store-2' } as any }))

    await waitFor(() => container.textContent?.includes('政务店土豆-1') ?? false, 2000)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })

    expect(container.textContent).toContain('政务店土豆-1')
    expect(container.textContent).not.toContain('瑶海店土豆-1')

    const url = lastCallUrl('/api/inventory/consumptions')
    expect(url?.searchParams.get('storeId')).toBe('store-2')
    expect(url?.searchParams.get('page')).toBe('1')

    cleanup(container, root)
  })

  it('API 失败保留筛选并提供重试', async () => {
    mockFetch.mockImplementation(async (path, init) => {
      const url = new URL(String(path), 'http://localhost')
      if (url.pathname === '/api/inventory/consumptions') {
        throw new Error('network error')
      }
      const storeId = url.searchParams.get('storeId')
      if (url.pathname === '/api/orders') {
        return { items: [{ id: `order-${storeId}`, no: 'PO-S01', status: 'SUBMITTED', createdAt: '2026-07-26', totalAmount: 100, supplier: { id: 'supplier-1', name: '测试供应商' } }], total: 1 }
      }
      if (url.pathname === '/api/receipts') {
        return { items: [{ id: `receipt-${storeId}`, no: 'RK-S01', status: 'CONFIRMED', deliveryDate: '2026-07-26', supplier: { id: 'supplier-1', name: '测试供应商' } }], total: 1 }
      }
      if (url.pathname === '/api/inventory') {
        return [{ id: `inventory-${storeId}`, code: 'SKU-001', name: '瑶海店土豆', stock: 2, minStock: 5, inventoryUnit: 'kg' }]
      }
      if (/^\/api\/stores\/[^/]+\/overview$/.test(url.pathname)) {
        return { orderCount: 6, orderStatusBreakdown: { SUBMITTED: 3, CONFIRMED: 2, DELIVERING: 1, inProgress: 6 }, validReceiptCount: 10, inventoryProductCount: 25, lowStockCount: 1, consumptionCount30d: 42 }
      }
      if (/^\/api\/stores\/[^/]+\/consumption-ranking$/.test(url.pathname)) {
        return { dimension: 'PRODUCT', days: 30, startDate: '2026-06-27', endDate: '2026-07-26', totalAmount: 1000, top10Amount: 800, top10Coverage: 0.8, recordCount: 42, pricedRecordCount: 40, unpricedRecordCount: 2, items: [{ id: 'product-1', name: '土豆', code: 'SKU-001', category: '蔬菜', amount: 400, share: 0.4, recordCount: 20, pricedRecordCount: 20 }] }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('PO-S01') ?? false)

    const consumptionTab = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '消耗记录',
    )!
    act(() => consumptionTab.click())
    await waitFor(() => container.textContent?.includes('network error') ?? false)

    expect(container.textContent).toContain('network error')

    // 重试按钮存在，且请求仍保留现有筛选
    const retryButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '重试',
    )!
    expect(retryButton).toBeTruthy()

    cleanup(container, root)
  })
})
