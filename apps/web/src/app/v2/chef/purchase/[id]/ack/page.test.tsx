// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'
import ChefAckPage from './page'

const mockFetch = vi.mocked(apiFetch)

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('厨师长验收单页内反馈', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      if (String(path) === '/api/orders/order-1' && !init) return Promise.resolve({ id: 'order-1', no: 'PO-1', status: 'DELIVERING', totalAmount: 10, items: [], supplier: { name: '供应商' } })
      if (String(path).startsWith('/api/upload') && init?.method === 'POST') return Promise.reject(new Error('网络中断'))
      return Promise.reject(new Error(`unexpected API: ${String(path)}`))
    })
  })
  afterEach(() => { document.body.innerHTML = '' })

  it('上传失败时显示并聚焦页内提示', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<ChefAckPage params={{ id: 'order-1' }} />))
    await waitFor(() => Boolean(container.querySelector('input[type="file"]')))

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'ack.jpg', { type: 'image/jpeg' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })

    await waitFor(() => Boolean(container.querySelector('[role="alert"]')))
    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain('上传失败: 网络中断')
    expect(document.activeElement).toBe(alert)
    act(() => root.unmount())
  })

  it('发送成功后显示明确下一步并阻止重复发送', async () => {
    mockFetch.mockImplementation((path, init) => {
      if (String(path) === '/api/orders/order-1' && !init) return Promise.resolve({ id: 'order-1', no: 'PO-1', status: 'DELIVERING', totalAmount: 10, items: [], supplier: { name: '供应商' } })
      if (String(path).startsWith('/api/upload') && init?.method === 'POST') return Promise.resolve({ url: 'https://example.test/ack.jpg' })
      if (String(path) === '/api/orders/order-1/chef-ack' && init?.method === 'PATCH') return Promise.resolve({ success: true })
      return Promise.reject(new Error(`unexpected API: ${String(path)}`))
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(<ChefAckPage params={{ id: 'order-1' }} />))
    await waitFor(() => Boolean(container.querySelector('input[type="file"]')))

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'ack.jpg', { type: 'image/jpeg' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => Array.from(container.querySelectorAll('button')).some(button => button.textContent === '发给供应商' && !button.disabled))
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '发给供应商')
    await act(async () => { submit?.click() })

    await waitFor(() => Boolean(container.querySelector('[role="status"]')?.textContent?.includes('下一步')))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('返回采购列表')
    expect(Array.from(container.querySelectorAll('button')).find(button => button.textContent === '已发送')).toHaveProperty('disabled', true)
    act(() => root.unmount())
  })
})
