// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplenishmentOrderEditor } from './replenishment-order-editor'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from './supply-chain-shell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const replace = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }))
vi.mock('next/link', () => ({ default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/lib/v2-auth', () => ({
  getUser: () => ({ role: 'SUPPLY_CHAIN' }), apiFetch: vi.fn(),
}))
import { apiFetch } from '@/lib/v2-auth'
const mockFetch = vi.mocked(apiFetch)

const submitted: any = {
  id: 'ro-1', no: 'RO001', storeId: 's1', supplierId: 'sp1', expectedDate: '2026-09-29T00:00:00.000Z', totalAmount: 25,
  status: 'SUBMITTED', displayStatus: 'SUBMITTED', source: 'SUPPLY_CHAIN_PROXY', note: '加急', rowVersion: 1,
  createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', store: { id: 's1', no: '001', name: '门店一' },
  supplier: { id: 'sp1', no: '002', name: '总仓' }, createdBy: { id: 'u1', name: '供应链甲', role: 'SUPPLY_CHAIN' }, fulfillment: null,
  items: [{ id: 'i1', productId: 'p1', quantity: 2.5, unitPrice: 10, amount: 25, productCodeSnapshot: 'P001', productNameSnapshot: '白菜', productSpecSnapshot: '散装', orderUnitSnapshot: 'kg' }],
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }
  throw new Error('waitFor timeout')
}

describe('门店补货单编辑与履约页面', () => {
  beforeEach(() => {
    mockFetch.mockReset(); push.mockReset(); replace.mockReset()
    mockFetch.mockImplementation((path: any) => {
      const url = String(path)
      if (url === '/api/stores') return Promise.resolve([{ id: 's1', no: '001', name: '门店一' }])
      if (url.startsWith('/api/suppliers')) return Promise.resolve([{ id: 'sp1', no: '002', name: '总仓' }])
      if (url.startsWith('/api/products')) return Promise.resolve([{ id: 'p1', code: 'P001', name: '白菜', spec: '散装', status: 'ENABLED', supplierId: 'sp1', orderUnit: 'kg', price: 10 }])
      if (url === '/api/replenishment-orders/ro-1') return Promise.resolve(submitted)
      return Promise.reject(new Error(`unexpected ${url}`))
    })
  })

  it('keeps product quantity, unit and frozen price visible on mobile and offers only accept as primary submitted action', async () => {
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    act(() => root.render(<ReplenishmentOrderEditor orderId="ro-1" />))
    await waitFor(() => Boolean(container.querySelector('input[type="number"]')))
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('2.5')
    expect(container.textContent).toContain('kg')
    expect(container.textContent).toContain('¥10.00')
    expect(container.textContent).toContain('接单并生成正式订单')
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '保存草稿')).toBe(false)
    expect(container.textContent).toContain('不调整原订货单')
    act(() => root.unmount()); container.remove()
  })

  it('renders frozen snapshots even when a historical product is no longer in the active catalog', async () => {
    mockFetch.mockImplementation((path: any) => {
      const url = String(path)
      if (url === '/api/stores') return Promise.resolve([])
      if (url.startsWith('/api/suppliers')) return Promise.resolve([])
      if (url.startsWith('/api/products')) return Promise.resolve([])
      if (url === '/api/replenishment-orders/ro-1') return Promise.resolve({ ...submitted, displayStatus: 'COMPLETED', status: 'ACCEPTED' })
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    act(() => root.render(<ReplenishmentOrderEditor orderId="ro-1" />))
    await waitFor(() => container.textContent?.includes('白菜') ?? false)
    expect(container.textContent).toContain('P001 · 散装')
    expect(container.textContent).toContain('¥10.00')
    act(() => root.unmount()); container.remove()
  })

  it('offers an explicit reprice-and-save recovery after submit detects a catalog price change', async () => {
    const draft = { ...submitted, status: 'DRAFT', displayStatus: 'DRAFT' }
    mockFetch.mockImplementation((path: any, init?: RequestInit) => {
      const url = String(path)
      if (url === '/api/stores') return Promise.resolve([{ id: 's1', no: '001', name: '门店一' }])
      if (url.startsWith('/api/suppliers')) return Promise.resolve([{ id: 'sp1', no: '002', name: '总仓' }])
      if (url.startsWith('/api/products')) return Promise.resolve([{ id: 'p1', code: 'P001', name: '白菜', spec: '散装', status: 'ENABLED', supplierId: 'sp1', orderUnit: 'kg', price: 12 }])
      if (url === '/api/replenishment-orders/ro-1/submit') return Promise.reject(Object.assign(new Error('商品价格已变动，请核对价格差异并确认后再保存提交'), {
        status: 409,
        data: { code: 'REPLENISHMENT_PRICE_CHANGED', changedItems: [{ productId: 'p1', productName: '白菜', oldPrice: '10.00', newPrice: '12.00', delta: '2.00' }] },
      }))
      if (url === '/api/replenishment-orders/ro-1' && init?.method === 'PATCH') return Promise.resolve({ ...draft, rowVersion: 2, totalAmount: 30, items: [{ ...draft.items[0], unitPrice: 12, amount: 30 }] })
      if (url === '/api/replenishment-orders/ro-1') return Promise.resolve(draft)
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    act(() => root.render(<ReplenishmentOrderEditor orderId="ro-1" />))
    await waitFor(() => Array.from(container.querySelectorAll('button')).some(button => button.textContent === '提交补货单'))
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交补货单')?.click() })
    await waitFor(() => container.textContent?.includes('提交前价格发生变化') ?? false)
    expect(container.textContent).toContain('¥10.00 → ¥12.00')
    expect(container.textContent).toContain('涨 ¥2.00')
    expect(mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/replenishment-orders/ro-1' && init?.method === 'PATCH')).toBe(false)
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '暂不更新')?.click() })
    expect(mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/replenishment-orders/ro-1' && init?.method === 'PATCH')).toBe(false)
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交补货单')?.click() })
    await waitFor(() => container.textContent?.includes('提交前价格发生变化') ?? false)
    const recovery = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认新价格并保存')
    expect(recovery?.hasAttribute('disabled')).toBe(false)
    await act(async () => { recovery?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/replenishment-orders/ro-1' && init?.method === 'PATCH'))
    expect(container.textContent).toContain('¥12.00')
    act(() => root.unmount()); container.remove()
  })

  it('blocks global shell navigation for a dirty draft, preserves edits on cancel, and proceeds only once after confirmation', async () => {
    const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
    act(() => root.render(<ReplenishmentOrderEditor />))
    await waitFor(() => Boolean(container.querySelector('textarea[placeholder^="说明额外补货原因"]')))

    const cleanProceed = vi.fn()
    const cleanEvent = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, {
      cancelable: true,
      detail: { proceed: cleanProceed },
    })
    expect(window.dispatchEvent(cleanEvent)).toBe(true)
    expect(cleanProceed).not.toHaveBeenCalled()

    const note = container.querySelector('textarea[placeholder^="说明额外补货原因"]') as HTMLTextAreaElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(note, '临时加急补货')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(note.value).toBe('临时加急补货')
    const unloadWhileDirty = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(unloadWhileDirty)).toBe(false)

    const proceed = vi.fn()
    const firstAttempt = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, {
      cancelable: true,
      detail: { proceed },
    })
    let firstAllowed = true
    act(() => { firstAllowed = window.dispatchEvent(firstAttempt) })
    expect(firstAllowed).toBe(false)
    expect(proceed).not.toHaveBeenCalled()
    await waitFor(() => container.textContent?.includes('放弃未保存的补货草稿？') ?? false)

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find(button => button.textContent === '取消')?.click()
    })
    expect(note.value).toBe('临时加急补货')
    expect(proceed).not.toHaveBeenCalled()

    const secondAttempt = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, {
      cancelable: true,
      detail: { proceed },
    })
    let secondAllowed = true
    act(() => { secondAllowed = window.dispatchEvent(secondAttempt) })
    expect(secondAllowed).toBe(false)
    await waitFor(() => container.textContent?.includes('放弃并离开') ?? false)
    const confirm = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '放弃并离开')
    await act(async () => { confirm?.click(); confirm?.click() })
    expect(proceed).toHaveBeenCalledTimes(1)

    const afterConfirm = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true })
    expect(window.dispatchEvent(afterConfirm)).toBe(true)
    const unloadAfterConfirm = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(unloadAfterConfirm)).toBe(true)
    act(() => root.unmount()); container.remove()
  })
})
