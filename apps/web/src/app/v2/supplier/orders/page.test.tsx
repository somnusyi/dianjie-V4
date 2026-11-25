// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SupplierOrdersPage from './page'
import { apiFetch } from '@/lib/v2-auth'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(), getUser: () => ({ role: 'SUPPLIER_OWNER' }) }))
let requestSequence = 0
vi.mock('@/lib/client-id', () => ({ clientRequestId: () => `batch-request-${++requestSequence}` }))
vi.mock('@/components/v2', () => ({
  BottomNav: () => null,
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ProgressDots: () => null,
}))

const fetch = vi.mocked(apiFetch)
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement

function order(id: string, status: 'SUBMITTED' | 'CONFIRMED') {
  return {
    id, no: `PO-${id}`, status, totalAmount: '10', expectedDate: '2026-11-30', createdAt: '2026-11-23T00:00:00Z', shippedAt: null,
    store: { id: `store-${id}`, name: `门店 ${id}` },
    items: [{ id: `item-${id}`, quantity: '1', unitPrice: '10', product: { name: '商品', unit: '件' } }],
    deliveries: [], receipts: [], lossClaims: [],
  }
}

function button(text: string) {
  return Array.from(host.querySelectorAll('button')).find(item => item.textContent?.trim() === text) as HTMLButtonElement | undefined
}

async function render(status: 'SUBMITTED' | 'CONFIRMED') {
  const rows = [order('1', status), order('2', status)]
  fetch.mockImplementation(async (url: any) => {
    const path = String(url)
    if (path.startsWith('/api/orders?')) return { items: rows, total: rows.length } as any
    if (path.startsWith('/api/loss-claims?')) return { items: [], total: 0 } as any
    if (path.startsWith('/api/deliveries?')) return { items: [], total: 0 } as any
    if (path === '/api/orders/print-events') return { count: 1, printStatus: '已发起打印' } as any
    if (path.startsWith('/api/orders/') && (path.endsWith('/confirm') || path.endsWith('/ship'))) return { success: true } as any
    throw new Error(`unexpected ${path}`)
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<SupplierOrdersPage />))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

beforeEach(() => {
  requestSequence = 0
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('供应商订单列表批量处理', () => {
  it('在当前筛选列表的选择框前显示连续序号', async () => {
    await render('SUBMITTED')
    const labels = Array.from(host.querySelectorAll('label')).filter(label => label.textContent?.includes('选择此订单'))
    expect(labels.map(label => label.textContent?.replace(/\s+/g, ''))).toEqual(['1选择此订单', '2选择此订单'])
  })

  it('只对勾选的待接订单调用接单端点', async () => {
    await render('SUBMITTED')
    await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="选择订单 PO-1"]')!.click())
    await act(async () => button('批量接单')!.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const writes = fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(writes.map(([url]) => String(url))).toEqual(['/api/orders/1/confirm'])
    expect(host.textContent).toContain('批量接单完成：成功 1，失败 0')
  })

  it('全选当前页后逐张发货并使用独立幂等键', async () => {
    window.history.replaceState({}, '', '/?filter=%E5%BE%85%E5%8F%91%E8%B4%A7')
    await render('CONFIRMED')
    const all = Array.from(host.querySelectorAll('label')).find(label => label.textContent?.includes('全选当前页'))!.querySelector('input') as HTMLInputElement
    await act(async () => all.click())
    await act(async () => button('批量发货')!.click())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const writes = fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    expect(writes.map(([url]) => String(url))).toEqual(['/api/orders/1/ship', '/api/orders/2/ship'])
    expect(writes.map(([, init]) => JSON.parse(String((init as RequestInit).body)).idempotencyKey)).toEqual(['batch-request-1', 'batch-request-2'])
    expect(host.textContent).toContain('批量按订货数量发货完成：成功 2，失败 0')
  })

  it('供应商订单页不提供批量打印入口', async () => {
    await render('SUBMITTED')
    await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="选择订单 PO-2"]')!.click())
    expect(button('合并打印')).toBeUndefined()
    expect(host.querySelector('[data-supplier-selected-print]')).toBeNull()
  })

  it('导出链接只包含所选订单', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await render('SUBMITTED')
    await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="选择订单 PO-1"]')!.click())
    await act(async () => button('导出所选')!.click())
    expect(open).toHaveBeenCalledWith('/api/orders/export.xlsx?orderIds=1', '_blank', 'noopener')
  })
})
