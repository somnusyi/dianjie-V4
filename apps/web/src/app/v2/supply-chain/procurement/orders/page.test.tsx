// @vitest-environment jsdom

import React, { act } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PurchaseOrderHistoryPage from './page'

const mockFetch = vi.fn()
vi.mock('@/lib/v2-auth', () => ({ apiFetch: (...args: unknown[]) => mockFetch(...args) }))

const order = {
  id: 'order-1', no: 'PO202611160001', createdAt: '2026-11-16T02:00:00.000Z', status: 'RECEIVED', supplierId: 'supplier-1',
  supplier: { id: 'supplier-1', no: 'SUP001', name: '测试供应商' }, warehouse: { id: 'warehouse-1', code: 'WH01', name: '总仓' },
  expectedArrivalAt: '2026-11-17T00:00:00.000Z', totalAmount: 120, currency: 'CNY', _count: { lines: 1, shipments: 1, receipts: 1 },
  lines: [{ id: 'line-1', productNameSnapshot: '松茸', productCodeSnapshot: 'P001', purchaseUnit: '箱', orderedQty: 2, shippedQty: 2, receivedQty: 2, unitPrice: 60, totalAmount: 120 }],
}

describe('PurchaseOrderHistoryPage', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    mockFetch.mockReset()
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [order.supplier] })
      if (path === '/api/upstream/purchase-orders/order-1') return Promise.resolve(order)
      if (path.startsWith('/api/upstream/purchase-orders?')) return Promise.resolve({ items: [order], total: 1, page: 1, pageSize: 20 })
      return Promise.reject(new Error(`unexpected ${path}`))
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(<PurchaseOrderHistoryPage />) })
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('服务端组合单号、供应商、日期、商品和状态筛选', async () => {
    await act(async () => { await Promise.resolve() })
    const change = (label: string, value: string) => {
      const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
      act(() => Simulate.change(input, { target: { value } as any }))
    }
    change('采购单号', 'PO20261116')
    change('供应商', 'supplier-1')
    change('开始日期', '2026-11-01')
    change('结束日期', '2026-11-16')
    change('商品', '松茸')
    change('状态', 'RECEIVED')
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查询')!.click(); await Promise.resolve() })
    const request = mockFetch.mock.calls.map(([path]) => String(path)).find(path => path.includes('orderQuery=PO20261116'))!
    expect(request).toContain('supplierId=supplier-1')
    expect(request).toContain('dateFrom=2026-11-01')
    expect(request).toContain('dateTo=2026-11-16')
    expect(request).toContain('productQuery=%E6%9D%BE%E8%8C%B8')
    expect(request).toContain('status=RECEIVED')
  })

  it('从历史列表打开独立详情接口返回的完整商品明细', async () => {
    await act(async () => { await Promise.resolve() })
    const button = container.querySelector(`button[aria-label="查看采购单 ${order.no} 明细"]`) as HTMLButtonElement
    await act(async () => { button.click(); await Promise.resolve() })
    expect(mockFetch).toHaveBeenCalledWith('/api/upstream/purchase-orders/order-1')
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('松茸')
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('¥120.00')
  })

  it('页面仅提供历史查询，不提供新建采购单操作', async () => {
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('采购记录')
    expect(container.querySelector('a[href="/v2/supply-chain/procurement"]')?.textContent).toContain('返回发起采购')
    expect(container.textContent).not.toContain('新建采购单')
  })

  it('草稿可在采购记录中直接发送供应商', async () => {
    let current = { ...order, status: 'DRAFT' }
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [order.supplier] })
      if (path === '/api/upstream/purchase-orders/order-1') return Promise.resolve(current)
      if (path.startsWith('/api/upstream/purchase-orders?')) return Promise.resolve({ items: [current], total: 1 })
      if (path.endsWith('/send-to-supplier')) { current = { ...current, status: 'SUBMITTED_TO_SUPPLIER' }; return Promise.resolve(current) }
      if (path.endsWith('/approve-and-send')) { current = { ...current, status: 'SUBMITTED_TO_SUPPLIER' }; return Promise.resolve(current) }
      return Promise.reject(new Error(`unexpected ${path}`))
    })
    const click = async (label: string) => {
      const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)
      expect(button, label).toBeTruthy()
      await act(async () => { button!.click(); await Promise.resolve() })
    }
    await click('查询')
    await click('查看并处理')
    await click('发送供应商')
    await click('确认')
    expect(mockFetch).toHaveBeenCalledWith('/api/upstream/purchase-orders/order-1/send-to-supplier', { method: 'POST' })
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('待供应商接单')
  })

  it('涨价申请在采购记录中显示原价与新价，并由供应链确认', async () => {
    const pending = { ...order, status: 'CHANGE_PROPOSED', rowVersion: 3, revisions: [{
      id: 'revision-1', status: 'PENDING', reason: '供应商报价调整', revisionNo: 1,
      beforeSnapshot: { lines: [{ id: 'line-1', quantity: 2, unitPrice: 60 }] },
      afterSnapshot: { lines: [{ id: 'line-1', quantity: 2, unitPrice: 65 }] },
    }] }
    mockFetch.mockImplementation((path: string) => {
      if (path === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [order.supplier] })
      if (path === '/api/upstream/purchase-orders/order-1') return Promise.resolve(pending)
      if (path.startsWith('/api/upstream/purchase-orders?')) return Promise.resolve({ items: [pending], total: 1 })
      if (path.endsWith('/revisions/revision-1/review')) return Promise.resolve({ decision: 'ACCEPT' })
      return Promise.reject(new Error(`unexpected ${path}`))
    })
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查询')!.click(); await Promise.resolve() })
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看并处理')!.click(); await Promise.resolve() })
    expect(container.querySelector('[aria-label="待确认调价"]')?.textContent).toContain('¥60.00 元/箱')
    expect(container.querySelector('[aria-label="待确认调价"]')?.textContent).toContain('¥65.00 元/箱')
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '同意调价')!.click() })
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认')!.click(); await Promise.resolve() })
    expect(mockFetch).toHaveBeenCalledWith('/api/upstream/purchase-orders/order-1/revisions/revision-1/review', {
      method: 'POST', body: JSON.stringify({ decision: 'ACCEPT', rowVersion: 3 }),
    })
  })
})
