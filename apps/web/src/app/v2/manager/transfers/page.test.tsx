// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ManagerTransfersPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(), getUser: () => ({ role: 'MANAGER' }) }))
import { apiFetch } from '@/lib/v2-auth'
const fetchMock = vi.mocked(apiFetch)

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  throw new Error('页面未进入预期状态')
}

function selectValue(input: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('店长门店调拨', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    fetchMock.mockImplementation((path, init) => {
      if (path === '/api/store-transfers/eligible-stores') return Promise.resolve({
        sources: [{ id: 'mine', no: 'DJ001', name: '本店' }],
        destinations: [{ id: 'mine', no: 'DJ001', name: '本店' }, { id: 'sister', no: 'DJ002', name: '同品牌店' }],
      })
      if (path === '/api/store-transfers/products') return Promise.resolve([{ id: 'p1', code: 'P1', name: '香菇', inventoryUnit: '箱' }])
      if (path === '/api/store-transfers' && init?.method === 'POST') return Promise.resolve({ id: 'transfer-1' })
      if (path === '/api/store-transfers') return Promise.resolve([])
      return Promise.reject(new Error(`意外接口 ${String(path)}`))
    })
  })

  it('只展示服务端给出的同品牌目标，提交后进入供应链审核', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<ManagerTransfersPage />) })
    await waitFor(() => container.textContent?.includes('同品牌店') ?? false)

    const selects = container.querySelectorAll('select')
    expect(selects[1].textContent).toContain('同品牌店')
    expect(selects[1].textContent).not.toContain('其他品牌店')
    await act(async () => {
      selectValue(selects[1], 'sister')
      selectValue(selects[2], 'p1')
    })
    await act(async () => { (container.querySelector('button[type="submit"]') as HTMLButtonElement).click() })
    await waitFor(() => fetchMock.mock.calls.some(([path, init]) => path === '/api/store-transfers' && init?.method === 'POST'))
    const call = fetchMock.mock.calls.find(([path, init]) => path === '/api/store-transfers' && init?.method === 'POST')
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.fromStoreId).toBe('mine')
    expect(body.toStoreId).toBe('sister')
    expect(body.items).toEqual([{ productId: 'p1', quantity: 1, cost: 0, settlement: 0 }])
    expect(container.textContent).toContain('提交供应链审核')
    act(() => root.unmount())
    container.remove()
  })
})
