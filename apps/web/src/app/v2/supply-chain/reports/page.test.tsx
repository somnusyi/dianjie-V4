// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mock = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: mock.api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mock.push }), useSearchParams: () => new URLSearchParams({ report: 'stagnant' }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: any) => <a href={href}>{children}</a> }))

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement
const response = {
  id: 'stagnant', title: '库存呆滞品查询表', note: '按商品规则', columns: [], rows: [], total: 0, page: 1, pageSize: 20, warehouses: [],
}

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<Page />))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  mock.api.mockReset()
})

describe('库存呆滞品查询阈值', () => {
  it('显示统一30天且不能输入临时阈值，查询不携带覆盖参数', async () => {
    mock.api.mockResolvedValue(response)
    await render()
    expect(container.textContent).toContain('统一30天')
    expect(container.querySelector('input[type="number"]')).toBeNull()
    expect(mock.api.mock.calls[0][0]).not.toContain('stagnantDays=')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(mock.api.mock.calls.at(-1)?.[0]).not.toContain('stagnantDays=')
  })
})
