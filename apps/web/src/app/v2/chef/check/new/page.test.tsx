// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(() => Promise.resolve([])) }))

import ChefLossNewPage from './page'
import { apiFetch } from '@/lib/v2-auth'
import { Simulate } from 'react-dom/test-utils'

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('新增店内报损页内反馈', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('超大视频校验失败时显示并聚焦页内提示', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<ChefLossNewPage />))

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], '现场.mp4', { type: 'video/mp4' })
    Object.defineProperty(file, 'size', { value: 51 * 1024 * 1024 })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })

    await waitFor(() => Boolean(container.querySelector('[role="alert"]')))
    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain('超过 50MB')
    expect(document.activeElement).toBe(alert)
    act(() => root.unmount())
  })
})

it('searches added-product candidates by code and retains the chosen loss item after clearing search', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce([
    { id: 'a', code: 'VG001', name: '白菜', unit: 'kg', price: 3 },
    { id: 'b', code: 'VG002', name: '土豆', unit: 'kg', price: 4 },
  ])
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<ChefLossNewPage />))
  act(() => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('添加商品'))!.click())
  const query = container.querySelector('input[aria-label="搜索报损商品"]')!
  act(() => Simulate.change(query, { target: { value: 'VG002' } } as any))
  expect(container.querySelector('ul.overflow-y-auto')?.textContent).toContain('土豆')
  expect(container.querySelector('ul.overflow-y-auto')?.textContent).not.toContain('白菜')
  act(() => [...container.querySelectorAll('button')].find(b => b.textContent === '+ 加入')!.click())
  act(() => Simulate.change(query, { target: { value: '' } } as any))
  expect(container.querySelector('ul.overflow-y-auto')?.textContent).toContain('白菜')
  expect(container.querySelector('ul.overflow-y-auto')?.textContent).toContain('已选')
  expect(vi.mocked(apiFetch).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  act(() => root.unmount())
})
