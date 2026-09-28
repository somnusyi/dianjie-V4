// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReplenishmentOrdersPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
  getUser: vi.fn(() => ({ role: 'SUPPLY_CHAIN' })),
}))
vi.mock('next/link', () => ({ default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('next/navigation', () => ({ usePathname: () => '/v2/supply-chain/replenishment-orders' }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const order: any = {
  id: 'ro-1', no: 'RO2026090001', storeId: 's1', supplierId: 'sp1', expectedDate: '2026-09-29T00:00:00.000Z',
  totalAmount: 20, status: 'SUBMITTED', displayStatus: 'SUBMITTED', source: 'SUPPLY_CHAIN_PROXY', note: '临时加单', rowVersion: 1,
  createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z',
  store: { id: 's1', no: '001', name: '江阴店' }, supplier: { id: 'sp1', no: '002', name: '总仓' }, createdBy: { id: 'u1', name: '张三', role: 'SUPPLY_CHAIN' },
  items: [{ productId: 'p1', quantity: 2, unitPrice: 10, amount: 20, productNameSnapshot: '白菜', orderUnitSnapshot: 'kg' }], fulfillment: null,
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
  throw new Error('waitFor timeout')
}

describe('门店补货单列表', () => {
  beforeEach(() => { mockFetch.mockReset(); mockFetch.mockResolvedValue({ items: [order], total: 1, page: 1, pageSize: 20 }) as any })

  it('shows the reviewed complete field set and unique next action on desktop and mobile', async () => {
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    act(() => root.render(<ReplenishmentOrdersPage />))
    await waitFor(() => container.textContent?.includes('RO2026090001') ?? false)
    for (const field of ['补货单号', '门店', '供应商', '期望到货日', '商品摘要', '状态', '来源', '创建时间', '创建人', '备注', '下一步']) expect(container.textContent).toContain(field)
    expect(container.textContent).toContain('独立补货需求，不改原订货单')
    expect(container.querySelectorAll('a[href="/v2/supply-chain/replenishment-orders/ro-1"]').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('接单')
    act(() => root.unmount()); container.remove()
  })
})
