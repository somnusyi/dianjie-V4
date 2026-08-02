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

let runboardOverdue = true
let failRunboard = false

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
    runboardOverdue = true
    failRunboard = false
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
      if (/^\/api\/stores\/[^/]+\/order-simulation\/catalog$/.test(url.pathname)) {
        const catalogStoreId = url.pathname.split('/')[3]
        return {
          mode: 'SIMULATION',
          store: { id: catalogStoreId, no: catalogStoreId === 'store-2' ? 'S02' : 'S01', name: catalogStoreId === 'store-2' ? '政务店' : '瑶海店', status: 'ACTIVE' },
          suppliers: [{ id: 'supplier-1', name: '测试供应商', category: '综合', inventoryMode: 'STRICT' }],
          products: [{
            id: `product-${catalogStoreId}`,
            supplierId: 'supplier-1',
            code: 'SKU-001',
            name: catalogStoreId === 'store-2' ? '政务店土豆' : '瑶海店土豆',
            category: '蔬菜', spec: '1kg', unit: 'kg', orderUnit: 'kg', orderUnitPrice: 10,
            minOrderQty: 1, stepQty: 1, availableStock: 10, reservedStock: 0,
          }],
        }
      }
      if (/^\/api\/stores\/[^/]+\/order-simulation\/preflight$/.test(url.pathname)) {
        return {
          mode: 'SIMULATION', persisted: false, canSubmit: true, canCompleteFlow: true,
          totalAmount: '10.00', itemCount: 1, issues: [],
          message: '模拟校验通过：按当前配置可提交，并可进入供应链接单流程',
        }
      }
      if (/^\/api\/stores\/[^/]+\/order-runboard$/.test(url.pathname)) {
        const runboardStoreId = url.pathname.match(/^\/api\/stores\/([^/]+)\/order-runboard$/)?.[1] || storeId
        if (failRunboard) throw new Error('模拟订货运行接口失败')
        if (!runboardOverdue) {
          return {
            date: '2026-07-26',
            todayOrders: { count: 0, itemCount: 0, totalAmount: '0.00' },
            latestOrder: null,
            statusBreakdown: {
              SUBMITTED: 0,
              CONFIRMED: 0,
              DELIVERING: 0,
              PENDING_CONFIRM: 0,
              RECEIVED: 4,
              COMPLETED: 2,
              CANCELLED: 1,
              inProgress: 0,
            },
            overdue: { count: 0, orders: [] },
          }
        }
        return {
          date: '2026-07-26',
          todayOrders: { count: 1, itemCount: 3, totalAmount: '350.00' },
          latestOrder: {
            id: `order-${runboardStoreId}`,
            no: runboardStoreId === 'store-2' ? 'PO-S02' : 'PO-S01',
            status: 'SUBMITTED',
            createdAt: '2026-07-26T09:30:00+08:00',
          },
          statusBreakdown: {
            SUBMITTED: 3,
            CONFIRMED: 2,
            DELIVERING: 1,
            PENDING_CONFIRM: 0,
            RECEIVED: 4,
            COMPLETED: 2,
            CANCELLED: 1,
            inProgress: 6,
          },
          overdue: {
            count: 1,
            orders: [{
              id: `overdue-${runboardStoreId}`,
              no: runboardStoreId === 'store-2' ? 'PO-OVERDUE-S02' : 'PO-OVERDUE-S01',
              status: 'SUBMITTED',
              createdAt: '2026-07-20T08:00:00+08:00',
              expectedDate: '2026-07-25',
              itemCount: 2,
              totalAmount: '120.00',
              overdueDays: 1,
            }],
          },
        }
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

  it('默认进入安全的模拟下单，运行监控作为次级视图', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('模拟购物车') ?? false)
    expect(container.textContent).toContain('模拟模式')
    expect(container.textContent).toContain('不会创建采购单')
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/stores/store-1/order-simulation/catalog')).toBe(true)

    const monitorTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '运行监控')!
    act(() => monitorTab.click())
    await waitFor(() => container.textContent?.includes('PO-OVERDUE-S01') ?? false)

    const urls = mockFetch.mock.calls.map(([path]) => String(path))
    expect(urls).toContain('/api/orders?storeId=store-1&page=1&pageSize=50')
    expect(urls).toContain('/api/receipts?storeId=store-1&page=1&pageSize=50')
    expect(urls).toContain('/api/inventory?storeId=store-1')
    expect(urls).toContain('/api/inventory/consumptions?days=30&storeId=store-1')
    expect(urls).toContain('/api/stores/store-1/overview')
    expect(urls).toContain('/api/stores/store-1/order-runboard')
    expect(urls).toContain('/api/stores/store-1/consumption-ranking?days=30&dimension=PRODUCT')
    expect(container.textContent).toContain('门店运营')
    expect(container.textContent).toContain('今日订货')
    expect(container.textContent).toContain('品项 3 · 订货金额 ¥350')
    expect(container.textContent).toContain('6 单')
    expect(container.textContent).toContain('待门店确认')
    expect(container.textContent).toContain('逾期')
    expect(container.textContent).toContain('PO-OVERDUE-S01')
    expect(container.textContent).toContain('超期 1 天')
    expect(container.textContent).toContain('#PO-S01 · 已提交')
    expect(container.textContent).toContain('低于安全线')
    expect(container.textContent).toContain('瑶海店土豆')
    expect(container.textContent).toContain('消耗金额 Top 10')
    expect(container.textContent).toContain('¥1,000')
    expect(container.textContent).toContain('80.0%')
    expect(container.textContent).toContain('2 条历史消耗缺少冻结成本')
    expect(container.textContent).toContain('SKU-001')
    expect(container.querySelector('a[href="/v2/supply-chain/fulfillment/overdue-store-1"]')).toBeTruthy()

    const inventoryTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '当前库存')!
    act(() => inventoryTab.click())
    expect(container.textContent).toContain('最近盘点 + 后续实收 − 消耗 − 报损')
    expect(container.textContent).not.toContain('调整库存')
    expect(container.textContent).not.toContain('确认收货')

    cleanup(container, root)
  })

  it('模拟加购与预检只调用 dry-run endpoint，不提交真实订单', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('模拟购物车') ?? false)

    const add = container.querySelector('button[aria-label="增加瑶海店土豆"]') as HTMLButtonElement
    act(() => add.click())
    expect(container.textContent).toContain('1 种商品')
    expect(container.textContent).toContain('预计 ¥10.00')

    const check = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('模拟校验完整下单链路'))!
    await act(async () => { check.click(); await Promise.resolve() })
    await waitFor(() => container.textContent?.includes('模拟通过') ?? false)

    const calls = mockFetch.mock.calls.map(([path, options]) => ({ path: String(path), method: (options as any)?.method }))
    expect(calls).toContainEqual({ path: '/api/stores/store-1/order-simulation/preflight', method: 'POST' })
    expect(calls.some(call => call.path === '/api/orders' && call.method === 'POST')).toBe(false)

    cleanup(container, root)
  })

  it('可切换商品/分类维度和 7/30/90 天范围', async () => {
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('模拟购物车') ?? false)
    const monitorTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '运行监控')!
    act(() => monitorTab.click())
    await waitFor(() => container.querySelectorAll('[data-ranking-item]').length === 1)

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
    await waitFor(() => container.textContent?.includes('瑶海店土豆') ?? false)

    const select = container.querySelector('select[aria-label="选择门店"]') as HTMLSelectElement
    act(() => Simulate.change(select, { target: { value: 'store-2' } as any }))
    await waitFor(() => container.textContent?.includes('政务店土豆') ?? false)

    expect(mockFetch.mock.calls.some(([path]) => String(path).includes('storeId=store-2'))).toBe(true)
    expect(container.textContent).toContain('政务店土豆')
    expect(container.textContent).not.toContain('瑶海店土豆')
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/stores/store-2/order-simulation/catalog')).toBe(true)

    cleanup(container, root)
  })

  it('无逾期订单时显示中性的今日未订货与明确的运行正常态', async () => {
    runboardOverdue = false
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('模拟购物车') ?? false)
    const monitorTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '运行监控')!
    act(() => monitorTab.click())
    await waitFor(() => container.textContent?.includes('运行正常') ?? false)

    expect(container.textContent).toContain('今日暂无订货')
    expect(container.textContent).toContain('当前没有超过预计到货日仍未完成的订单')
    expect(container.textContent).not.toContain('PO-OVERDUE')

    cleanup(container, root)
  })

  it('订货运行接口失败时给出可理解提示，其余区块仍可用', async () => {
    failRunboard = true
    const { container, root } = render(<StoresPage />)
    await waitFor(() => container.textContent?.includes('模拟购物车') ?? false)
    const monitorTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === '运行监控')!
    act(() => monitorTab.click())
    await waitFor(() => container.textContent?.includes('订货运行数据加载失败') ?? false)

    expect(container.textContent).toContain('模拟订货运行接口失败')
    expect(container.textContent).toContain('瑶海店土豆')
    expect(container.textContent).toContain('消耗金额 Top 10')

    cleanup(container, root)
  })
})
