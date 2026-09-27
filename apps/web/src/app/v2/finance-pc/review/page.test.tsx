// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FinancePCReviewPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({ Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('../_topnav', () => ({ default: () => <nav data-testid="finance-nav" /> }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const documentItem = {
  id: 'doc-1', no: 'FK-001', type: 'PAYMENT_REQUEST', title: '供应商货款', amount: 1200,
  status: 'PENDING', createdAt: '2026-09-28T08:00:00.000Z', initiator: { name: '张三' },
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<FinancePCReviewPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('财务初审确认交互', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/payment-requests?')) return Promise.resolve({ items: [documentItem], total: 1 })
      if (url === '/api/documents/doc-1/decisions' && init?.method === 'POST') return Promise.resolve({ ok: true })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('用带必填原因的 ConfirmSheet 驳回并保持决策请求', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('供应商货款') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '驳回')?.click())

    expect(container.textContent).toContain('驳回付款申请')
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认驳回') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    act(() => change(container.querySelector('textarea') as HTMLTextAreaElement, '金额有误'))
    await act(async () => { submit.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/decisions')))

    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/decisions'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: 'REJECT', comment: '金额有误' })

    act(() => root.unmount())
    container.remove()
  })

  it('批量通过先显示 ConfirmSheet，确认后才发请求', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('供应商货款') ?? false)
    const checkbox = container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement
    act(() => checkbox.click())
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.startsWith('批量通过'))?.click())

    expect(container.textContent).toContain('确认批量通过 1 单')
    expect(mockFetch.mock.calls.some(([path]) => String(path).endsWith('/decisions'))).toBe(false)
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认批量通过')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/decisions')))

    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/decisions'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ decision: 'APPROVE', comment: 'PC 批量初审通过' })

    act(() => root.unmount())
    container.remove()
  })

  it('批量通过部分失败时显示并聚焦页内错误', async () => {
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/payment-requests?')) return Promise.resolve({ items: [documentItem], total: 1 })
      if (url === '/api/documents/doc-1/decisions' && init?.method === 'POST') return Promise.reject(new Error('单据已被其他人处理'))
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('供应商货款') ?? false)
    act(() => (container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement).click())
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.startsWith('批量通过'))?.click())
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认批量通过')?.click() })
    await waitFor(() => Boolean(container.querySelector('[role="alert"]')))

    const alert = container.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain('单据已被其他人处理')
    expect(document.activeElement).toBe(alert)

    act(() => root.unmount())
    container.remove()
  })
})
