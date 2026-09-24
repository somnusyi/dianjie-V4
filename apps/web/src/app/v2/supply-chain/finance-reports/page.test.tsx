// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './page'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mock = vi.hoisted(() => ({ api: vi.fn(), report: 'group-profit', push: vi.fn() }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: mock.api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mock.push }), useSearchParams: () => new URLSearchParams({ report: mock.report }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: any) => <a href={href}>{children}</a> }))
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement
function render() { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); act(() => root!.render(<Page />)) }
const data = (customer: string) => ({ id: 'group-profit', columns: [{ key: 'customer', label: '客户名称' }], rows: [{ id: customer, customer, center: '仓库', profit: 10, revenue: 30, cost: 20 }], total: 1, page: 1, note: '业务口径', warnings: [], options: {} })
afterEach(() => { act(() => root?.unmount()); container?.remove(); mock.api.mockReset(); mock.report = 'group-profit' })
describe('financial reports API states', () => {
  it('shows access failure instead of displaying sample financial data', async () => {
    mock.api.mockRejectedValue(new Error('无权查看财务报表'))
    await act(async () => render())
    expect(container.textContent).toContain('无权查看财务报表')
    expect(container.textContent).not.toContain('示例门店')
    expect([...container.querySelectorAll('button')].find(b => b.textContent === '导出列表')?.disabled).toBe(true)
  })
  it('ignores a stale response after a new query completes', async () => {
    const pending: Array<(value: any) => void> = []
    mock.api.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    render()
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(pending.length).toBeGreaterThan(1)
    await act(async () => pending[pending.length - 1](data('最新客户')))
    await act(async () => { for (const resolve of pending.slice(0, -1)) resolve(data('旧客户')) })
    expect(container.querySelector('tbody')?.textContent).toContain('最新客户')
    expect(container.querySelector('tbody')?.textContent).not.toContain('旧客户')
    expect(mock.api.mock.calls.at(-1)?.[0]).toContain('/api/supply-chain/finance-reports/group-profit?')
  })
})
